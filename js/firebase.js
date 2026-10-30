/**
 * Firebase initialisation. All SDK modules come from the official gstatic CDN
 * at ONE pinned version so no build step or npm install is needed.
 */
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  memoryLocalCache,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { FIREBASE_CONFIG, APP_CHECK_SITE_KEY } from './firebase-config.js';

export const FIREBASE_SDK_VERSION = '10.12.2';

export function isConfigured() {
  return !Object.values(FIREBASE_CONFIG).some((v) => String(v).startsWith('REPLACE_WITH'));
}

export const app = initializeApp(FIREBASE_CONFIG);
export const auth = getAuth(app);

// The offline cache lets reloads read messages from IndexedDB instead of re-downloading
// them (fewer billed reads). It is unavailable in some private-browsing modes.
function createFirestore() {
  try {
    return initializeFirestore(app, {
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
    });
  } catch (err) {
    console.warn('Persistent Firestore cache unavailable, using memory cache.', err?.code || '');
    return initializeFirestore(app, { localCache: memoryLocalCache() });
  }
}
export const db = createFirestore();

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
