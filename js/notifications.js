/**
 * Sounds (generated with the Web Audio API — no audio files), private notifications,
 * unread counter and document-title updates.
 *
 * Browsers block audio until the user has interacted with the page, so the
 * AudioContext is created/resumed on the first pointer or key event.
 *
 * Notifications are PRIVATE: they only ever show the coded title/text configured in
 * Settings (notify-config.js) — never a name, message text or call details — and
 * tapping one just dismisses it (sw.js).
 */
import { getPrefs } from './settings.js';
import { getNotifyConfig, renderNotification, NOTIFY_TAGS } from './notify-config.js';
import { getServiceWorker } from './pwa.js';
import { isPushActive } from './push.js';

const BASE_TITLE = 'My Offers';
const ICON = 'assets/icons/icon-192.png';
const BADGE = 'assets/icons/badge-96.png';
let audioCtx = null;
let ringTimer = null;
let ringMode = null;   // 'incoming' | 'outgoing' | null
let unreadCount = 0;

/* ---------- Audio unlock ---------- */
function ensureAudioContext() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    audioCtx = new Ctx();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  return audioCtx;
}

export function initAudioUnlock() {
  const unlock = () => {
    ensureAudioContext();
    if (audioCtx?.state === 'running') {
      window.removeEventListener('pointerdown', unlock, true);
      window.removeEventListener('keydown', unlock, true);
    }
  };
  window.addEventListener('pointerdown', unlock, true);
  window.addEventListener('keydown', unlock, true);
}

/** Plays a sequence of [frequencyHz, durationSec, gapSec] tones. */
function playTones(seq, { volume = 0.12, type = 'sine' } = {}) {
  const ctx = ensureAudioContext();
  if (!ctx || ctx.state !== 'running') return;
  let t = ctx.currentTime + 0.02;
  for (const [freq, dur, gap = 0] of seq) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(volume, t + 0.02);
    gain.gain.setValueAtTime(volume, t + dur - 0.04);
    gain.gain.linearRampToValueAtTime(0, t + dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + dur + 0.02);
    t += dur + gap;
  }
}

export function playMessageSound() {
  if (!getPrefs().messageSound) return;
  playTones([[880, 0.09, 0.03], [1320, 0.12]], { volume: 0.07 });
}

export function playEndSound() {
  playTones([[620, 0.14, 0.05], [460, 0.2]], { volume: 0.08 });
}

/** Original two-note ringtone (incoming) or soft ringback (outgoing), repeated until stopped. */
export function startRinging(mode) {
  stopRinging();
  if (mode === 'incoming' && !getPrefs().ringtone) {
    if (navigator.vibrate) navigator.vibrate([400, 200, 400]);
    return;
  }
  ringMode = mode;
  const ring = () => {
    if (mode === 'incoming') {
      playTones([[784, 0.18, 0.05], [988, 0.18, 0.05], [784, 0.18, 0.05], [988, 0.3]], { volume: 0.14, type: 'triangle' });
      if (navigator.vibrate && document.visibilityState === 'visible') navigator.vibrate([300, 150, 300]);
    } else {
      playTones([[440, 0.4, 0.2], [440, 0.4]], { volume: 0.05 });
    }
  };
  ring();
  ringTimer = setInterval(ring, mode === 'incoming' ? 2200 : 3000);
}

export function stopRinging() {
  if (ringTimer) clearInterval(ringTimer);
  ringTimer = null;
  ringMode = null;
  if (navigator.vibrate) navigator.vibrate(0);
}

export const isRinging = () => ringMode !== null;

/* ---------- Private notifications ---------- */
export function canNotify() {
  return 'Notification' in window && Notification.permission === 'granted' && getPrefs().browserNotify;
}

/**
 * Shows the coded notification for an event kind ('m' | 'a' | 'v' | 'mc') while the
 * page is open but not on screen. When background push is active on this device the
 * service worker shows it instead (also when the app is closed), so it is not shown
 * twice. `force` is used by "Send test notification".
 */
export async function notifyPrivate(kind, { force = false } = {}) {
  if (!canNotify()) return false;
  if (!force && (document.visibilityState === 'visible' || isPushActive())) return false;
  const cfg = await getNotifyConfig();
  const { title, body } = renderNotification(cfg, kind);
  // renotify: a newer event replacing an older notification still alerts.
  const options = { body, tag: NOTIFY_TAGS[kind], renotify: true, icon: ICON, badge: BADGE, silent: cfg.silent };
  try {
    const reg = await getServiceWorker();
    if (reg) {
      await reg.showNotification(title, options);
      if (kind === 'mc') closeNotification('a');   // the call is over
    } else {
      new Notification(title, options);   // desktop browsers without a service worker
    }
    return true;
  } catch {
    return false;
  }
}

/** Closes the notification for an event kind (calls share one tag). */
export async function closeNotification(kind) {
  const tag = NOTIFY_TAGS[kind];
  const reg = await getServiceWorker().catch(() => null);
  const list = await reg?.getNotifications?.({ tag }).catch(() => []);
  list?.forEach((n) => n.close());
}

/* ---------- Unread counter ---------- */
export function setUnread(count) {
  unreadCount = Math.max(0, count);
  const badge = document.getElementById('unread-badge');
  badge.hidden = unreadCount === 0;
  badge.textContent = unreadCount > 99 ? '99+' : String(unreadCount);
  updateTitle();
  if ('setAppBadge' in navigator) {
    (unreadCount ? navigator.setAppBadge(unreadCount) : navigator.clearAppBadge()).catch(() => {});
  }
}

let titleOverride = '';
export function setTitleOverride(text) {
  titleOverride = text;
  updateTitle();
}

function updateTitle() {
  if (titleOverride) document.title = `${titleOverride} · ${BASE_TITLE}`;
  else document.title = unreadCount ? `(${unreadCount}) ${BASE_TITLE}` : BASE_TITLE;
}

export function resetNotifications() {
  stopRinging();
  closeNotification('m');
  closeNotification('a');
  closeNotification('mc');
  titleOverride = '';
  setUnread(0);
}
