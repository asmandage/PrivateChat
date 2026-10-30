/**
 * Decoy screen: a generic, unbranded "My Offers" deals page shown instead of an error
 * when someone enters a wrong email/password. It names no real company, collects
 * nothing and links nowhere; offer buttons only show a toast.
 *
 * It is camouflage, not security: Firebase still rate-limits sign-in attempts and the
 * Firestore rules still protect the data. To get back to the login, reload the page or
 * tap the "My Offers" title DECOY_EXIT_TAPS times in a row.
 */
import { $, showScreen, toast } from './ui.js';

const DECOY_EXIT_TAPS = 5;
const TAP_WINDOW_MS = 3_000;

let bound = false;

function bind() {
  if (bound) return;
  bound = true;

  $('decoy-screen').addEventListener('click', (e) => {
    if (e.target.closest('.decoy-offer-btn')) toast('This offer is no longer available.');
  });

  let taps = 0;
  let firstTap = 0;
  $('decoy-title').addEventListener('click', () => {
    const now = Date.now();
    if (now - firstTap > TAP_WINDOW_MS) { taps = 0; firstTap = now; }
    if (++taps >= DECOY_EXIT_TAPS) {
      taps = 0;
      showScreen('login');
      $('login-email').focus();
    }
  });
}

export function showDecoy() {
  bind();
  showScreen('decoy');
  $('decoy-screen').scrollTop = 0;
}
