# PrivateChat

A private web app for exactly **two people** with real-time chat, audio calls and video calls.
It runs as a static site on **GitHub Pages**: no server, no build step, no Node.js at runtime.

| Layer | Technology |
|---|---|
| UI | HTML5, CSS3, vanilla JavaScript ES modules (no framework) |
| Auth | Firebase Authentication (email/password, two allowlisted UIDs) |
| Data & signalling | Cloud Firestore (real-time listeners) |
| Calls | WebRTC (`RTCPeerConnection`, `getUserMedia`), STUN, optional TURN |
| SDK | Firebase JS SDK **10.12.2** from `https://www.gstatic.com/firebasejs/` (one pinned version) |
| Hosting | GitHub Pages (works under a sub-path such as `/CHATWEBAPK/`) |

---

## Contents

1. [Features](#1-features)
2. [Project structure](#2-project-structure)
3. [Setup and deployment (step by step)](#3-setup-and-deployment-step-by-step)
4. [TURN server (for networks where calls fail)](#4-turn-server-for-networks-where-calls-fail)
5. [Firestore data model](#5-firestore-data-model)
6. [Security model](#6-security-model)
7. [Testing](#7-testing)
8. [Known limitations](#8-known-limitations)
9. [Cost and Firestore usage](#9-cost-and-firestore-usage)
10. [Troubleshooting](#10-troubleshooting)

---

## 1. Features

**Authentication**: email/password sign-in, persistent sessions, logout with confirmation, password-reset email, a loading state while the session is verified, and readable error messages. There is no sign-up, guest or anonymous access. Only the two allowlisted UIDs can use the app, and this is enforced by Firestore rules.

**Messaging**
- Real-time chat bubbles with sent/received styling, day separators and timestamps.
- Delivery ticks: 🕓 sending → ✓ sent → ✓✓ delivered → ✓✓ (cyan) read.
- Typing indicator and online / "last seen" status.
- The view auto-scrolls when you are at the bottom. Otherwise a "new messages" button appears.
- Multiline input. On desktop, Enter sends and Shift+Enter adds a new line. On phones, the send button sends.
- Empty messages are blocked, and messages over 4000 characters are blocked with a counter.
- Duplicate-send protection: a client-generated id plus create-only rules.
- Long messages collapse behind "Show more", and long words wrap.
- Older messages load page by page as you scroll up.
- "Delete for everyone" for your own messages.
- Loading skeletons plus empty, error/retry and offline states.
- Unread counter on the contact, in the tab title and as the app badge where supported.

**Audio and video calls**
- Start, ring, accept, decline, cancel and end calls.
- Ringing / connecting / reconnecting states and a duration timer.
- 40-second no-answer timeout, which records a missed call.
- Busy handling, and glare handling (both people press "call" at the same moment).
- Microphone mute, camera on/off and camera switching, with the remote side shown when the other person is muted or has their camera off.
- Draggable picture-in-picture self view.
- Clear messages when permission is denied, a device is missing or a device is busy.
- Connection-failure handling with a hint about TURN.
- Stale-call protection.
- Full cleanup when a call ends: tracks are stopped (the camera light turns off), the peer connection is closed, listeners are detached and our ICE docs are deleted.
- The screen is kept awake during calls where the browser supports it.

**Notifications**: an original ringtone generated with Web Audio (no audio files), a message sound, browser notifications while the page is open in the background, missed-call toasts (including "missed while you were away"), and a call history list with call-back buttons.

**Settings**: theme (system / light / dark), sound and notification preferences, microphone / camera / speaker selection, display name, app info and logout. Preferences are stored in `localStorage`. No secrets are stored there.

---

## 2. Project structure

```
CHATWEBAPK/                  # repository root = GitHub Pages site root
├── index.html               # single page: login, chat, call UI, modals, inline SVG icon sprite
├── README.md
├── .gitignore
├── .nojekyll                # tells GitHub Pages to serve files as-is
├── firestore.rules          # ⚠ put your two UIDs here
├── firestore.indexes.json   # composite index + TTL policies
├── firebase.json            # only for the optional Firebase CLI / emulator
├── css/
│   ├── style.css            # design tokens (light/dark), base, login, modals, toasts
│   ├── chat.css             # layout, sidebar, messages, composer
│   ├── calls.css            # incoming call + in-call screen
│   └── responsive.css       # mobile / landscape rules
├── js/
│   ├── firebase-config.js   # ⚠ your Firebase config, the two UIDs, STUN/TURN
│   ├── firebase.js          # SDK initialisation (+ optional App Check)
│   ├── theme-boot.js        # applies theme before first paint; anti-clickjacking
│   ├── app.js               # entry point, session lifecycle, presence UI, mobile navigation
│   ├── auth.js              # login form, allowlist check, logout, password reset
│   ├── chat.js              # messages, pagination, receipts, composer
│   ├── presence.js          # online/typing/read markers, server clock offset
│   ├── calls.js             # call signalling state machine + call UI + call history
│   ├── webrtc.js            # media capture, ICE servers, RTCPeerConnection wrapper
│   ├── notifications.js     # tones, browser notifications, unread/title
│   ├── settings.js          # preferences, theme, devices, settings modal
│   └── ui.js                # DOM helpers, toasts, dialogs, formatting
├── assets/icons/favicon.svg
└── tests/                   # optional: Firestore rules tests (Node + emulator), not needed for hosting
    ├── package.json
    └── rules.test.mjs
```

---

## 3. Setup and deployment (step by step)

You will configure Firebase first, then upload to GitHub Pages. Allow about 20–30 minutes.

### Step 1: Create a Firebase project
1. Open <https://console.firebase.google.com> and click **Create a project**.
2. Choose a name. Google Analytics is not needed.

### Step 2: Register a web app and copy its config
1. In **Project settings → General → Your apps**, click the **Web** icon (`</>`).
2. Give it a nickname. You do **not** need Firebase Hosting.
3. Copy the `firebaseConfig` values into `js/firebase-config.js` → `FIREBASE_CONFIG`.
   These values are public identifiers, not secrets.

### Step 3: Enable email/password sign-in and block self-registration
1. **Authentication → Get started → Sign-in method → Email/Password → Enable** (leave "Email link" off).
2. **Authentication → Settings → User actions**: **untick "Enable create (sign-up)"** and **untick "Enable deletion"**.
   Without this, anyone with your public API key could create accounts through the REST API. Those accounts would still be blocked by the rules, but there is no reason to allow them.
3. Leave **Email enumeration protection** enabled (the default).

### Step 4: Create exactly two users and get their UIDs
1. **Authentication → Users → Add user**: enter the email and a strong password for person 1, then repeat for person 2.
2. Copy each user's **User UID** from the Users table (a string like `x8Gd2…`).

### Step 5: Put the UIDs in BOTH places
- `js/firebase-config.js` → `ALLOWED_UIDS = ['UID_OF_PERSON_1', 'UID_OF_PERSON_2']`
- `firestore.rules` → replace `REPLACE_WITH_USER_1_UID` and `REPLACE_WITH_USER_2_UID`

The rules are the real security boundary. The JavaScript list only shows a friendly error.

### Step 6: Create the Firestore database and publish the rules
1. **Firestore Database → Create database** → choose **Production mode** and a location near you.
   The location cannot be changed later.
2. Open the **Rules** tab, replace everything with the contents of your edited `firestore.rules`, and click **Publish**.

### Step 7: Create the index and TTL policies
**Composite index (required for call history).** Go to **Firestore → Indexes → Composite → Create index** and enter:
- Collection ID: `calls`
- Fields: `participants` → **Arrays**, then `createdAt` → **Descending**
- Query scope: Collection

Alternatively, run the app once. The browser console then shows an error with a direct link that creates the index. It takes a few minutes to build.

**TTL policies (recommended)** delete old ICE-candidate documents automatically. Go to **Firestore → Time-to-live → Create policy** twice:
- Collection group `callerCandidates`, timestamp field `expiresAt`
- Collection group `calleeCandidates`, timestamp field `expiresAt`

If you use the Firebase CLI instead, `firebase deploy --only firestore` deploys the rules, the index and the TTL settings from `firestore.indexes.json`.

### Step 8: Create the GitHub repository
1. On GitHub, create a new repository, for example `CHATWEBAPK`.
   It can be public, because no secrets are in the code. A private repository needs a paid plan for Pages.
2. Upload the **contents** of this folder (so `index.html` is at the repository root): **Add file → Upload files** → drag everything in, including the `css`, `js` and `assets` folders and `.nojekyll`. Then commit.
   - Hidden files such as `.nojekyll` and `.gitignore` may not show in your file picker. Drag-and-drop the folder contents, or create `.nojekyll` (empty) on GitHub with **Add file → Create new file**.
   - `tests/` and `firebase.json` are optional. They are harmless to upload.

### Step 9: Enable GitHub Pages
1. Open **Settings → Pages**. Under **Build and deployment**, set Source to **Deploy from a branch**, Branch to **main**, and folder to **/ (root)**. Click **Save**.
2. After a minute your site is live at `https://asmandage.github.io/CHATWEBAPK/`.
   All paths in the app are relative, so the sub-path works.

### Step 10: Authorize the GitHub Pages domain in Firebase
Go to **Authentication → Settings → Authorized domains → Add domain** and add `asmandage.github.io`. Do not include a path or `https://`.

### Step 11: Harden the API key (recommended)
In the **Google Cloud Console → APIs & Services → Credentials**, open the "Browser key" that Firebase created. Under **Application restrictions → Websites**, add:
- `https://asmandage.github.io/*`
- `http://localhost/*` (if you test locally)

### Step 12 (optional): App Check
App Check makes it harder for scripts outside your site to use your Firebase project.
1. Create a **reCAPTCHA v3** key at <https://www.google.com/recaptcha/admin> for the domain `asmandage.github.io`.
2. In **Firebase → App Check**, register the web app with the reCAPTCHA v3 provider (enter the secret key there, never in the code).
3. Put the **site key** in `APP_CHECK_SITE_KEY` in `js/firebase-config.js` and redeploy.
4. Watch the App Check metrics for a few days. Once all requests are verified, click **Enforce** for Cloud Firestore.

App Check raises the bar, but it is not authentication: a determined attacker using a real browser can still pass reCAPTCHA. The UID-allowlist rules remain the actual protection.

### Step 13: First run and two-device test
1. Open the site on device A and sign in as person 1. Then open it on device B (different network if possible) and sign in as person 2.
2. Send messages both ways, and check typing, ticks and refresh.
3. Start an audio call, then a video call. Allow camera and microphone when the browser asks.
4. Work through the [testing checklist](#7-testing).

To update the site later, edit the files on GitHub (or upload replacements). Pages republishes automatically. If you change `firestore.rules`, publish them again in the Firebase console.

---

## 4. TURN server (for networks where calls fail)

WebRTC first tries a **direct peer-to-peer** connection, using free Google STUN servers to discover public addresses. This works on most home Wi-Fi and many mobile networks, but **not all**. Symmetric NATs, some carrier-grade NATs, strict corporate or school firewalls, and some hotel networks block direct connections. Then the call shows *"Could not connect … a TURN relay is needed"*.

A **TURN server** relays the encrypted media when a direct path is impossible.
- **Cost:** relaying uses bandwidth, so TURN services usually charge. Some offer free tiers, and you can self-host *coturn* on a small VM.
- **Never put a TURN shared secret (static auth secret) in this repo.** Everything in a GitHub Pages site is public.

Two safe options are supported in `js/firebase-config.js`:
1. **`TURN_CREDENTIALS_URL`**: a provider endpoint that returns short-lived credentials as JSON (`[{urls, username, credential}]` or `{iceServers:[…]}`). The app fetches it at call time and falls back to STUN-only if it fails.
   Note: if the URL embeds an API key, that key is public. Use a provider whose key only issues short-lived TURN credentials and can be domain-restricted or rate-limited.
2. **A static entry in `ICE_SERVERS`**, only with credentials you can rotate and that are restricted on the provider side.

Media relayed through TURN is still end-to-end encrypted (DTLS-SRTP). The relay cannot decode it.

Without TURN, the app cannot promise that every call will connect. This is a limit of peer-to-peer networking, not of the app.

---

## 5. Firestore data model

```
users/{uid}
  uid, displayName, state ('online'|'offline'), lastActive,
  typing (bool), typingAt, lastReadAt, lastDeliveredAt

conversations/main/messages/{messageId}
  senderId, text (≤4000), createdAt (server time), deleted (bool), [deletedAt]

calls/{callId}
  callerId, calleeId, participants [caller, callee], type ('audio'|'video'),
  status, offer {type,sdp}, [answer {type,sdp}],
  createdAt, updatedAt, [acceptedAt, endedAt, endedBy, endReason]

calls/{callId}/callerCandidates/{"0".."99"}   candidate, sdpMid, sdpMLineIndex, usernameFragment, createdAt, expiresAt
calls/{callId}/calleeCandidates/{"0".."99"}   (same)
```

Design choices:
- **Read receipts and typing cost no per-message writes.** Each user keeps `lastReadAt` / `lastDeliveredAt` timestamps on their own profile. A message is "read" when the peer's `lastReadAt ≥ message.createdAt`.
- **Bounded listeners.** There is one live listener on the newest 30 messages. Older pages are fetched once with `getDocs` + `startAfter`. Call history is limited to the last 15 calls.
- **No duplicates.** The client generates a message id and writes it with `setDoc`. The rules allow *create* only, so a retry cannot create a second copy.
- **Server time everywhere.** `createdAt == request.time` is enforced, so ordering cannot be faked by a wrong device clock. The app also estimates its clock offset from the server once per session. That offset is used for "online", "typing" and stale-call decisions.
- **Bounded ICE.** Candidate doc ids must match `^[0-9]{1,2}$`, which allows at most 100 per side per call. Each client deletes its own candidates when a call ends, and TTL (`expiresAt`, at most 2 days) is the backstop.
- **Offline cache.** The persistent IndexedDB cache makes reloads cheaper and lets messages queue while offline.

### Call state machine (enforced by rules)

```
             callee: accepted (+answer)              either: ended | failed
 ringing ───────────────────────────────▶ accepted ─────────────────────────▶ (terminal)
    │ callee: rejected | busy | missed
    │ caller: cancelled | missed
    ▼
 (terminal)
```

- Only the **callee** may accept, reject or report busy. Only the **caller** may cancel. Either may record "missed" from `ringing`.
- `accepted → ended/failed` must set `endedBy` to the person writing it.
- `callerId`, `calleeId`, `participants`, `type`, `offer` and `createdAt` can never change after creation, because they are absent from every allowed key set.
- Terminal states have no allowed outgoing transition, so a finished call cannot be "revived".
- Candidates may only be written by the matching role, and only while the call is `ringing` or `accepted`.
- **Glare:** if both people call at the same instant, the person with the lexicographically smaller UID keeps their call. The other cancels theirs (marked `endReason: 'collision'`) and sees the incoming call.
- **Stale calls:** a `ringing` call older than about 50 seconds (server-corrected) is ignored and marked `missed`. "Busy" is decided from local state, so an abandoned `accepted` document never blocks future calls.

---

## 6. Security model

**What is enforced server-side (`firestore.rules`):**
- Every read and write requires a signed-in user whose UID is one of the two allowlisted UIDs. Everyone else, including other accounts in the same Firebase project, gets nothing.
- Only the known paths exist. There are no recursive wildcards, and everything else is denied.
- Users can write only their own profile, with a fixed set of fields, validated types and no future timestamps.
- Messages: `senderId` must equal the writer (no impersonation), the text must be 1–4000 non-blank characters, the keys must be exactly the allowed set, and `createdAt` must be server time. There are no edits. Only the sender may "delete for everyone" (blank the text), and hard deletes are denied.
- Calls: creator must be the caller, the callee must be the other member, and every transition follows the state machine above.

**Client-side measures:**
- All user text is rendered with `textContent` (never `innerHTML`).
- A Content-Security-Policy meta tag (no inline scripts, scripts only from self, gstatic and reCAPTCHA) and frame-busting against clickjacking.
- No passwords are stored by the app. Firebase Auth keeps its own session token in IndexedDB.
- Console logs contain error codes only, never message text or SDP.

**Limitations a static site cannot remove:**
- The Firebase config and API key are public by design. Protection comes from the rules (plus optional App Check and API-key referrer restrictions).
- Anyone can *attempt* to sign in. Firebase rate-limits failed attempts, but strong, unique passwords are essential.
- If either account is compromised, the attacker sees everything that user can see.
- Messages are encrypted in transit and at rest by Google, but they are **not end-to-end encrypted**: anyone with admin access to the Firebase project can read them. Calls are end-to-end encrypted (DTLS-SRTP) between the two browsers.
- Peer-to-peer calls reveal each person's IP address to the other, which is inherent to WebRTC. To hide it, configure TURN and set `ICE_TRANSPORT_POLICY = 'relay'` in `js/firebase-config.js`.
- Rules cannot verify honesty about presence or typing state, or enforce timeouts. These are cosmetic and only affect the two trusted users.
- GitHub Pages cannot send security headers, so the CSP is a `<meta>` tag. It cannot express `frame-ancestors`, which is why the JavaScript frame-busting exists.

---

## 7. Testing

### 7.1 Automated Firestore rules tests (emulator)
These tests cover the "Security" checklist: unauthorized reads and writes, sender spoofing, call-signalling impersonation, invalid data, terminal states and candidate limits.

Requirements: Node.js 18+ and Java 11+ (for the emulator).
```bash
cd tests
npm install
npm test        # starts the Firestore emulator and runs node --test rules.test.mjs
```
The test file reads `../firestore.rules`. If the UIDs are still placeholders, it substitutes test UIDs. If you have already inserted your real UIDs, it extracts and uses them.

### 7.2 Manual checklist (two real devices)

Status at delivery is recorded honestly below. Items marked **Pending** need your Firebase project and two devices, and could not be run in the build environment.

| Area | Test | Status |
|---|---|---|
| Build | All modules and the Firebase SDK load and link in Chrome with no errors | ✅ Verified (headless Chrome) |
| Build | Placeholder config shows the "Setup required" screen | ✅ Verified |
| Auth | Login screen renders. A failed sign-in shows a readable error from the real Firebase Auth API | ✅ Verified (dummy config) |
| UI | Desktop, phone and dark-mode layouts. Call and incoming-call screens. No horizontal overflow | ✅ Verified visually with sample DOM (not live data) |
| Rules | `tests/rules.test.mjs` passes | ⏳ Pending: Node/Java were unavailable in the build environment. Run §7.1 |
| Auth | Both authorized users can log in | ⏳ Pending |
| Auth | A third account (if sign-up is still enabled) is rejected with "not authorized" and cannot read data | ⏳ Pending |
| Auth | Refresh keeps you signed in. Logout works | ⏳ Pending |
| Chat | User 1 → User 2 arrives in real time. Reply works | ⏳ Pending |
| Chat | Messages persist after refresh. "Load earlier" works with more than 30 messages | ⏳ Pending |
| Chat | Ticks go sent → delivered → read. Typing indicator appears and disappears | ⏳ Pending |
| Chat | A long message, HTML like `<b>x</b>` and emoji render as plain text | ⏳ Pending |
| Chat | Offline send queues (🕓) and delivers on reconnect | ⏳ Pending |
| Calls | Audio call: ring, accept, audio both ways, mute/unmute, end | ⏳ Pending |
| Calls | Video call: both videos, camera off/on, switch camera (phone), end | ⏳ Pending |
| Calls | Decline, cancel while ringing, and no answer (40 s) produce a missed-call toast and history entry | ⏳ Pending |
| Calls | Both press call at the same moment: one call survives and connects after accept | ⏳ Pending |
| Calls | Deny the mic/camera permission: a clear message appears and the other side sees "declined" | ⏳ Pending |
| Calls | Turn Wi-Fi off mid-call: "Reconnecting…", then the call ends after about 12 s if not recovered | ⏳ Pending |
| Calls | Close the tab while ringing, reopen, and call again: the new call works (no stale block) | ⏳ Pending |
| Calls | After hanging up, the camera/mic indicator light turns off | ⏳ Pending |
| Mobile | Android Chrome and iOS Safari: layout, keyboard, call controls reachable, rotation | ⏳ Pending |

---

## 8. Known limitations

- **No background or closed-app calls.** A GitHub Pages site has no push server, so incoming calls and notifications **only work while the page is open**. A background tab works on desktop browsers. Mobile browsers usually suspend background tabs within seconds to minutes, and then nothing rings. iOS only allows web notifications for sites added to the Home Screen (iOS 16.4+), and even then only through Web Push, which needs a server. Adding Firebase Cloud Messaging plus a Cloud Function would fix this, but it requires the paid Blaze plan and a backend, which are outside this project's constraints.
- **Presence is approximate.** Firestore has no "on disconnect" trigger. The app sends a heartbeat every 60 s. If a tab is killed, the other person may see "online" for up to about 2.5 minutes before it switches to "last seen".
- **Autoplay.** Sound starts only after you have interacted with the page once. If the browser blocks remote audio, a "Tap to enable sound" button appears.
- **Calls need connectivity on both sides.** There is no ICE-restart renegotiation. After a network change that does not recover within about 12 s, the call ends and you call again.
- **Audio and video calls are separate.** You cannot upgrade an audio call to video mid-call.
- **Multiple tabs.** If the same account is open in two tabs or devices, both ring. Answering in one dismisses the other.
- **No message editing, attachments or group chats.** These were outside the requirements.
- **Firestore TTL deletion** happens within about 24 h after expiry, not instantly.
- **Browser support:** current Chrome, Edge, Firefox and Safari 15.4+ (desktop and mobile). HTTPS is required for camera and microphone, and GitHub Pages provides it.

---

## 9. Cost and Firestore usage

The free **Spark** plan quotas (50k reads, 20k writes, 20k deletes per day, 1 GiB storage) are ample for two people. Rough figures while the app is open:

| Activity | Writes | Reads |
|---|---|---|
| Presence heartbeat | 1 per minute per open device | about 2 per heartbeat (your own profile and the peer's listener) |
| Sending a message | 1 + occasional receipt | 1 per listener (both users) |
| Typing | at most about 1 per 3 s while typing | 1 per change on the peer |
| A call | 1 create + 2–3 updates + about 10–40 candidates | similar number of reads |
| App load | 1–2 | up to about 30 messages + 15 calls (cached afterwards) |

A heavy day (8 hours open on two devices, hundreds of messages, a few calls) stays in the low thousands of operations. Leaving the app open 24/7 on several devices increases heartbeat writes: about 1,440 per device per day. TURN relays are billed by their provider, separately from Firebase.

Set a **budget alert** in Google Cloud if you upgrade to Blaze.

---

## 10. Troubleshooting

| Symptom | Fix |
|---|---|
| "Setup required" screen | Fill in `FIREBASE_CONFIG` and both `ALLOWED_UIDS` in `js/firebase-config.js`. |
| "Firebase is not configured" on login | The API key or config is wrong. Copy it again from Project settings. |
| `auth/unauthorized-domain` | Add `asmandage.github.io` under Authentication → Settings → Authorized domains. |
| "Email/password sign-in is not enabled" | Enable it under Authentication → Sign-in method. |
| "Signed in, but the database denied access" | The UIDs in `firestore.rules` do not match, or the rules were not published. |
| "This account is not authorized" | The UID is missing from `ALLOWED_UIDS`. |
| "Call history needs a Firestore index" | Create the composite index (Step 7), then wait for it to finish building. |
| Calls ring but never connect ("TURN relay is needed") | The networks block peer-to-peer. Configure TURN (§4) or test on another network. |
| No camera or mic prompt, or "requires HTTPS" | Open the `https://` URL. On `http://` LAN addresses browsers block media. `localhost` is allowed. |
| Remote audio silent on iPhone | Tap "Tap to enable sound". Check the silent switch and volume. |
| "Permission … denied" | Allow camera/mic in the browser's site settings (padlock icon), then call again. |
| Changes don't show after uploading | GitHub Pages and the browser cache. Wait a minute and hard-refresh (Ctrl/Cmd+Shift+R). |
| Blank page | Open DevTools → Console. A 404 on a `.js` file usually means a folder was not uploaded, or `index.html` is not at the repository root. |
| App Check errors after enforcing | `APP_CHECK_SITE_KEY` is missing or the domain is not registered for the reCAPTCHA key. |

### Local testing (optional)
ES modules do not load from `file://`. Serve the folder over HTTP instead, for example with `npx serve .` or `python -m http.server 8080`, and open `http://localhost:8080`. Add `localhost` to Firebase's authorized domains (it is there by default).
