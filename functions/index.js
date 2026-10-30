/**
 * PrivateChat Cloud Functions: private push notifications (requires the Blaze plan).
 *
 * Privacy rules this file follows:
 *  - A push carries ONLY an event kind: { k: 'm' | 'a' | 'v' | 'mc' } (new message,
 *    audio call, video call, missed call). Never a name, phone number, message text,
 *    caller, call id or anything else from the database. The service worker on the
 *    device turns the kind into the coded title/text the user configured there.
 *  - Pushes go only to tokens registered by the account's CURRENT session
 *    (sessions/{uid}.authTime), so a device signed out by a newer login stops
 *    receiving them.
 *  - Logs contain the event kind and counts only — no uids, tokens or content.
 *
 * Deploy: see README → "Background push".
 */
'use strict';

const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');
const { setGlobalOptions } = require('firebase-functions/v2');
const { onDocumentCreated, onDocumentUpdated } = require('firebase-functions/v2/firestore');
const logger = require('firebase-functions/logger');

// ⚠ Must match your Firestore database location (Firebase console → Firestore → the
// location shown above the data): nam5 → 'us-central1', eur3 → 'europe-west1',
// otherwise the same region name, e.g. 'asia-south1'.
const REGION = 'us-central1';

// ⚠ The same two UIDs as js/firebase-config.js and firestore.rules.
const ALLOWED_UIDS = ['wxC2B1XFgtaoIFOVTUjhBOAxoKi1', 'Ce6xiyk5gJenhC3eRNcVnnCJr6t1'];

const MESSAGE_TTL_S = 24 * 3600;
const CALL_TTL_S = 40;            // a call push arriving after the ringing window is useless
const DEAD_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);

setGlobalOptions({ region: REGION, maxInstances: 2 });
initializeApp();
const db = getFirestore();

const otherOf = (uid) => (ALLOWED_UIDS.includes(uid) ? ALLOWED_UIDS.find((u) => u !== uid) : null);

async function pushTo(uid, kind, ttlSeconds) {
  if (!uid || !ALLOWED_UIDS.includes(uid)) return;
  const [session, tokens] = await Promise.all([
    db.doc(`sessions/${uid}`).get(),
    db.collection(`users/${uid}/pushTokens`).get(),
  ]);
  const authTime = session.get('authTime');
  const targets = tokens.docs.filter((d) => authTime != null && d.get('authTime') === authTime);
  if (!targets.length) return;

  // While a device is offline, pushes wait at the push service for up to TTL seconds
  // and are delivered when it reconnects. `Topic` makes a newer push of the same kind
  // replace one still waiting, so reconnecting shows one notification, not a burst.
  const result = await getMessaging().sendEach(targets.map((d) => ({
    token: d.get('token'),
    data: { k: kind },   // data-only: the service worker decides what is displayed
    webpush: { headers: { Urgency: 'high', TTL: String(ttlSeconds), Topic: `pc-${kind}` } },
  })));

  await Promise.all(result.responses.map((r, i) => (
    DEAD_TOKEN_CODES.has(r.error?.code) ? targets[i].ref.delete() : null
  )));
  logger.info('push', { kind, sent: result.successCount, failed: result.failureCount });
}

exports.notifyNewMessage = onDocumentCreated('conversations/{conversationId}/messages/{messageId}', async (event) => {
  const msg = event.data?.data();
  if (!msg || msg.deleted) return;
  await pushTo(otherOf(msg.senderId), 'm', MESSAGE_TTL_S);
});

exports.notifyIncomingCall = onDocumentCreated('calls/{callId}', async (event) => {
  const call = event.data?.data();
  if (!call || call.status !== 'ringing') return;
  await pushTo(call.calleeId, call.type === 'video' ? 'v' : 'a', CALL_TTL_S);
});

exports.notifyMissedCall = onDocumentUpdated('calls/{callId}', async (event) => {
  const before = event.data?.before.data();
  const after = event.data?.after.data();
  if (!before || !after || before.status !== 'ringing') return;
  if (!['missed', 'cancelled'].includes(after.status) || after.acceptedAt) return;
  // 'collision' = both called at once (not missed); 'stale' = noticed by the callee's own app.
  if (['collision', 'stale'].includes(after.endReason)) return;
  await pushTo(after.calleeId, 'mc', MESSAGE_TTL_S);
});
