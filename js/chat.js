/**
 * Real-time messaging.
 *
 *  - One live listener on the newest PAGE_SIZE messages (bounded; never "all messages").
 *  - Older history is fetched on demand with cursor pagination (getDocs, not a listener).
 *  - Message ids are generated client-side and written with setDoc; the rules only
 *    allow *create*, so a retried/duplicated send can never produce a second copy.
 *  - Messages are immutable except "delete for everyone", which blanks the text.
 *  - Read/delivered ticks come from the peer's lastReadAt / lastDeliveredAt markers,
 *    so receipts cost no extra writes per message.
 */
import {
  collection,
  doc,
  setDoc,
  updateDoc,
  query,
  orderBy,
  limit,
  startAfter,
  getDocs,
  onSnapshot,
  serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { db } from './firebase.js';
import { CONVERSATION_ID } from './firebase-config.js';
import {
  $, icon, toast, confirmDialog, friendlyError,
  formatTime, formatDayLabel, formatListTime, dayKey,
} from './ui.js';
import { notifyTyping, stopTyping, markRead, markDelivered, serverNow } from './presence.js';
import { playMessageSound, notify, setUnread, closeNotification } from './notifications.js';
import { getPrefs } from './settings.js';

const PAGE_SIZE = 30;
export const MAX_MESSAGE_LENGTH = 4000;
const COLLAPSE_CHARS = 1200;
const COLLAPSE_LINES = 25;
const GROUP_WINDOW_MS = 5 * 60_000;

const messagesCol = () => collection(db, 'conversations', CONVERSATION_ID, 'messages');

let ctx = null;              // { myUid, peerUid, getPeerName }
let unsubLive = null;
let messages = new Map();    // id -> { id, senderId, text, deleted, createdAt: Date, pending, failed }
let nodes = new Map();       // id -> <li>
let daySeps = new Map();     // dayKey -> <li>
let oldestCursor = null;     // DocumentSnapshot of the oldest message loaded
let hasMore = false;
let loadingOlder = false;
let initialLoaded = false;
let serverSeen = false;
let peerLastRead = null;
let peerLastDelivered = null;
let myLastRead = null;
let deliveredUpTo = null;
let newBelowCount = 0;
let chatShown = true;
let uiBound = false;
let olderObserver = null;
let generation = 0;          // invalidates async work from a previous session

/* ======================================================================
   Lifecycle
   ====================================================================== */

export function initChat({ myUid, peerUid, getPeerName, myLastReadAt }) {
  destroyChat();
  generation++;
  ctx = { myUid, peerUid, getPeerName };
  myLastRead = myLastReadAt || null;
  bindUi();
  showState('loading');
  subscribeLive();
}

export function destroyChat() {
  unsubLive?.();
  unsubLive = null;
  olderObserver?.disconnect();
  olderObserver = null;
  messages = new Map();
  nodes = new Map();
  daySeps = new Map();
  oldestCursor = null;
  hasMore = false;
  loadingOlder = false;
  initialLoaded = false;
  serverSeen = false;
  peerLastRead = null;
  peerLastDelivered = null;
  deliveredUpTo = null;
  newBelowCount = 0;
  ctx = null;
  $('message-list').replaceChildren();
  $('message-input').value = '';
  $('typing-indicator').hidden = true;
  $('scroll-bottom').hidden = true;
  setUnread(0);
}

function subscribeLive() {
  const gen = generation;
  const q = query(messagesCol(), orderBy('createdAt', 'desc'), limit(PAGE_SIZE));
  unsubLive = onSnapshot(q, { includeMetadataChanges: true }, (snap) => {
    if (gen !== generation) return;
    const wasNearBottom = isNearBottom();
    let incoming = [];
    let ownAdded = false;

    for (const change of snap.docChanges({ includeMetadataChanges: true })) {
      // 'removed' only happens when a message slides out of the live window
      // (deletes are forbidden by the rules), so we keep it in memory.
      if (change.type === 'removed') continue;
      const msg = toMessage(change.doc);
      const existed = messages.has(msg.id);
      messages.set(msg.id, msg);
      if (!existed && change.type === 'added') {
        if (msg.senderId === ctx.myUid) ownAdded = true;
        else incoming.push(msg);
      }
    }

    // Pagination cursor: the oldest *server-confirmed* message in the window.
    const lastDoc = snap.docs[snap.docs.length - 1];
    if (lastDoc && !lastDoc.metadata.hasPendingWrites && (!oldestCursor || isOlder(lastDoc, oldestCursor))) {
      oldestCursor = lastDoc;
    }
    // Decide "has older messages" from the first snapshot, and re-decide once when
    // the first server-confirmed snapshot replaces a possibly partial cache snapshot.
    if (!initialLoaded || (!snap.metadata.fromCache && !serverSeen)) hasMore = snap.size >= PAGE_SIZE;
    if (!snap.metadata.fromCache) serverSeen = true;

    // Messages the user already read (e.g. delivered via cache → server sync) are not "new".
    incoming = incoming.filter((m) => !myLastRead || m.createdAt > myLastRead);

    const firstRender = !initialLoaded;
    initialLoaded = true;
    render();
    showState(messages.size ? 'list' : 'empty');

    if (firstRender) {
      scrollToBottom();
      observeOlder();
      incoming = [];
    } else if (ownAdded || wasNearBottom) {
      scrollToBottom();
    }

    if (incoming.length) handleIncoming(incoming, wasNearBottom);
    else if (firstRender) refreshUnreadAndReceipts();
    updateSidebarPreview();
  }, (err) => {
    if (gen !== generation) return;
    console.error('Message listener error:', err?.code);
    showState('error', friendlyError(err, 'Could not load messages.'));
  });
}

function toMessage(docSnap) {
  const data = docSnap.data({ serverTimestamps: 'estimate' });
  const prev = messages.get(docSnap.id);
  return {
    id: docSnap.id,
    senderId: data.senderId,
    text: typeof data.text === 'string' ? data.text : '',
    deleted: data.deleted === true,
    createdAt: data.createdAt?.toDate?.() || prev?.createdAt || new Date(),
    pending: docSnap.metadata.hasPendingWrites,
    failed: false,
  };
}

function isOlder(a, b) {
  const ta = a.get('createdAt')?.toMillis?.() ?? Infinity;
  const tb = b.get('createdAt')?.toMillis?.() ?? Infinity;
  return ta < tb;
}

/* ======================================================================
   Incoming messages, unread counter, receipts
   ====================================================================== */

function isChatActive() {
  return chatShown && document.visibilityState === 'visible' && document.hasFocus();
}

function handleIncoming(incoming, wasNearBottom) {
  if (isChatActive()) {
    markReadNow();
    if (!wasNearBottom) bumpNewBelow(incoming.length);
    playMessageSound();
  } else {
    playMessageSound();
    const latest = incoming[incoming.length - 1];
    const name = ctx.getPeerName();
    const body = latest.deleted ? 'Message deleted' : getPrefs().notifyPreview ? latest.text.slice(0, 140) : 'New message';
    notify('message', name, body);
    if (document.visibilityState === 'visible' && !chatShown) toast(`New message from ${name}`);
    if (!wasNearBottom) bumpNewBelow(incoming.length);
  }
  refreshUnreadAndReceipts();
}

function markReadNow() {
  myLastRead = new Date(serverNow());
  markRead();
  closeNotification('message');
}

function refreshUnreadAndReceipts() {
  if (!ctx) return;
  const peerMessages = [...messages.values()].filter((m) => m.senderId === ctx.peerUid);
  // Only write a delivery receipt when a newer peer message has actually arrived.
  const newest = peerMessages.reduce((max, m) => (!max || m.createdAt > max ? m.createdAt : max), null);
  if (newest && (!deliveredUpTo || newest > deliveredUpTo)) {
    deliveredUpTo = newest;
    markDelivered();
  }
  if (isChatActive() && peerMessages.some((m) => !myLastRead || m.createdAt > myLastRead)) markReadNow();
  const unread = peerMessages.filter((m) => !m.deleted && (!myLastRead || m.createdAt > myLastRead)).length;
  setUnread(unread);
}

/** Called by app.js whenever the window regains focus/visibility or the chat pane is shown. */
export function onChatAttention() {
  if (!ctx || !initialLoaded) return;
  refreshUnreadAndReceipts();
}

export function setChatShown(shown) {
  chatShown = shown;
  if (shown) {
    onChatAttention();
    requestAnimationFrame(() => { if (isNearBottom(300)) scrollToBottom(); });
  }
}

/** Peer's user document changed: update ticks and typing indicator. */
export function setPeerMarkers({ lastReadAt, lastDeliveredAt }) {
  const r = lastReadAt?.toDate?.() || null;
  const d = lastDeliveredAt?.toDate?.() || null;
  const changed = r?.getTime() !== peerLastRead?.getTime() || d?.getTime() !== peerLastDelivered?.getTime();
  peerLastRead = r;
  peerLastDelivered = d;
  if (changed) {
    for (const msg of messages.values()) if (msg.senderId === ctx?.myUid) updateNode(msg);
  }
}

export function setPeerTyping(typing) {
  const el = $('typing-indicator');
  if (el.hidden === !typing) return;
  const nearBottom = isNearBottom();
  el.hidden = !typing;
  if (typing && nearBottom) scrollToBottom();
}

/* ======================================================================
   Rendering
   ====================================================================== */

function sortedMessages() {
  return [...messages.values()].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
}

function render() {
  const list = $('message-list');
  const desired = [];
  let prev = null;
  const usedDays = new Set();

  for (const msg of sortedMessages()) {
    const key = dayKey(msg.createdAt);
    if (!prev || dayKey(prev.createdAt) !== key) {
      desired.push(getDaySep(key, msg.createdAt));
      usedDays.add(key);
    }
    const groupStart = !prev || prev.senderId !== msg.senderId
      || dayKey(prev.createdAt) !== key || msg.createdAt - prev.createdAt > GROUP_WINDOW_MS;
    const li = getNode(msg);
    li.classList.toggle('group-start', groupStart);
    desired.push(li);
    prev = msg;
  }

  // Minimal-move reconciliation: only new or reordered nodes are (re)inserted, so
  // existing bubbles keep their state and do not replay their entry animation.
  let cursor = list.firstChild;
  for (const node of desired) {
    if (node === cursor) cursor = cursor.nextSibling;
    else list.insertBefore(node, cursor);
  }
  while (cursor) {
    const next = cursor.nextSibling;
    cursor.remove();
    cursor = next;
  }
  for (const key of [...daySeps.keys()]) if (!usedDays.has(key)) daySeps.delete(key);
}

function getDaySep(key, date) {
  let el = daySeps.get(key);
  if (!el) {
    el = document.createElement('li');
    el.className = 'day-sep';
    const span = document.createElement('span');
    el.append(span);
    daySeps.set(key, el);
  }
  el.firstChild.textContent = formatDayLabel(date);
  return el;
}

function getNode(msg) {
  let li = nodes.get(msg.id);
  if (!li) {
    li = buildNode(msg);
    nodes.set(msg.id, li);
  }
  updateNode(msg, li);
  return li;
}

function buildNode(msg) {
  const mine = msg.senderId === ctx.myUid;
  const li = document.createElement('li');
  li.className = `msg ${mine ? 'out' : 'in'}`;
  li.dataset.id = msg.id;

  const bubble = document.createElement('div');
  bubble.className = 'bubble';

  const text = document.createElement('p');
  text.className = 'msg-text';

  const meta = document.createElement('span');
  meta.className = 'msg-meta';
  const time = document.createElement('time');
  meta.append(time);

  bubble.append(text, meta);

  if (mine) {
    const status = document.createElement('span');
    status.className = 'msg-status';
    meta.append(status);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'icon-btn small msg-delete';
    del.setAttribute('aria-label', 'Delete message for everyone');
    del.title = 'Delete for everyone';
    del.append(icon('i-trash'));
    del.addEventListener('click', (e) => { e.stopPropagation(); deleteMessage(msg.id); });
    bubble.append(del);
    bubble.addEventListener('click', () => onOwnBubbleClick(msg.id, li));
  }
  li.append(bubble);
  return li;
}

function updateNode(msg, li = nodes.get(msg.id)) {
  if (!li) return;
  const mine = msg.senderId === ctx.myUid;
  const textEl = li.querySelector('.msg-text');
  const renderKey = `${msg.deleted}|${msg.text.length}`;

  if (textEl.dataset.key !== renderKey) {
    textEl.dataset.key = renderKey;
    li.querySelector('.msg-more')?.remove();
    li.classList.toggle('deleted', msg.deleted);
    textEl.classList.remove('collapsed');
    if (msg.deleted) {
      textEl.textContent = mine ? 'You deleted this message' : 'This message was deleted';
    } else {
      textEl.textContent = msg.text;   // textContent: never interpreted as HTML
      const long = msg.text.length > COLLAPSE_CHARS || msg.text.split('\n').length > COLLAPSE_LINES;
      if (long) {
        textEl.classList.add('collapsed');
        const more = document.createElement('button');
        more.type = 'button';
        more.className = 'msg-more';
        more.textContent = 'Show more';
        more.addEventListener('click', (e) => {
          e.stopPropagation();
          const collapsed = textEl.classList.toggle('collapsed');
          more.textContent = collapsed ? 'Show more' : 'Show less';
        });
        textEl.after(more);
      }
    }
  }

  const time = li.querySelector('time');
  time.dateTime = msg.createdAt.toISOString();
  time.textContent = formatTime(msg.createdAt);
  time.title = msg.createdAt.toLocaleString();

  if (mine) {
    const status = li.querySelector('.msg-status');
    const state = messageStatus(msg);
    if (status.dataset.state !== state) {
      status.dataset.state = state;
      status.className = `msg-status ${state}`;
      const iconId = { pending: 'i-clock', sent: 'i-check', failed: 'i-alert' }[state] || 'i-check-double';
      status.replaceChildren(icon(iconId));
      status.setAttribute('aria-label', { pending: 'Sending', sent: 'Sent', delivered: 'Delivered', read: 'Read', failed: 'Not sent — tap to retry' }[state]);
      status.title = status.getAttribute('aria-label');
    }
    li.classList.toggle('failed', msg.failed);
    li.querySelector('.msg-delete').hidden = msg.deleted || msg.pending || msg.failed;
  }
}

function messageStatus(msg) {
  if (msg.failed) return 'failed';
  if (msg.pending) return 'pending';
  if (peerLastRead && peerLastRead >= msg.createdAt) return 'read';
  if (peerLastDelivered && peerLastDelivered >= msg.createdAt) return 'delivered';
  return 'sent';
}

function updateSidebarPreview() {
  const ordered = sortedMessages();
  const last = ordered[ordered.length - 1];
  const preview = $('contact-preview');
  if (preview.classList.contains('typing')) return;
  if (!last) {
    preview.textContent = 'No messages yet';
    $('contact-time').textContent = '';
    return;
  }
  const prefix = last.senderId === ctx.myUid ? 'You: ' : '';
  preview.textContent = prefix + (last.deleted ? 'Message deleted' : last.text.replace(/\s+/g, ' ').slice(0, 80));
  $('contact-time').textContent = formatListTime(last.createdAt);
}

export function setSidebarTyping(typing) {
  const preview = $('contact-preview');
  if (typing) {
    preview.classList.add('typing');
    preview.textContent = 'typing…';
  } else if (preview.classList.contains('typing')) {
    preview.classList.remove('typing');
    if (ctx) updateSidebarPreview();
  }
}

/** Day labels ("Today") go stale after midnight; app.js calls this periodically. */
export function refreshRelativeLabels() {
  if (!ctx) return;
  for (const [key, el] of daySeps) el.firstChild.textContent = formatDayLabel(new Date(key));
  updateSidebarPreview();
}

function showState(state, errorText) {
  $('messages-skeleton').hidden = state !== 'loading';
  $('messages-empty').hidden = state !== 'empty';
  $('messages-error').hidden = state !== 'error';
  $('message-list').hidden = state === 'loading' || state === 'error';
  $('older-loader').hidden = state !== 'list' || !hasMore;
  if (errorText) $('messages-error-text').textContent = errorText;
}

/* ======================================================================
   Scrolling & pagination
   ====================================================================== */

function isNearBottom(threshold = 140) {
  const s = $('messages-scroller');
  return s.scrollHeight - s.scrollTop - s.clientHeight < threshold;
}

function scrollToBottom() {
  const s = $('messages-scroller');
  s.scrollTop = s.scrollHeight;
  newBelowCount = 0;
  $('scroll-bottom').hidden = true;
}

function bumpNewBelow(n) {
  newBelowCount += n;
  const badge = $('scroll-bottom-count');
  badge.textContent = String(newBelowCount);
  badge.hidden = false;
  $('scroll-bottom').hidden = false;
}

function observeOlder() {
  olderObserver?.disconnect();
  if (!('IntersectionObserver' in window)) return;
  olderObserver = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) loadOlder();
  }, { root: $('messages-scroller'), rootMargin: '200px 0px 0px 0px' });
  olderObserver.observe($('older-loader'));
}

async function loadOlder() {
  if (loadingOlder || !hasMore || !oldestCursor || !ctx) return;
  loadingOlder = true;
  const gen = generation;
  const btn = $('load-older');
  btn.disabled = true;
  btn.textContent = 'Loading…';
  try {
    const q = query(messagesCol(), orderBy('createdAt', 'desc'), startAfter(oldestCursor), limit(PAGE_SIZE));
    const snap = await getDocs(q);
    if (gen !== generation) return;
    const scroller = $('messages-scroller');
    const prevHeight = scroller.scrollHeight;
    const prevTop = scroller.scrollTop;
    snap.docs.forEach((d) => { if (!messages.has(d.id)) messages.set(d.id, toMessage(d)); });
    if (snap.docs.length) oldestCursor = snap.docs[snap.docs.length - 1];
    hasMore = snap.docs.length >= PAGE_SIZE;
    render();
    // Keep the viewport anchored on the message the user was reading.
    scroller.scrollTop = prevTop + (scroller.scrollHeight - prevHeight);
    showState('list');
  } catch (err) {
    if (gen === generation) toast(friendlyError(err, 'Could not load older messages.'), { type: 'error' });
  } finally {
    loadingOlder = false;
    btn.disabled = false;
    btn.textContent = 'Load earlier messages';
  }
}

/* ======================================================================
   Sending & deleting
   ====================================================================== */

async function sendMessage(rawText) {
  const text = rawText.trim();
  if (!text || !ctx) return false;
  if (text.length > MAX_MESSAGE_LENGTH) {
    toast(`Messages can be at most ${MAX_MESSAGE_LENGTH} characters.`, { type: 'warning' });
    return false;
  }
  const ref = doc(messagesCol());
  // Optimistic bubble; replaced in place when the snapshot arrives with the same id.
  messages.set(ref.id, {
    id: ref.id, senderId: ctx.myUid, text, deleted: false,
    createdAt: new Date(serverNow()), pending: true, failed: false,
  });
  render();
  showState('list');
  scrollToBottom();
  stopTyping();
  updateSidebarPreview();
  writeMessage(ref, text);
  return true;
}

async function writeMessage(ref, text) {
  const gen = generation;
  try {
    await setDoc(ref, { senderId: ctx.myUid, text, createdAt: serverTimestamp(), deleted: false });
  } catch (err) {
    if (gen !== generation) return;
    const msg = messages.get(ref.id);
    if (msg && msg.pending) {
      msg.failed = true;
      msg.pending = false;
      updateNode(msg);
    }
    toast(friendlyError(err, 'Message could not be sent. Tap it to retry.'), { type: 'error' });
  }
}

function onOwnBubbleClick(id, li) {
  const msg = messages.get(id);
  if (!msg) return;
  if (msg.failed) {
    msg.failed = false;
    msg.pending = true;
    updateNode(msg);
    writeMessage(doc(messagesCol(), id), msg.text);
    return;
  }
  // Touch devices have no hover: tapping reveals the delete action.
  li.classList.toggle('show-actions');
}

async function deleteMessage(id) {
  const msg = messages.get(id);
  if (!msg || msg.deleted || msg.pending) return;
  const ok = await confirmDialog({
    title: 'Delete message?',
    text: 'It will be replaced with “This message was deleted” for both of you.',
    okLabel: 'Delete for everyone',
  });
  if (!ok) return;
  try {
    await updateDoc(doc(messagesCol(), id), { text: '', deleted: true, deletedAt: serverTimestamp() });
  } catch (err) {
    toast(friendlyError(err, 'Could not delete the message.'), { type: 'error' });
  }
}

/* ======================================================================
   Composer & DOM bindings (bound once)
   ====================================================================== */

const isTouchFirst = () => window.matchMedia('(hover: none) and (pointer: coarse)').matches;

function autoGrow(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`;
}

function updateComposerState() {
  const input = $('message-input');
  const len = input.value.length;
  $('send-btn').disabled = input.value.trim().length === 0 || len > MAX_MESSAGE_LENGTH;
  const counter = $('char-counter');
  counter.hidden = len < MAX_MESSAGE_LENGTH - 500;
  counter.textContent = `${len}/${MAX_MESSAGE_LENGTH}`;
  counter.classList.toggle('limit', len >= MAX_MESSAGE_LENGTH);
}

function bindUi() {
  if (uiBound) return;
  uiBound = true;

  const input = $('message-input');
  const form = $('composer');

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const value = input.value;
    if (!value.trim()) return;
    // Clear synchronously so a double Enter/click cannot send the same text twice.
    input.value = '';
    autoGrow(input);
    updateComposerState();
    sendMessage(value);
    if (!isTouchFirst()) input.focus();
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229 && !isTouchFirst()) {
      e.preventDefault();
      form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event('submit', { cancelable: true }));
    }
  });

  input.addEventListener('input', () => {
    autoGrow(input);
    updateComposerState();
    if (input.value.trim()) notifyTyping();
    else stopTyping();
  });
  input.addEventListener('blur', () => stopTyping());

  $('messages-scroller').addEventListener('scroll', () => {
    if (isNearBottom(60)) {
      newBelowCount = 0;
      $('scroll-bottom-count').hidden = true;
      $('scroll-bottom').hidden = true;
    } else if ($('messages-scroller').scrollHeight - $('messages-scroller').scrollTop - $('messages-scroller').clientHeight > 400) {
      $('scroll-bottom').hidden = false;
    }
  }, { passive: true });

  $('scroll-bottom').addEventListener('click', () => {
    $('messages-scroller').scrollTo({ top: $('messages-scroller').scrollHeight, behavior: 'smooth' });
    newBelowCount = 0;
    $('scroll-bottom-count').hidden = true;
  });

  $('load-older').addEventListener('click', loadOlder);

  $('messages-retry').addEventListener('click', () => {
    if (!ctx) return;
    unsubLive?.();
    initialLoaded = false;
    serverSeen = false;
    showState('loading');
    subscribeLive();
  });

  updateComposerState();
}
