/**
 * Permission handling for notifications, microphone and camera.
 *
 *  - The current state is checked first (Permissions API where the browser has it).
 *  - Before the browser's own prompt, a short explanation says why access is needed.
 *  - After a denial the prompt is never triggered again; instead the user gets steps
 *    to re-enable it in the browser or OS settings.
 *  - Every prompt starts from a user action (a tap on call / accept / a switch).
 */
import { confirmDialog, infoDialog } from './ui.js';

const LABELS = { microphone: 'Microphone', camera: 'Camera', notifications: 'Notifications' };

const isIos = () =>
  /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isAndroid = () => /Android/.test(navigator.userAgent);

/** 'granted' | 'denied' | 'prompt' | 'unknown' (state not exposed) | 'unsupported'. */
export async function permissionState(name) {
  if (name === 'notifications') {
    if (!('Notification' in window)) return 'unsupported';
    return { granted: 'granted', denied: 'denied' }[Notification.permission] || 'prompt';
  }
  if (!navigator.mediaDevices?.getUserMedia) return 'unsupported';
  try {
    return (await navigator.permissions.query({ name })).state;
  } catch {
    return 'unknown';   // e.g. Firefox does not expose microphone/camera state
  }
}

/** Platform-specific steps to re-enable a blocked permission. */
export function manualInstructions(names) {
  const what = names.map((n) => LABELS[n]).join(' and ');
  if (isIos()) {
    return names.includes('notifications')
      ? 'On iPhone/iPad: open Settings → Notifications → My Offers and turn on Allow Notifications. (Notifications need the app added to the Home Screen, iOS 16.4 or later.)'
      : `On iPhone/iPad: open Settings → Safari → ${what} and choose Allow (or tap “aA” in Safari’s address bar → Website Settings). Then try again.`;
  }
  if (isAndroid()) {
    return `On Android: in Chrome tap ⋮ → Settings → Site settings → ${what}, open this site and choose Allow. For the installed app you can also long-press its icon → App info → Permissions / Notifications. Also make sure Chrome itself is allowed in Android Settings → Apps → Chrome → Permissions.`;
  }
  return `Click the icon to the left of the address bar (lock or settings icon) → Site settings, set ${what} to Allow, then reload the page and try again.`;
}

export async function showPermissionHelp(names) {
  await infoDialog({
    title: `${names.map((n) => LABELS[n]).join(' and ')} blocked`,
    text: `Access is blocked for this site, so the browser will not ask again.\n\n${manualInstructions(names)}`,
  });
}

/**
 * Before a call: true when getUserMedia may run now. Explains first if the browser is
 * about to ask; shows re-enable steps (and returns false) if access is blocked.
 */
export async function ensureMediaPermission(type) {
  const names = type === 'video' ? ['microphone', 'camera'] : ['microphone'];
  const states = await Promise.all(names.map(permissionState));
  if (states.includes('unsupported')) return true;   // the call code reports unsupported browsers
  const denied = names.filter((_, i) => states[i] === 'denied');
  if (denied.length) {
    await showPermissionHelp(denied);
    return false;
  }
  if (states.every((s) => s === 'granted')) return true;
  return confirmDialog({
    title: type === 'video' ? 'Allow camera and microphone?' : 'Allow microphone?',
    text: type === 'video'
      ? 'The call needs your camera and microphone so the other person can see and hear you. Your browser will ask next. Nothing is recorded.'
      : 'The call needs your microphone so the other person can hear you. Your browser will ask next. Nothing is recorded.',
    okLabel: 'Continue',
    danger: false,
  });
}

/** From the notification switch: 'granted' | 'denied' | 'cancelled' | 'unsupported'. */
export async function requestNotificationPermission() {
  const state = await permissionState('notifications');
  if (state === 'unsupported') {
    await infoDialog({
      title: 'Notifications unavailable',
      text: isIos()
        ? 'On iPhone/iPad, notifications only work after adding the app to the Home Screen (iOS 16.4 or later). Open it from there and try again.'
        : 'This browser does not support notifications.',
    });
    return 'unsupported';
  }
  if (state === 'granted') return 'granted';
  if (state === 'denied') {
    await showPermissionHelp(['notifications']);
    return 'denied';
  }
  const ok = await confirmDialog({
    title: 'Allow notifications?',
    text: 'Notifications only show your coded offer-style text — never names, message text or call details. Your browser will ask next.',
    okLabel: 'Continue',
    danger: false,
  });
  if (!ok) return 'cancelled';
  let result;
  try { result = await Notification.requestPermission(); } catch { result = 'denied'; }
  return result === 'granted' ? 'granted' : result === 'denied' ? 'denied' : 'cancelled';
}
