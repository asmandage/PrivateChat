/**
 * Application entry point: boot checks, auth-driven session lifecycle, single active
 * session, peer presence UI and mobile navigation. Feature logic lives in
 * chat.js / calls.js.
 */
import { isConfigured, initAppCheck } from './firebase.js';
import { ALLOWED_UIDS, APP_VERSION } from './firebase-config.js';
import {
  initLoginForm, watchAuth, logout, getPeerUid, showLoginError, wasSignedInHere,
} from './auth.js';
import {
  startPresence, stopPresence, watchUser, describePresence, updateDisplayName,
} from './presence.js';
import {
  initChat, destroyChat, setPeerMarkers, setPeerTyping, setSidebarTyping,
  onChatAttention, setChatShown, refreshRelativeLabels,
  setClearedAt, reloadChat, runDeletion, clearMessagesForMe, eraseMessagesForEveryone,
} from './chat.js';
import {
  initCalls, destroyCalls, isInCall, hangUp, refreshCallPeer, setCallsClearedAt, eraseCallHistory,
} from './calls.js';
import { initSettings, applyTheme, getPrefs } from './settings.js';
import { initAudioUnlock, resetNotifications, notifyPrivate } from './notifications.js';
import { hasTurnConfigured } from './webrtc.js';
import {
  getAuthTime, claimSession, watchSession, SessionSupersededError, SUPERSEDED_MESSAGE,
  startAliveMarker, stopAliveMarker, isStaleRestore, rememberSuperseded, takeSupersededNotice,
} from './session.js';
import { initPwa } from './pwa.js';
import { enablePush, disablePush, pushConfigured, isPushActive } from './push.js';
import { requestNotificationPermission } from './permissions.js';
import {
  $, showScreen, setBootMessage, toast, confirmDialog, choiceDialog, closeModal,
  paintAvatar, formatLastSeen, friendlyError,
} from './ui.js';

const PRESENCE_REFRESH_MS = 15_000;
const mobileQuery = window.matchMedia('(max-width: 820px)');

let session = null;   // { user, authTime, peerUid, myData, peerData, wipe, unsubs: [], timers: [] }
let globalBound = false;

const peerName = () => session?.peerData?.displayName || 'Your contact';
const myName = () => session?.myData?.displayName || session?.user?.email?.split('@')[0] || 'Me';
const toDate = (ts) => ts?.toDate?.() || null;

/* ---------- Boot ---------- */

async function main() {
  applyTheme();
  showScreen('boot');
  initAudioUnlock();
  initPwa();

  if (!isConfigured() || ALLOWED_UIDS.length !== 2 || ALLOWED_UIDS.some((u) => u.startsWith('REPLACE_WITH'))) {
    document.querySelector('#boot-screen .spinner').hidden = true;
    setBootMessage('Setup required: add your Firebase config and the two authorized UIDs to js/firebase-config.js (see README).');
    return;
  }

  const superseded = takeSupersededNotice();
  await initAppCheck();
  initLoginForm();
  bindGlobal();

  watchAuth(async (user) => {
    if (!user) {
      teardownSession();
      showScreen('login');
      if (superseded) showLoginError(SUPERSEDED_MESSAGE);
      return;
    }
    if (session?.user.uid === user.uid) return;
    // A sign-in the browser restored after being closed (not one made in this page and
    // not one in use a moment ago, e.g. a reload) requires the password again.
    if (!wasSignedInHere() && isStaleRestore()) {
      await logout().catch(() => {});
      return;
    }
    await startSession(user);
  });
}

/* ---------- Session lifecycle ---------- */

async function startSession(user) {
  teardownSession();
  showScreen('boot');
  setBootMessage('Loading your conversation…');

  const peerUid = getPeerUid(user.uid);
  const s = { user, authTime: 0, peerUid, myData: null, peerData: null, wipe: {}, unsubs: [], timers: [] };
  session = s;

  let previous;
  try {
    // Become the account's only active session BEFORE touching any data: the rules
    // reject every request from a sign-in that is not the recorded one.
    s.authTime = await getAuthTime(user);
    await claimSession(user.uid, s.authTime);
    if (session !== s) return;
    previous = await startPresence(user);
  } catch (err) {
    if (session !== s) return;
    if (err instanceof SessionSupersededError) { endSuperseded(s); return; }
    session = null;
    const msg = err?.code === 'permission-denied'
      ? 'Signed in, but the database denied access. Make sure both UIDs are in firestore.rules and the rules are published.'
      : friendlyError(err, 'Could not connect to the database.');
    await logout().catch(() => {});
    showScreen('login');
    showLoginError(msg);
    return;
  }
  if (session !== s) return;

  startAliveMarker();
  s.unsubs.push(watchSession(user.uid, s.authTime, () => endSuperseded(s)));

  s.myData = previous;
  s.unsubs.push(watchUser(user.uid, (data) => {
    s.myData = data;
    renderMe();
    // "Delete for me" markers may have been set here or by an earlier session.
    setClearedAt(toDate(data?.clearedAt));
    setCallsClearedAt(toDate(data?.callsClearedAt));
    noteWipe(s, 'me', data);
  }));
  s.unsubs.push(watchUser(peerUid, (data) => {
    s.peerData = data;
    renderPeer();
    setPeerMarkers({ lastReadAt: data?.lastReadAt, lastDeliveredAt: data?.lastDeliveredAt });
    noteWipe(s, 'peer', data);
  }, (err) => toast(friendlyError(err, 'Could not load contact status.'), { type: 'error' })));

  initSettings({
    onSaveDisplayName: async (name) => {
      try { await updateDisplayName(name); }
      catch (err) { toast(friendlyError(err, 'Could not save display name.'), { type: 'error' }); throw err; }
    },
    onLogout: handleLogout,
    getDisplayName: myName,
    // Settings UI is bound once per page load, so read the *current* session lazily.
    getEmail: () => session?.user.email || '',
    turnStatus: () => (hasTurnConfigured() ? 'Configured' : 'Not configured — STUN only (some networks will fail)'),
    version: APP_VERSION,
    onNotificationsToggle: handleNotificationsToggle,
    onTestNotification: () => notifyPrivate('m', { force: true }),
    onClearHistory: handleClearHistory,
    pushStatus,
  });

  initChat({
    myUid: user.uid, peerUid, getPeerName: peerName,
    myLastReadAt: toDate(previous?.lastReadAt), myClearedAt: toDate(previous?.clearedAt),
  });
  initCalls({
    myUid: user.uid, peerUid, getPeerName: peerName,
    previousLastActive: previous?.lastActive || null, myCallsClearedAt: toDate(previous?.callsClearedAt),
  });

  // Refresh this device's push registration under the new session (no prompt here).
  if (getPrefs().browserNotify) syncPush(s);

  // "online" ages out without any new snapshot, so re-evaluate periodically.
  s.timers.push(setInterval(renderPeer, PRESENCE_REFRESH_MS));
  s.timers.push(setInterval(refreshRelativeLabels, 60_000));

  renderMe();
  renderPeer();
  showScreen('app');
  if (mobileQuery.matches) showChat(false);
  else setChatShown(true);
}

function teardownSession() {
  if (!session) return;
  const s = session;
  session = null;
  s.unsubs.forEach((u) => { try { u(); } catch { /* ignore */ } });
  s.timers.forEach(clearInterval);
  destroyCalls();
  destroyChat();
  resetNotifications();
  closeModal('settings-modal');
}

/**
 * A newer sign-in on another device took over this account. The server already
 * refuses this session's requests; end any call, sign out and reload so no copy of
 * the conversation stays in memory, then show the notice on the login screen.
 */
async function endSuperseded(s) {
  if (session !== s) return;
  if (isInCall()) hangUp();
  teardownSession();
  stopAliveMarker();
  rememberSuperseded();
  await logout().catch(() => {});
  location.reload();
}

async function handleLogout() {
  const ok = await confirmDialog({
    title: 'Log out?',
    text: isInCall() ? 'Your current call will end.' : 'You will need your password to sign in again.',
    okLabel: 'Log out',
  });
  if (!ok) return;
  if (isInCall()) hangUp();
  closeModal('settings-modal');
  const uid = session?.user.uid;
  // While still authenticated (the rules reject writes after sign-out): stop push to
  // this device and mark offline.
  await disablePush(uid).catch(() => {});
  await stopPresence();
  stopAliveMarker();
  try {
    await logout();
    // Reload so nothing from the conversation stays in this page's memory.
    location.reload();
  } catch (err) {
    toast(friendlyError(err, 'Could not sign out.'), { type: 'error' });
  }
}

/* ---------- Notifications & push ---------- */

async function syncPush(s) {
  try {
    await enablePush(s.user.uid, s.authTime);
  } catch (err) {
    console.warn('Background push unavailable:', err?.code || err?.name || '');
  }
}

/** From the Settings switch. Returns whether private notifications are now on. */
async function handleNotificationsToggle(enable) {
  const s = session;
  if (!enable) {
    if (s) await disablePush(s.user.uid).catch(() => {});
    return false;
  }
  const result = await requestNotificationPermission();
  if (result !== 'granted') return false;
  if (s && pushConfigured()) {
    await syncPush(s);
    if (!isPushActive()) toast('Notifications are on, but background push could not be set up on this device. They will appear while the app is open.', { type: 'warning', duration: 7000 });
  }
  return true;
}

function pushStatus() {
  if (!getPrefs().browserNotify) return '';
  if (isPushActive()) return 'Background notifications are active on this device, also while the app is closed (where the OS allows).';
  if (!pushConfigured()) return 'Background push is not set up for this site, so notifications only appear while the app is open (e.g. in a background tab).';
  return 'Background push is not available in this browser; notifications appear while the app is open.';
}

/* ---------- History deletion ---------- */

/** A "delete for everyone" by either person: reload the conversation view. */
function noteWipe(s, who, data) {
  const t = data?.wipedAt?.toMillis?.() ?? 0;
  const prev = s.wipe[who];
  s.wipe[who] = t;
  if (prev !== undefined && t > prev) reloadChat();
}

async function handleClearHistory() {
  if (!session) return;
  const choice = await choiceDialog({
    title: 'Clear all chat history?',
    text: 'Delete for me: all messages and call history disappear from your view, on every device you sign in to. The other person keeps theirs.\n\nDelete for everyone: all messages and finished calls are permanently erased for both of you. This cannot be undone.',
    choices: [
      { value: 'me', label: 'Delete for me' },
      { value: 'everyone', label: 'Delete for everyone', danger: true },
    ],
  });
  if (choice === 'me') {
    await runDeletion(() => clearMessagesForMe(['callsClearedAt']), 'Chat history deleted for you.');
  } else if (choice === 'everyone') {
    await runDeletion(async () => {
      await eraseCallHistory();
      await eraseMessagesForEveryone();
    }, 'Chat history deleted for everyone.');
  }
}

/* ---------- Rendering ---------- */

function renderMe() {
  if (!session) return;
  $('me-name').textContent = myName();
  paintAvatar($('me-avatar'), myName(), session.user.uid);
}

function renderPeer() {
  if (!session) return;
  const name = peerName();
  const { online, typing, lastActive } = describePresence(session.peerData);

  for (const id of ['peer-name', 'contact-name']) $(id).textContent = name;
  for (const id of ['peer-avatar', 'contact-avatar']) paintAvatar($(id), name, session.peerUid);
  for (const id of ['peer-status-dot', 'contact-status-dot']) $(id).classList.toggle('online', online);

  const status = $('peer-status');
  status.classList.toggle('online', online && !typing);
  status.classList.toggle('typing', typing);
  status.textContent = typing ? 'typing…'
    : online ? 'online'
    : lastActive ? formatLastSeen(lastActive)
    : session.peerData ? 'offline' : 'has not signed in yet';
  status.title = 'Presence is based on a once-a-minute heartbeat, so “online” can lag by up to ~2 minutes after the other person leaves.';

  setPeerTyping(typing);
  setSidebarTyping(typing);
  refreshCallPeer();
}

/* ---------- Mobile navigation ---------- */

function showChat(pushHistory = true) {
  $('app-screen').classList.add('show-chat');
  $('contact-item').classList.add('active');
  setChatShown(true);
  if (pushHistory && mobileQuery.matches && !history.state?.chat) history.pushState({ chat: true }, '');
}

function showSidebar() {
  $('app-screen').classList.remove('show-chat');
  $('contact-item').classList.remove('active');
  setChatShown(!mobileQuery.matches);
}

function bindGlobal() {
  if (globalBound) return;
  globalBound = true;

  $('contact-item').addEventListener('click', () => {
    showChat();
    if (!mobileQuery.matches) $('message-input').focus();
  });
  $('back-to-sidebar').addEventListener('click', () => {
    if (history.state?.chat) history.back();
    else showSidebar();
  });
  window.addEventListener('popstate', () => {
    if (mobileQuery.matches && $('app-screen').classList.contains('show-chat')) showSidebar();
  });
  mobileQuery.addEventListener?.('change', (e) => {
    if (!e.matches) { $('app-screen').classList.add('show-chat'); setChatShown(true); }
  });

  const attention = () => onChatAttention();
  window.addEventListener('focus', attention);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') attention(); });

  const updateNetwork = () => {
    $('network-banner').hidden = navigator.onLine;
    if (!navigator.onLine && session) toast('You are offline.', { type: 'warning' });
  };
  window.addEventListener('online', () => { updateNetwork(); if (session) toast('Back online.', { type: 'success' }); });
  window.addEventListener('offline', updateNetwork);
  updateNetwork();
}

main().catch((err) => {
  console.error('Startup failed', err?.message || err);
  document.querySelector('#boot-screen .spinner').hidden = true;
  setBootMessage('PrivateChat failed to start. Check your connection and reload the page.');
  showScreen('boot');
});
