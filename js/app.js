/**
 * Application entry point: boot checks, auth-driven session lifecycle, peer
 * presence UI and mobile navigation. Feature logic lives in chat.js / calls.js.
 */
import { isConfigured, initAppCheck } from './firebase.js';
import { ALLOWED_UIDS, APP_VERSION } from './firebase-config.js';
import { initLoginForm, watchAuth, logout, getPeerUid } from './auth.js';
import {
  startPresence, stopPresence, watchUser, describePresence, updateDisplayName,
} from './presence.js';
import {
  initChat, destroyChat, setPeerMarkers, setPeerTyping, setSidebarTyping,
  onChatAttention, setChatShown, refreshRelativeLabels,
} from './chat.js';
import { initCalls, destroyCalls, isInCall, hangUp, refreshCallPeer } from './calls.js';
import { initSettings, applyTheme } from './settings.js';
import { initAudioUnlock, resetNotifications } from './notifications.js';
import { hasTurnConfigured } from './webrtc.js';
import {
  $, showScreen, setBootMessage, toast, confirmDialog, closeModal,
  paintAvatar, formatLastSeen, friendlyError,
} from './ui.js';

const PRESENCE_REFRESH_MS = 15_000;
const mobileQuery = window.matchMedia('(max-width: 820px)');

let session = null;   // { user, peerUid, myData, peerData, unsubs: [], timers: [] }
let globalBound = false;

const peerName = () => session?.peerData?.displayName || 'Your contact';
const myName = () => session?.myData?.displayName || session?.user?.email?.split('@')[0] || 'Me';

/* ---------- Boot ---------- */

async function main() {
  applyTheme();
  showScreen('boot');
  initAudioUnlock();

  if (!isConfigured() || ALLOWED_UIDS.length !== 2 || ALLOWED_UIDS.some((u) => u.startsWith('REPLACE_WITH'))) {
    document.querySelector('#boot-screen .spinner').hidden = true;
    setBootMessage('Setup required: add your Firebase config and the two authorized UIDs to js/firebase-config.js (see README).');
    return;
  }

  await initAppCheck();
  initLoginForm();
  bindGlobal();

  watchAuth(async (user) => {
    if (!user) {
      teardownSession();
      showScreen('login');
      return;
    }
    if (session?.user.uid === user.uid) return;
    await startSession(user);
  });
}

/* ---------- Session lifecycle ---------- */

async function startSession(user) {
  teardownSession();
  showScreen('boot');
  setBootMessage('Loading your conversation…');

  const peerUid = getPeerUid(user.uid);
  const s = { user, peerUid, myData: null, peerData: null, unsubs: [], timers: [] };
  session = s;

  let previous;
  try {
    previous = await startPresence(user);
  } catch (err) {
    if (session !== s) return;
    session = null;
    const msg = err?.code === 'permission-denied'
      ? 'Signed in, but the database denied access. Make sure both UIDs are in firestore.rules and the rules are published.'
      : friendlyError(err, 'Could not connect to the database.');
    await logout().catch(() => {});
    showScreen('login');
    const el = $('login-error');
    el.textContent = msg;
    el.hidden = false;
    return;
  }
  if (session !== s) return;

  s.myData = previous;
  s.unsubs.push(watchUser(user.uid, (data) => {
    s.myData = data;
    renderMe();
  }));
  s.unsubs.push(watchUser(peerUid, (data) => {
    s.peerData = data;
    renderPeer();
    setPeerMarkers({ lastReadAt: data?.lastReadAt, lastDeliveredAt: data?.lastDeliveredAt });
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
  });

  initChat({ myUid: user.uid, peerUid, getPeerName: peerName, myLastReadAt: previous?.lastReadAt?.toDate?.() || null });
  initCalls({ myUid: user.uid, peerUid, getPeerName: peerName, previousLastActive: previous?.lastActive || null });

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

async function handleLogout() {
  const ok = await confirmDialog({
    title: 'Log out?',
    text: isInCall() ? 'Your current call will end.' : 'You will need your password to sign in again.',
    okLabel: 'Log out',
  });
  if (!ok) return;
  if (isInCall()) hangUp();
  closeModal('settings-modal');
  // Mark offline while still authenticated; the rules reject writes after sign-out.
  await stopPresence();
  try {
    await logout();
    toast('Signed out.', { type: 'success' });
  } catch (err) {
    toast(friendlyError(err, 'Could not sign out.'), { type: 'error' });
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
