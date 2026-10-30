/**
 * Firebase initialisation. All SDK modules come from the official gstatic CDN
 * at ONE pinned version so no build step or npm install is needed.
 */
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { initializeAuth, browserSessionPersistence } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  initializeFirestore,
  memoryLocalCache,
  clearIndexedDbPersistence,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { FIREBASE_CONFIG, APP_CHECK_SITE_KEY } from './firebase-config.js';

export const FIREBASE_SDK_VERSION = '10.12.2';

export function isConfigured() {
  return !Object.values(FIREBASE_CONFIG).some((v) => String(v).startsWith('REPLACE_WITH'));
}

export const app = initializeApp(FIREBASE_CONFIG);

// The sign-in lives in sessionStorage only: closing the browser tab, the browser or
// the installed app ends it, and the password is needed again. (Some browsers restore
// sessionStorage after a restart; session.js guards against that.)
export const auth = initializeAuth(app, { persistence: browserSessionPersistence });

// Messages are cached in memory only, so nothing private stays on the device once the
// app is closed or signed out. Writes made while offline still queue until reconnect.
export const db = initializeFirestore(app, { localCache: memoryLocalCache() });

// Earlier versions kept the conversation in an IndexedDB cache and the sign-in in
// IndexedDB ("stay signed in"). Remove both once.
try { clearIndexedDbPersistence(db).catch(() => {}); } catch { /* already started */ }
try { indexedDB.deleteDatabase('firebaseLocalStorageDb'); } catch { /* storage unavailable */ }

/** Optional App Check (loaded lazily so the SDK is only fetched when configured). */
export async function initAppCheck() {
  if (!APP_CHECK_SITE_KEY) return false;
  try {
    const { initializeAppCheck, ReCaptchaV3Provider } = await import(
      'https://www.gstatic.com/firebasejs/10.12.2/firebase-app-check.js'
    );
    initializeAppCheck(app, {
      provider: new ReCaptchaV3Provider(APP_CHECK_SITE_KEY),
      isTokenAutoRefreshEnabled: true,
    });
    return true;
  } catch (err) {
    console.error('App Check failed to initialise.', err?.message || err);
    return false;
  }
}
