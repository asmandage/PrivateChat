/**
 * Single active session per account, and session-only sign-in.
 *
 *  - Every sign-in gets a new `auth_time` claim in its Google-signed ID token. The
 *    newest one is recorded in sessions/{uid}. firestore.rules reject every request
 *    whose token carries a different auth_time, so an older device loses access to
 *    messages, calls and profiles immediately, even though its token has not expired.
 *    That server-side check is the real enforcement; the watcher below only makes the
 *    old device notice in real time, end any call and sign itself out.
 *  - The sign-in itself lives in sessionStorage (see firebase.js). Some browsers restore
 *    sessionStorage after a full restart ("continue where you left off"). A restored
 *    sign-in that was not in use during the last RESTORE_GRACE_MS is signed out.
 */
import {
  doc,
  getDoc,
  setDoc,
  onSnapshot,
  serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { db } from './firebase.js';

const ALIVE_KEY = 'privatechat.alive';
const SUPERSEDED_KEY = 'privatechat.superseded';
const ALIVE_EVERY_MS = 30_000;
const RESTORE_GRACE_MS = 10 * 60_000;

export const SUPERSEDED_MESSAGE = 'Your account was logged in on another device.';

export class SessionSupersededError extends Error {
  constructor() {
    super(SUPERSEDED_MESSAGE);
    this.name = 'SessionSupersededError';
  }
}

const sessionRef = (uid) => doc(db, 'sessions', uid);

/** The sign-in time (seconds) baked into this sign-in's ID tokens. */
export async function getAuthTime(user) {
  const { claims } = await user.getIdTokenResult();
  return Number(claims.auth_time);
}

/**
 * Records this sign-in as the account's only active session. The rules accept it only
 * when no newer sign-in exists, so concurrent logins always resolve to the newest one.
 */
export async function claimSession(uid, authTime) {
  try {
    await setDoc(sessionRef(uid), { authTime, updatedAt: serverTimestamp() });
  } catch (err) {
    if (err?.code !== 'permission-denied') throw err;
    // Denied either because a newer sign-in owns the account, or because of a
    // configuration problem (UID allowlist). Only the former is "superseded".
    const snap = await getDoc(sessionRef(uid)).catch(() => null);
    if (snap?.exists() && snap.data().authTime > authTime) throw new SessionSupersededError();
    throw err;
  }
}

/** Calls onSuperseded once a newer sign-in has claimed the account. */
export function watchSession(uid, authTime, onSuperseded) {
  return onSnapshot(sessionRef(uid), (snap) => {
    const current = snap.data()?.authTime;
    if (typeof current === 'number' && current > authTime) onSuperseded();
  }, () => { /* access problems surface through the app's other listeners */ });
}

/* ---------- Restored-session guard ---------- */

let aliveTimer = null;

function markAlive() {
  try { localStorage.setItem(ALIVE_KEY, String(Date.now())); } catch { /* storage unavailable */ }
}

export function startAliveMarker() {
  markAlive();
  clearInterval(aliveTimer);
  aliveTimer = setInterval(markAlive, ALIVE_EVERY_MS);
  window.addEventListener('pagehide', markAlive);
}

export function stopAliveMarker() {
  clearInterval(aliveTimer);
  aliveTimer = null;
  window.removeEventListener('pagehide', markAlive);
  try { localStorage.removeItem(ALIVE_KEY); } catch { /* storage unavailable */ }
}

/** True when a sign-in found at startup was not in use recently (browser restored it). */
export function isStaleRestore() {
  let last = 0;
  try { last = Number(localStorage.getItem(ALIVE_KEY)) || 0; } catch { /* treat as stale */ }
  return Date.now() - last > RESTORE_GRACE_MS;
}

/* ---------- "Logged in on another device" notice across the reload ---------- */

export function rememberSuperseded() {
  try { sessionStorage.setItem(SUPERSEDED_KEY, '1'); } catch { /* storage unavailable */ }
}

export function takeSupersededNotice() {
  try {
    const seen = sessionStorage.getItem(SUPERSEDED_KEY) === '1';
    sessionStorage.removeItem(SUPERSEDED_KEY);
    return seen;
  } catch {
    return false;
  }
}
