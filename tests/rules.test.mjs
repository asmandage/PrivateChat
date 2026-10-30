/**
 * Firestore security rules tests — run against the local emulator:
 *
 *   cd tests && npm install && npm test
 *
 * Works whether or not you have already put your real UIDs into firestore.rules:
 * placeholders are swapped for test UIDs, real UIDs are extracted and used as-is.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { before, after, beforeEach, describe, it } from 'node:test';
import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} from '@firebase/rules-unit-testing';
import {
  doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, collection, query, where, orderBy, limit,
  serverTimestamp, Timestamp, writeBatch,
} from 'firebase/firestore';

const here = dirname(fileURLToPath(import.meta.url));
let rules = readFileSync(join(here, '..', 'firestore.rules'), 'utf8');

const uidFromRules = (fn) => rules.match(new RegExp(`function ${fn}\\(\\) \\{ return '([^']+)'; \\}`))?.[1];
let A = uidFromRules('user1Uid');
let B = uidFromRules('user2Uid');
if (!A || A.startsWith('REPLACE_WITH')) {
  A = 'alice-test-uid';
  B = 'bob-test-uid';
  rules = rules.replace('REPLACE_WITH_USER_1_UID', A).replace('REPLACE_WITH_USER_2_UID', B);
}
const MALLORY = 'mallory-uid';

// Every test request is made from the account's active sign-in (auth_time T) unless
// a test passes another auth_time to simulate an older or newer device.
const T = 1_700_000_000;

let env;
const as = (uid, authTime = T) => env.authenticatedContext(uid, { auth_time: authTime }).firestore();
const anon = () => env.unauthenticatedContext().firestore();
const msgRef = (db, id = 'm1', conv = 'main') => doc(db, 'conversations', conv, 'messages', id);
const OFFER = { type: 'offer', sdp: 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n' };
const ANSWER = { type: 'answer', sdp: 'v=0\r\no=- 3 4 IN IP4 127.0.0.1\r\n' };

const validMessage = (sender) => ({ senderId: sender, text: 'hello', createdAt: serverTimestamp(), deleted: false });
const validUser = (uid) => ({ uid, displayName: 'Alice', state: 'online', lastActive: serverTimestamp(), typing: false });
const ringingCall = (caller, callee) => ({
  callerId: caller, calleeId: callee, participants: [caller, callee], type: 'video',
  status: 'ringing', offer: OFFER, createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
});
const candidate = () => ({
  candidate: 'candidate:1 1 udp 2122260223 192.0.2.1 54400 typ host', sdpMid: '0', sdpMLineIndex: 0,
  usernameFragment: 'abcd', createdAt: serverTimestamp(), expiresAt: Timestamp.fromMillis(Date.now() + 3600_000),
});

/** Seeds a document bypassing rules. */
async function seed(path, data) {
  await env.withSecurityRulesDisabled(async (ctx) => setDoc(doc(ctx.firestore(), ...path), data));
}

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-privatechat',
    firestore: { rules, host: '127.0.0.1', port: 8080 },
  });
});
after(async () => { await env?.cleanup(); });
beforeEach(async () => {
  await env.clearFirestore();
  await seed(['sessions', A], { authTime: T, updatedAt: Timestamp.now() });
  await seed(['sessions', B], { authTime: T, updatedAt: Timestamp.now() });
});

describe('single active session', () => {
  const session = (authTime) => ({ authTime, updatedAt: serverTimestamp() });

  it('a newer sign-in can claim the account; an older one cannot take it back', async () => {
    await assertSucceeds(setDoc(doc(as(A, T + 60), 'sessions', A), session(T + 60)));
    await assertFails(setDoc(doc(as(A, T), 'sessions', A), session(T)));
    // Re-claiming with the same sign-in (page reload) is fine.
    await assertSucceeds(setDoc(doc(as(A, T + 60), 'sessions', A), session(T + 60)));
  });
  it('rejects every data request from a superseded sign-in, even with a valid token', async () => {
    await seed(['conversations', 'main', 'messages', 'm1'], { senderId: A, text: 'x', createdAt: Timestamp.now(), deleted: false });
    await seed(['sessions', A], { authTime: T + 60, updatedAt: Timestamp.now() });
    const old = as(A, T);
    await assertFails(getDoc(msgRef(old)));
    await assertFails(setDoc(msgRef(old, 'm2'), validMessage(A)));
    await assertFails(getDoc(doc(old, 'users', B)));
    await assertFails(setDoc(doc(old, 'calls', 'c1'), ringingCall(A, B)));
    // ...but it may still read its own session doc to find out why.
    await assertSucceeds(getDoc(doc(old, 'sessions', A)));
    await assertSucceeds(getDoc(msgRef(as(A, T + 60))));
  });
  it('denies data access before any session was claimed', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => deleteDoc(doc(ctx.firestore(), 'sessions', A)));
    await assertFails(getDoc(msgRef(as(A))));
  });
  it('cannot claim with a forged auth_time or for someone else', async () => {
    await assertFails(setDoc(doc(as(A, T), 'sessions', A), session(T + 999)));
    await assertFails(setDoc(doc(as(A, T + 60), 'sessions', B), session(T + 60)));
    await assertFails(getDoc(doc(as(A), 'sessions', B)));
    await assertFails(setDoc(doc(as(MALLORY, T + 60), 'sessions', MALLORY), session(T + 60)));
    await assertFails(deleteDoc(doc(as(A), 'sessions', A)));
  });
});

describe('authentication & allowlist', () => {
  it('denies unauthenticated reads and writes', async () => {
    await assertFails(getDoc(msgRef(anon())));
    await assertFails(setDoc(msgRef(anon()), validMessage(A)));
    await assertFails(getDocs(collection(anon(), 'calls')));
  });
  it('denies signed-in users who are not on the allowlist', async () => {
    const db = as(MALLORY);
    await assertFails(getDoc(msgRef(db)));
    await assertFails(setDoc(msgRef(db), validMessage(MALLORY)));
    await assertFails(getDoc(doc(db, 'users', A)));
    await assertFails(setDoc(doc(db, 'users', MALLORY), validUser(MALLORY)));
    await assertFails(setDoc(doc(db, 'calls', 'c1'), ringingCall(MALLORY, A)));
  });
  it('denies access to unrelated collections and conversations', async () => {
    await assertFails(setDoc(doc(as(A), 'other', 'x'), { a: 1 }));
    await assertFails(getDoc(doc(as(A), 'other', 'x')));
    await assertFails(setDoc(msgRef(as(A), 'm1', 'secret'), validMessage(A)));
    await assertFails(setDoc(doc(as(A), 'conversations', 'main'), { a: 1 }));
  });
});

describe('users', () => {
  it('lets a member create and update only their own profile', async () => {
    await assertSucceeds(setDoc(doc(as(A), 'users', A), validUser(A)));
    await assertSucceeds(updateDoc(doc(as(A), 'users', A), { typing: true, typingAt: serverTimestamp() }));
    await assertSucceeds(updateDoc(doc(as(A), 'users', A), { lastReadAt: serverTimestamp(), lastDeliveredAt: serverTimestamp() }));
    await assertFails(setDoc(doc(as(A), 'users', B), validUser(B)));
    await assertFails(setDoc(doc(as(A), 'users', B), validUser(A)));
  });
  it('allows the peer to read but not modify', async () => {
    await seed(['users', A], { ...validUser(A), lastActive: Timestamp.now() });
    await assertSucceeds(getDoc(doc(as(B), 'users', A)));
    await assertFails(updateDoc(doc(as(B), 'users', A), { displayName: 'Hacked' }));
  });
  it('rejects invalid fields, future timestamps and bad names', async () => {
    await assertFails(setDoc(doc(as(A), 'users', A), { ...validUser(A), admin: true }));
    await assertFails(setDoc(doc(as(A), 'users', A), { ...validUser(A), state: 'invisible' }));
    await assertFails(setDoc(doc(as(A), 'users', A), { ...validUser(A), displayName: 'x'.repeat(41) }));
    await assertFails(setDoc(doc(as(A), 'users', A), { ...validUser(A), displayName: '   ' }));
    await assertFails(setDoc(doc(as(A), 'users', A), { ...validUser(A), lastActive: Timestamp.fromMillis(Date.now() + 86400_000) }));
    await assertFails(setDoc(doc(as(A), 'users', A), { ...validUser(A), lastReadAt: Timestamp.fromMillis(Date.now() + 86400_000) }));
  });
  it('never allows deleting a profile', async () => {
    await seed(['users', A], { ...validUser(A), lastActive: Timestamp.now() });
    await assertFails(deleteDoc(doc(as(A), 'users', A)));
  });
  it('accepts clear/wipe markers at server time but not in the future', async () => {
    await seed(['users', A], { ...validUser(A), lastActive: Timestamp.now() });
    await assertSucceeds(updateDoc(doc(as(A), 'users', A), { clearedAt: serverTimestamp(), callsClearedAt: serverTimestamp() }));
    await assertSucceeds(updateDoc(doc(as(A), 'users', A), { wipedAt: serverTimestamp() }));
    await assertFails(updateDoc(doc(as(A), 'users', A), { clearedAt: Timestamp.fromMillis(Date.now() + 86400_000) }));
    await assertFails(updateDoc(doc(as(B), 'users', A), { clearedAt: serverTimestamp() }));
  });
});

describe('delete for me (private markers)', () => {
  const markers = (db, owner = A, id = 'markers') => doc(db, 'users', owner, 'private', id);

  it('owner sets and reads clearedAt / callsClearedAt', async () => {
    await assertSucceeds(setDoc(markers(as(A)), { clearedAt: serverTimestamp() }, { merge: true }));
    await assertSucceeds(setDoc(markers(as(A)), { callsClearedAt: serverTimestamp() }, { merge: true }));
    await assertSucceeds(getDoc(markers(as(A))));
  });
  it('the other member cannot see or change when history was cleared', async () => {
    await seed(['users', A, 'private', 'markers'], { clearedAt: Timestamp.now() });
    await assertFails(getDoc(markers(as(B))));
    await assertFails(setDoc(markers(as(B)), { clearedAt: serverTimestamp() }));
  });
  it('rejects other documents, extra fields and future times', async () => {
    await assertFails(setDoc(markers(as(A), A, 'other'), { clearedAt: serverTimestamp() }));
    await assertFails(setDoc(markers(as(A)), { clearedAt: serverTimestamp(), note: 'x' }));
    await assertFails(setDoc(markers(as(A)), { clearedAt: Timestamp.fromMillis(Date.now() + 86400_000) }));
    await assertFails(setDoc(markers(as(A, T - 60)), { clearedAt: serverTimestamp() }));   // superseded sign-in
  });
});

describe('delete for me (hiddenMessages)', () => {
  const hidden = (db, owner, id = 'm1') => doc(db, 'users', owner, 'hiddenMessages', id);

  it('owner can hide, list and un-hide; the other member cannot see or touch it', async () => {
    await assertSucceeds(setDoc(hidden(as(A), A), { createdAt: serverTimestamp() }));
    await assertSucceeds(getDocs(collection(as(A), 'users', A, 'hiddenMessages')));
    await assertFails(getDocs(collection(as(B), 'users', A, 'hiddenMessages')));
    await assertFails(setDoc(hidden(as(B), A, 'm2'), { createdAt: serverTimestamp() }));
    await assertFails(deleteDoc(hidden(as(B), A)));
    await assertSucceeds(deleteDoc(hidden(as(A), A)));
  });
  it('validates the marker', async () => {
    await assertFails(setDoc(hidden(as(A), A, 'x1'), { createdAt: serverTimestamp(), text: 'copy' }));
    await assertFails(setDoc(hidden(as(A), A, 'x2'), { createdAt: Timestamp.fromMillis(0) }));
  });
});

describe('push tokens', () => {
  const ID = 'a'.repeat(64);
  const token = (authTime = T) => ({ token: 'fcm-token', authTime, updatedAt: serverTimestamp() });
  const ref = (db, owner = A, id = ID) => doc(db, 'users', owner, 'pushTokens', id);

  it('owner registers a token bound to the current sign-in', async () => {
    await assertSucceeds(setDoc(ref(as(A)), token()));
    await assertSucceeds(setDoc(ref(as(A)), token()));   // refresh
    await assertSucceeds(deleteDoc(ref(as(A))));
  });
  it('rejects tokens for other users, forged auth_time, bad ids and extra fields', async () => {
    await assertFails(setDoc(ref(as(B)), token()));
    await assertFails(setDoc(ref(as(A)), token(T + 1)));
    await assertFails(setDoc(ref(as(A), A, 'not-a-hash'), token()));
    await assertFails(setDoc(ref(as(A)), { ...token(), name: 'Alice' }));
  });
  it('the other member can never read someone else’s tokens', async () => {
    await seed(['users', A, 'pushTokens', ID], { token: 'fcm-token', authTime: T, updatedAt: Timestamp.now() });
    await assertFails(getDoc(ref(as(B))));
    await assertFails(getDocs(collection(as(B), 'users', A, 'pushTokens')));
  });
});

describe('messages', () => {
  it('lets members send and read messages', async () => {
    await assertSucceeds(setDoc(msgRef(as(A)), validMessage(A)));
    await assertSucceeds(getDoc(msgRef(as(B))));
    await assertSucceeds(getDocs(query(collection(as(B), 'conversations', 'main', 'messages'), orderBy('createdAt', 'desc'), limit(30))));
  });
  it('denies sender spoofing', async () => {
    await assertFails(setDoc(msgRef(as(A)), validMessage(B)));
  });
  it('denies invalid message data', async () => {
    const db = as(A);
    await assertFails(setDoc(msgRef(db, 'e1'), { ...validMessage(A), text: '' }));
    await assertFails(setDoc(msgRef(db, 'e2'), { ...validMessage(A), text: '   \n ' }));
    await assertFails(setDoc(msgRef(db, 'e3'), { ...validMessage(A), text: 'x'.repeat(4001) }));
    await assertFails(setDoc(msgRef(db, 'e4'), { ...validMessage(A), text: 42 }));
    await assertFails(setDoc(msgRef(db, 'e5'), { ...validMessage(A), createdAt: Timestamp.fromMillis(0) }));
    await assertFails(setDoc(msgRef(db, 'e6'), { ...validMessage(A), extra: 'field' }));
    await assertFails(setDoc(msgRef(db, 'e7'), { ...validMessage(A), deleted: true }));
    await assertFails(setDoc(msgRef(db, 'e8'), { senderId: A, text: 'no timestamp', deleted: false }));
    await assertSucceeds(setDoc(msgRef(db, 'ok'), { ...validMessage(A), text: 'x'.repeat(4000) }));
  });
  it('stores long and HTML-like text verbatim (rendering uses textContent)', async () => {
    await assertSucceeds(setDoc(msgRef(as(A), 'html'), { ...validMessage(A), text: '<img src=x onerror=alert(1)>' }));
  });
  it('prevents duplicate submissions with the same id (create-only)', async () => {
    await assertSucceeds(setDoc(msgRef(as(A), 'dup'), validMessage(A)));
    await assertFails(setDoc(msgRef(as(A), 'dup'), validMessage(A)));
  });
  it('allows only the sender to "delete for everyone", and only by blanking', async () => {
    await seed(['conversations', 'main', 'messages', 'm1'], { senderId: A, text: 'secret', createdAt: Timestamp.now(), deleted: false });
    await assertFails(updateDoc(msgRef(as(B)), { text: '', deleted: true, deletedAt: serverTimestamp() }));
    await assertFails(updateDoc(msgRef(as(A)), { text: 'edited' }));
    await assertFails(updateDoc(msgRef(as(A)), { text: 'changed', deleted: true, deletedAt: serverTimestamp() }));
    await assertFails(updateDoc(msgRef(as(A)), { senderId: B }));
    await assertSucceeds(updateDoc(msgRef(as(A)), { text: '', deleted: true, deletedAt: serverTimestamp() }));
    await assertFails(updateDoc(msgRef(as(A)), { text: '', deleted: false, deletedAt: serverTimestamp() }));
  });
  it('either member may permanently erase messages ("delete conversation for everyone"); outsiders may not', async () => {
    await seed(['conversations', 'main', 'messages', 'm1'], { senderId: A, text: 'x', createdAt: Timestamp.now(), deleted: false });
    await assertFails(deleteDoc(msgRef(as(MALLORY))));
    await assertFails(deleteDoc(msgRef(anon())));
    await assertFails(deleteDoc(msgRef(as(B, T - 60))));   // superseded sign-in
    await assertSucceeds(deleteDoc(msgRef(as(B))));
  });
  it('allows erasing a conversation in batches of 20 (the app’s batch size)', async () => {
    for (let i = 0; i < 20; i++) {
      await seed(['conversations', 'main', 'messages', `b${i}`], { senderId: i % 2 ? A : B, text: 'x', createdAt: Timestamp.now(), deleted: false });
    }
    const db = as(A);
    const batch = writeBatch(db);
    for (let i = 0; i < 20; i++) batch.delete(msgRef(db, `b${i}`));
    await assertSucceeds(batch.commit());
  });
  it('supports the "deleted for me" query (createdAt after clearedAt)', async () => {
    await assertSucceeds(getDocs(query(collection(as(A), 'conversations', 'main', 'messages'),
      where('createdAt', '>', Timestamp.fromMillis(0)), orderBy('createdAt', 'desc'), limit(30))));
  });
});

describe('calls', () => {
  const callRef = (db, id = 'c1') => doc(db, 'calls', id);
  const seedCall = (status, extra = {}) => seed(['calls', 'c1'], {
    callerId: A, calleeId: B, participants: [A, B], type: 'video', status, offer: OFFER,
    createdAt: Timestamp.now(), updatedAt: Timestamp.now(), ...extra,
  });

  it('lets a member start a call to the other member', async () => {
    await assertSucceeds(setDoc(callRef(as(A)), ringingCall(A, B)));
  });
  it('denies caller impersonation and bad call data', async () => {
    await assertFails(setDoc(callRef(as(A), 'x1'), ringingCall(B, A)));
    await assertFails(setDoc(callRef(as(A), 'x2'), ringingCall(A, A)));
    await assertFails(setDoc(callRef(as(A), 'x3'), ringingCall(A, MALLORY)));
    await assertFails(setDoc(callRef(as(A), 'x4'), { ...ringingCall(A, B), status: 'accepted' }));
    await assertFails(setDoc(callRef(as(A), 'x5'), { ...ringingCall(A, B), type: 'screen' }));
    await assertFails(setDoc(callRef(as(A), 'x6'), { ...ringingCall(A, B), offer: ANSWER }));
    await assertFails(setDoc(callRef(as(A), 'x7'), { ...ringingCall(A, B), participants: [A, MALLORY] }));
    await assertFails(setDoc(callRef(as(A), 'x8'), { ...ringingCall(A, B), answer: ANSWER }));
  });
  it('lets both members query their calls (history + incoming)', async () => {
    await seedCall('ringing');
    await assertSucceeds(getDocs(query(collection(as(B), 'calls'), where('calleeId', '==', B), where('status', '==', 'ringing'))));
    await assertSucceeds(getDocs(query(collection(as(A), 'calls'), where('participants', 'array-contains', A), orderBy('createdAt', 'desc'), limit(15))));
  });
  it('only the callee can accept, and must attach an answer', async () => {
    await seedCall('ringing');
    const accept = { status: 'accepted', answer: ANSWER, acceptedAt: serverTimestamp(), updatedAt: serverTimestamp() };
    await assertFails(updateDoc(callRef(as(A)), accept));
    await assertFails(updateDoc(callRef(as(B)), { status: 'accepted', acceptedAt: serverTimestamp(), updatedAt: serverTimestamp() }));
    await assertFails(updateDoc(callRef(as(B)), { ...accept, callerId: B }));
    await assertFails(updateDoc(callRef(as(B)), { ...accept, offer: OFFER, type: 'audio' }));
    await assertSucceeds(updateDoc(callRef(as(B)), accept));
  });
  it('callee may reject/busy/miss; caller may cancel/miss; not the other way round', async () => {
    const end = (status) => ({ status, endedAt: serverTimestamp(), updatedAt: serverTimestamp(), endReason: 'test' });
    await seedCall('ringing');
    await assertFails(updateDoc(callRef(as(A)), end('rejected')));
    await assertFails(updateDoc(callRef(as(B)), end('cancelled')));
    await assertSucceeds(updateDoc(callRef(as(B)), end('rejected')));
    await seedCall('ringing');
    await assertSucceeds(updateDoc(callRef(as(A)), end('cancelled')));
    await seedCall('ringing');
    await assertSucceeds(updateDoc(callRef(as(B)), end('busy')));
    await seedCall('ringing');
    await assertSucceeds(updateDoc(callRef(as(A)), end('missed')));
  });
  it('either participant may end an accepted call, recorded as themselves', async () => {
    await seedCall('accepted', { answer: ANSWER, acceptedAt: Timestamp.now() });
    const ended = (by) => ({ status: 'ended', endedBy: by, endedAt: serverTimestamp(), updatedAt: serverTimestamp() });
    await assertFails(updateDoc(callRef(as(A)), ended(B)));
    await assertSucceeds(updateDoc(callRef(as(A)), ended(A)));
    await seedCall('accepted', { answer: ANSWER, acceptedAt: Timestamp.now() });
    await assertSucceeds(updateDoc(callRef(as(B)), { ...ended(B), status: 'failed', endReason: 'connection' }));
  });
  it('terminal states can never change', async () => {
    for (const status of ['rejected', 'busy', 'cancelled', 'missed', 'ended', 'failed']) {
      await seedCall(status, { endedAt: Timestamp.now() });
      await assertFails(updateDoc(callRef(as(B)), { status: 'accepted', answer: ANSWER, acceptedAt: serverTimestamp(), updatedAt: serverTimestamp() }));
      await assertFails(updateDoc(callRef(as(A)), { status: 'ringing', updatedAt: serverTimestamp() }));
      await assertFails(updateDoc(callRef(as(A)), { status: 'ended', endedBy: A, endedAt: serverTimestamp(), updatedAt: serverTimestamp() }));
    }
  });
  it('outsiders cannot read or touch calls; ringing/active calls cannot be deleted', async () => {
    await seedCall('ringing');
    await assertFails(getDoc(callRef(as(MALLORY))));
    await assertFails(updateDoc(callRef(as(MALLORY)), { status: 'cancelled', endedAt: serverTimestamp(), updatedAt: serverTimestamp() }));
    await assertFails(deleteDoc(callRef(as(A))));
    await seedCall('accepted', { answer: ANSWER, acceptedAt: Timestamp.now() });
    await assertFails(deleteDoc(callRef(as(B))));
  });
  it('participants may delete finished calls ("clear call history for everyone")', async () => {
    await seedCall('ended', { endedAt: Timestamp.now() });
    await assertFails(deleteDoc(callRef(as(MALLORY))));
    await assertSucceeds(deleteDoc(callRef(as(B))));
    // An "accepted" call abandoned for more than a day counts as finished.
    await seedCall('accepted', { answer: ANSWER, updatedAt: Timestamp.fromMillis(Date.now() - 2 * 86400_000) });
    await assertSucceeds(deleteDoc(callRef(as(A))));
  });
  it('supports the call-history query after callsClearedAt', async () => {
    await assertSucceeds(getDocs(query(collection(as(A), 'calls'), where('participants', 'array-contains', A),
      where('createdAt', '>', Timestamp.fromMillis(0)), orderBy('createdAt', 'desc'), limit(15))));
  });
  it('ICE restart: caller sends numbered offers, callee answers the current one', async () => {
    await seedCall('accepted', { answer: ANSWER, acceptedAt: Timestamp.now() });
    const restart = (n) => ({ restartN: n, restartOffer: OFFER, updatedAt: serverTimestamp() });
    const reply = (n) => ({ restartAnswerN: n, restartAnswer: ANSWER, updatedAt: serverTimestamp() });
    await assertFails(updateDoc(callRef(as(B)), restart(1)));             // callee cannot offer
    await assertFails(updateDoc(callRef(as(A)), restart(2)));             // must be the next number
    await assertSucceeds(updateDoc(callRef(as(A)), restart(1)));
    await assertFails(updateDoc(callRef(as(A)), reply(1)));               // caller cannot answer
    await assertFails(updateDoc(callRef(as(B)), reply(2)));               // must answer the current offer
    await assertFails(updateDoc(callRef(as(B)), { ...reply(1), restartAnswer: OFFER }));
    await assertSucceeds(updateDoc(callRef(as(B)), reply(1)));
    await assertFails(updateDoc(callRef(as(A)), { ...restart(2), status: 'ringing' }));
  });
  it('ICE restart is impossible outside an accepted call', async () => {
    await seedCall('ringing');
    await assertFails(updateDoc(callRef(as(A)), { restartN: 1, restartOffer: OFFER, updatedAt: serverTimestamp() }));
    await seedCall('ended', { endedAt: Timestamp.now() });
    await assertFails(updateDoc(callRef(as(A)), { restartN: 1, restartOffer: OFFER, updatedAt: serverTimestamp() }));
  });
});

describe('ICE candidates', () => {
  const cand = (db, side, id) => doc(db, 'calls', 'c1', side, id);
  beforeEach(async () => {
    await seed(['calls', 'c1'], {
      callerId: A, calleeId: B, participants: [A, B], type: 'audio', status: 'ringing', offer: OFFER,
      createdAt: Timestamp.now(), updatedAt: Timestamp.now(),
    });
  });

  it('caller writes callerCandidates, callee writes calleeCandidates — never the reverse', async () => {
    await assertSucceeds(setDoc(cand(as(A), 'callerCandidates', '0'), candidate()));
    await assertSucceeds(setDoc(cand(as(B), 'calleeCandidates', '0'), candidate()));
    await assertFails(setDoc(cand(as(B), 'callerCandidates', '1'), candidate()));
    await assertFails(setDoc(cand(as(A), 'calleeCandidates', '1'), candidate()));
    await assertFails(setDoc(cand(as(MALLORY), 'callerCandidates', '2'), candidate()));
  });
  it('bounds candidate ids to 0..99 and forbids overwrites', async () => {
    await assertSucceeds(setDoc(cand(as(A), 'callerCandidates', '99'), candidate()));
    await assertFails(setDoc(cand(as(A), 'callerCandidates', '100'), candidate()));
    await assertFails(setDoc(cand(as(A), 'callerCandidates', 'abc'), candidate()));
    await assertFails(setDoc(cand(as(A), 'callerCandidates', '99'), candidate()));
  });
  it('validates candidate shape and expiry', async () => {
    await assertFails(setDoc(cand(as(A), 'callerCandidates', '3'), { ...candidate(), extra: 1 }));
    await assertFails(setDoc(cand(as(A), 'callerCandidates', '4'), { ...candidate(), candidate: 'x'.repeat(1025) }));
    await assertFails(setDoc(cand(as(A), 'callerCandidates', '5'), { ...candidate(), expiresAt: Timestamp.fromMillis(Date.now() + 30 * 86400_000) }));
  });
  it('rejects candidates once the call is over; owner may delete theirs', async () => {
    await assertSucceeds(setDoc(cand(as(A), 'callerCandidates', '0'), candidate()));
    await env.withSecurityRulesDisabled(async (ctx) => updateDoc(doc(ctx.firestore(), 'calls', 'c1'), { status: 'ended' }));
    await assertFails(setDoc(cand(as(A), 'callerCandidates', '1'), candidate()));
    await assertFails(deleteDoc(cand(as(B), 'callerCandidates', '0')));
    await assertSucceeds(deleteDoc(cand(as(A), 'callerCandidates', '0')));
  });
});
