/**
 * WebRTC primitives: media capture, ICE server resolution and a PeerSession wrapper
 * around RTCPeerConnection. Signalling transport (Firestore) lives in calls.js.
 *
 * Flow (caller ⇄ callee):
 *   caller: getUserMedia → addTrack → createOffer → setLocalDescription → [offer via Firestore]
 *   callee: setRemoteDescription(offer) → createAnswer → setLocalDescription → [answer via Firestore]
 *   caller: setRemoteDescription(answer)
 *   both:   trickle ICE candidates through Firestore as they are discovered
 *
 * A small RTCDataChannel carries in-call UI signals (camera on/off, mic muted, hang-up)
 * directly peer-to-peer, so they cost no Firestore writes.
 */
import { ICE_SERVERS, TURN_CREDENTIALS_URL, ICE_TRANSPORT_POLICY } from './firebase-config.js';
import { getPrefs } from './settings.js';

/** Returns a user-facing reason why calling cannot work here, or null. */
export function callSupportError() {
  if (!window.isSecureContext) return 'Calls need HTTPS. Open the site via its https:// address.';
  if (!navigator.mediaDevices?.getUserMedia) return 'This browser does not support camera/microphone access.';
  if (typeof RTCPeerConnection === 'undefined') return 'This browser does not support WebRTC calls.';
  return null;
}

/** Error with a friendly message for media failures. */
export class MediaAccessError extends Error {
  constructor(message, name) {
    super(message);
    this.name = 'MediaAccessError';
    this.cause = name;
  }
}

function describeMediaError(err, type) {
  const what = type === 'video' ? 'camera and microphone' : 'microphone';
  switch (err?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return `Permission to use the ${what} was denied. Allow it in your browser’s site settings and try again.`;
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return type === 'video' ? 'No camera or microphone was found on this device.' : 'No microphone was found on this device.';
    case 'NotReadableError':
    case 'TrackStartError':
      return `Your ${what} is being used by another application or tab.`;
    case 'OverconstrainedError':
      return 'The selected device is unavailable. Choose another one in Settings.';
    case 'AbortError':
      return `The ${what} could not be started.`;
    default:
      return `Could not access the ${what}.`;
  }
}

function audioConstraints(deviceId) {
  return {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
  };
}

function videoConstraints({ deviceId, facingMode } = {}) {
  return {
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 30, max: 30 },
    ...(deviceId ? { deviceId: { exact: deviceId } } : facingMode ? { facingMode } : { facingMode: 'user' }),
  };
}

/**
 * Captures microphone (+ camera for video calls). A saved device that no longer
 * exists falls back to the system default instead of failing the call.
 */
export async function getLocalMedia(type) {
  const { micId, cameraId } = getPrefs();
  const attempt = (useSaved) => navigator.mediaDevices.getUserMedia({
    audio: audioConstraints(useSaved ? micId : ''),
    video: type === 'video' ? videoConstraints({ deviceId: useSaved ? cameraId : '' }) : false,
  });
  try {
    return await attempt(true);
  } catch (err) {
    if ((micId || cameraId) && (err?.name === 'OverconstrainedError' || err?.name === 'NotFoundError')) {
      try { return await attempt(false); } catch (err2) { throw new MediaAccessError(describeMediaError(err2, type), err2?.name); }
    }
    throw new MediaAccessError(describeMediaError(err, type), err?.name);
  }
}

/** STUN/TURN list: static config plus optional short-lived TURN credentials. */
export async function getIceServers() {
  const servers = [...ICE_SERVERS];
  if (!TURN_CREDENTIALS_URL) return servers;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(TURN_CREDENTIALS_URL, { signal: controller.signal, credentials: 'omit' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    const list = Array.isArray(body) ? body : body?.iceServers;
    if (Array.isArray(list)) servers.push(...list.filter((s) => s && s.urls));
  } catch (err) {
    console.warn('TURN credentials unavailable; continuing with STUN only.', err?.message || '');
  } finally {
    clearTimeout(timer);
  }
  return servers;
}

export function hasTurnConfigured() {
  const hasStaticTurn = ICE_SERVERS.some((s) => [].concat(s.urls).some((u) => /^turns?:/.test(u)));
  return hasStaticTurn || !!TURN_CREDENTIALS_URL;
}

export class PeerSession {
  /**
   * @param {object} opts
   * @param {RTCIceServer[]} opts.iceServers
   * @param {MediaStream} opts.localStream
   * @param {boolean} opts.isCaller     caller creates the data channel
   * @param {(stream: MediaStream) => void} opts.onRemoteStream
   * @param {(state: string) => void} opts.onStateChange  connecting|connected|disconnected|failed|closed
   * @param {(candidate: object) => void} opts.onLocalCandidate
   * @param {(msg: object) => void} opts.onControlMessage
   */
  constructor({ iceServers, localStream, isCaller, onRemoteStream, onStateChange, onLocalCandidate, onControlMessage }) {
    this.localStream = localStream;
    this.remoteStream = new MediaStream();
    this.closed = false;
    this.remoteDescriptionSet = false;
    this.pendingRemoteCandidates = [];
    this.onControlMessage = onControlMessage;
    this.lastState = 'new';

    this.pc = new RTCPeerConnection({
      iceServers,
      iceTransportPolicy: ICE_TRANSPORT_POLICY === 'relay' ? 'relay' : 'all',
      iceCandidatePoolSize: 2,
    });

    for (const track of localStream.getTracks()) this.pc.addTrack(track, localStream);

    this.pc.onicecandidate = (e) => {
      // A null candidate means gathering finished; nothing to send.
      if (e.candidate && e.candidate.candidate) onLocalCandidate(e.candidate.toJSON());
    };

    this.pc.ontrack = (e) => {
      const tracks = e.streams?.[0]?.getTracks() || [e.track];
      for (const t of tracks) {
        if (!this.remoteStream.getTracks().includes(t)) this.remoteStream.addTrack(t);
      }
      onRemoteStream(this.remoteStream);
    };

    // connectionState is the aggregate of ICE + DTLS; older Safari/Firefox only have iceConnectionState.
    const emit = () => {
      if (this.closed) return;
      const raw = 'connectionState' in this.pc ? this.pc.connectionState : this.pc.iceConnectionState;
      const state = { new: 'connecting', checking: 'connecting', completed: 'connected' }[raw] || raw;
      if (state !== this.lastState) {
        this.lastState = state;
        onStateChange(state);
      }
    };
    if ('connectionState' in this.pc) this.pc.onconnectionstatechange = emit;
    else this.pc.oniceconnectionstatechange = emit;

    if (isCaller) this.setupChannel(this.pc.createDataChannel('control', { ordered: true }));
    else this.pc.ondatachannel = (e) => this.setupChannel(e.channel);
  }

  setupChannel(channel) {
    this.channel = channel;
    channel.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg && typeof msg.type === 'string') this.onControlMessage?.(msg);
      } catch { /* ignore malformed */ }
    };
    channel.onopen = () => this.onControlMessage?.({ type: 'channel-open' });
  }

  sendControl(msg) {
    if (this.channel?.readyState === 'open') {
      try { this.channel.send(JSON.stringify(msg)); } catch { /* channel closing */ }
    }
  }

  async createOffer() {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    return { type: offer.type, sdp: offer.sdp };
  }

  async acceptOffer(offer) {
    await this.pc.setRemoteDescription(new RTCSessionDescription(offer));
    this.remoteDescriptionSet = true;
    await this.flushRemoteCandidates();
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    return { type: answer.type, sdp: answer.sdp };
  }

  async applyAnswer(answer) {
    if (this.remoteDescriptionSet || this.pc.signalingState !== 'have-local-offer') return;
    await this.pc.setRemoteDescription(new RTCSessionDescription(answer));
    this.remoteDescriptionSet = true;
    await this.flushRemoteCandidates();
  }

  /**
   * ICE restart after a network change (Wi-Fi ↔ mobile data, short outage). The caller
   * creates an offer with fresh ICE credentials; the callee answers it; media keeps
   * flowing on the same connection once a new path is found. Returns null if the
   * connection is mid-negotiation.
   */
  async createRestartOffer() {
    if (this.closed || this.pc.signalingState !== 'stable') return null;
    const offer = await this.pc.createOffer({ iceRestart: true });
    await this.pc.setLocalDescription(offer);
    return { type: offer.type, sdp: offer.sdp };
  }

  async acceptRestartOffer(offer) {
    await this.pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    return { type: answer.type, sdp: answer.sdp };
  }

  async applyRestartAnswer(answer) {
    if (this.closed || this.pc.signalingState !== 'have-local-offer') return;
    await this.pc.setRemoteDescription(new RTCSessionDescription(answer));
  }

  /** Candidates can arrive before the remote description; queue them until then. */
  async addRemoteCandidate(data) {
    if (this.closed) return;
    if (!this.remoteDescriptionSet) {
      this.pendingRemoteCandidates.push(data);
      return;
    }
    try {
      await this.pc.addIceCandidate(new RTCIceCandidate(data));
    } catch (err) {
      console.debug('Ignoring bad ICE candidate', err?.name);
    }
  }

  async flushRemoteCandidates() {
    const queued = this.pendingRemoteCandidates.splice(0);
    for (const c of queued) await this.addRemoteCandidate(c);
  }

  setMicEnabled(enabled) {
    this.localStream.getAudioTracks().forEach((t) => { t.enabled = enabled; });
    this.sendControl({ type: 'mic', enabled });
  }

  setCameraEnabled(enabled) {
    this.localStream.getVideoTracks().forEach((t) => { t.enabled = enabled; });
    this.sendControl({ type: 'camera', enabled });
  }

  /**
   * Moves to the next camera without renegotiation (RTCRtpSender.replaceTrack).
   * The old track is stopped first because many phones cannot open two cameras at once.
   * Returns the new track's facing mode ('user' | 'environment' | '').
   */
  async switchCamera() {
    const oldTrack = this.localStream.getVideoTracks()[0];
    if (!oldTrack) return '';
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    if (devices.length < 2) throw new Error('Only one camera available.');

    const settings = oldTrack.getSettings?.() || {};
    const currentIndex = devices.findIndex((d) => d.deviceId === settings.deviceId);
    const next = devices[(currentIndex + 1) % devices.length];
    const wasEnabled = oldTrack.enabled;

    oldTrack.stop();
    let newStream;
    try {
      newStream = await navigator.mediaDevices.getUserMedia({
        video: next?.deviceId ? videoConstraints({ deviceId: next.deviceId })
          : videoConstraints({ facingMode: settings.facingMode === 'environment' ? 'user' : 'environment' }),
      });
    } catch (err) {
      // Try to restore the previous camera so the call keeps video.
      newStream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints({ deviceId: settings.deviceId }) });
    }
    const newTrack = newStream.getVideoTracks()[0];
    newTrack.enabled = wasEnabled;

    const sender = this.pc.getSenders().find((s) => s.track === oldTrack || s.track?.kind === 'video');
    await sender?.replaceTrack(newTrack);
    this.localStream.removeTrack(oldTrack);
    this.localStream.addTrack(newTrack);
    return newTrack.getSettings?.().facingMode || '';
  }

  /** Releases everything: peer connection, local devices (camera light turns off) and remote tracks. */
  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.channel?.close(); } catch { /* already closed */ }
    this.pc.onicecandidate = null;
    this.pc.ontrack = null;
    this.pc.onconnectionstatechange = null;
    this.pc.oniceconnectionstatechange = null;
    this.pc.ondatachannel = null;
    try { this.pc.close(); } catch { /* already closed */ }
    this.localStream.getTracks().forEach((t) => t.stop());
    this.remoteStream.getTracks().forEach((t) => t.stop());
  }
}
