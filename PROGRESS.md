# PROGRESS / CONTEXT — WhatsApp Bulk Sender

Purpose: so any new session (human or Claude) can pick this up without re-reading the whole
codebase. Read this + `PRD.md` first. Update the checkboxes and the "Session log" as you go.

**Last updated:** 2026-09-21

---

## One-paragraph summary

Desktop app (Electron installer, no Node/npm needed on the user's machine). `whatsapp-web.js` drives a headless Chromium that is logged into the user's
own WhatsApp Web session. An Express server serves a plain-HTML GUI on `localhost:3000` and
pushes QR codes, progress and logs over Socket.IO. The user uploads a CSV/XLSX contact list,
maps columns, writes a templated message, and a sequential queue sends it with randomised
delays, a daily cap and an opt-out list. All state lives in JSON files under the per-user app-data folder.

Accounts run in one of two modes, decided by `src/config.js`: **local** (accounts hashed
on the device, nothing uploaded) or **firebase** (accounts in Firebase Auth, usage counts
reported to an admin dashboard inside the app). Firebase mode is offline-tolerant: events
queue on disk and flush when a connection returns, and a saved refresh token lets a user
back in without a network for 30 days.

## Work graph

```mermaid
graph TD
  A[Project scaffold<br/>package.json, folders] --> B[WhatsApp client wrapper<br/>src/whatsapp.js]
  A --> C[Storage layer<br/>src/store.js]
  A --> D[Contact parsing + normalise<br/>src/contacts.js]
  B --> E[Send queue engine<br/>src/campaign.js]
  C --> E
  D --> E
  E --> F[Express + Socket.IO server<br/>server.js]
  B --> F
  F --> G[GUI shell + tabs<br/>public/index.html]
  G --> H[Connection tab - QR + status]
  G --> I[Contacts tab - upload + column map]
  G --> J[Message tab - template + preview]
  G --> K[Campaign tab - live dashboard]
  G --> L[Settings tab - delays, cap, country code]
  E --> M[Opt-out handling]
  E --> N[Resume after restart]
  K --> O[CSV report export]
  O --> P[v2: Electron packaging]
```

## Status

### Done
- [x] PRD written (`PRD.md`)
- [x] This context doc
- [x] Folder scaffold (`src/ public/ data/ uploads/ sessions/`)
- [x] `package.json` + dependencies installed
- [x] `src/store.js` — JSON persistence
- [x] `src/contacts.js` — CSV/XLSX/paste parsing, number normalisation, dedupe
- [x] `src/template.js` — `{{var}}` + spintax rendering
- [x] `src/whatsapp.js` — client lifecycle, QR, ready, number check, send
- [x] `src/campaign.js` — queue, delays, pause/resume/stop, retry, daily cap
- [x] `server.js` — REST + Socket.IO
- [x] `public/` — GUI (all five tabs)
- [x] `README.md` — run instructions
- [x] Electron desktop app + NSIS installer (`npm run dist`), verified running packaged
- [x] Account gate: signup/login, scrypt-hashed local passwords, token-guarded API and socket
- [x] Firebase mode: Auth over REST, Firestore usage reporting, offline queue
- [x] Google sign-in via loopback OAuth + PKCE, exchanged into a Firebase session
- [x] Admin dashboard tab (admin account only) listing users and their counts
- [x] `firestore.rules` restricting each user to their own data
- [x] Test suite (`npm test`): engine, numbers, templates, firebase mode, privacy scrubbing

- [x] `start.bat` double-click launcher
- [x] Tested: number normalisation (10 cases), send engine with a stubbed transport
      (sent / failed / retry-once / not-on-WhatsApp / opt-out), pause + resume across a
      process restart, daily-cap stop, CSV report, history archive
- [x] Tested: real Chromium launch and live QR generation
- [x] Tested: GUI renders and all tabs work (driven with Puppeteer, zero console errors)

### Not done / next
- [ ] **End-to-end test with a real WhatsApp account** — everything up to the QR is verified,
      but no message has actually been delivered yet. Needs the user's phone to scan.
- [ ] Inbound STOP listener verified against a real reply
- [ ] **Firebase project** — Aman must create it and fill in `src/config.js` (see FIREBASE_SETUP.md).
      Until then the app runs in local mode and there is no dashboard.
- [ ] Google sign-in tested against a real Google client (flow is built and unit-tested
      against a stub, but never run against real Google servers)
- [ ] Code-signing certificate (~$200/yr) to remove the SmartScreen warning
- [ ] Scheduled sends (v2)
- [ ] Chrome extension (v3)

## Bugs found and fixed during the build

| Bug | Symptom | Fix |
|---|---|---|
| `[hidden]` did nothing | A CSS `display` rule beats the `hidden` attribute's UA style, so the first-run warning modal stayed on screen as a full-viewport overlay after "Continue" and silently swallowed every click in the app | `[hidden] { display: none !important; }` at the top of `styles.css` |
| Country code skipped | A 10-digit national number that happens to start with the country code (`9123456789` with cc `91`) was treated as already-international and sent malformed | Require `cc.length + 9` digits before treating a number as international |
| No nav below 950px | The sidebar was `display: none` with no replacement, leaving no way to change tabs on a narrow window | Sidebar becomes a horizontal scrolling bar |
| Chromium never downloaded | `npm install` did not fetch Chromium, so connecting failed with "Could not find Chrome" | `postinstall: puppeteer browsers install chrome`, plus a fallback chain that finds system Chrome or Edge |
| `classList.add('')` threw | When disconnected with no error, `renderWaStatus` aborted mid-way and left the whole status panel stale | Compute the class name first, never add an empty token |
| Email/password inputs unstyled | The CSS selector only covered `text` and `number`, so the login box rendered with white system inputs | Widened the selector |
| Dashboard tab shown in local mode | The admin tab appeared for the admin email even with no Firebase to read from, then failed | `isAdminAccount()` requires firebase mode |

## Key decisions and why

| Decision | Reason |
|---|---|
| `whatsapp-web.js` over the official Cloud API | Cloud API needs business verification + paid templates; user wants their personal number |
| JSON files over SQLite | `better-sqlite3` needs node-gyp/VS build tools on Windows — a install-time failure mode for a non-technical user |
| Electron over a browser GUI | Superseded the earlier "browser only" call once the goal became a distributable installer. Same HTML UI, now wrapped so users need no Node or npm |
| Firebase over a self-hosted API | Free tier, and it covers accounts, Google sign-in and the usage database in one. A self-hosted API meant paying for hosting and writing password handling by hand |
| Firebase REST, not the `firebase` SDK | The SDK is browser-shaped and heavy; every call here is a plain HTTPS request, so REST keeps the installer smaller and failures obvious |
| Usage counts only, never contact data | `telemetry.scrub()` drops anything that is not a number or boolean, and `firestore.rules` rejects contact-shaped keys server side. Two independent layers, so one bug cannot leak a contact list |
| Offline-first telemetry | A dashboard outage must never stop someone sending messages |
| Sequential queue, never parallel | Parallel sends from one session are the fastest route to a ban |
| Spintax built in | Identical message bodies at volume is the strongest spam signal WhatsApp has |
| Session stored via `LocalAuth` in `sessions/` | Avoids re-scanning QR on every restart |

## Gotchas for whoever picks this up

- `sessions/` and `data/` contain the live WhatsApp auth and contact data. **Never commit them.**
  `.gitignore` covers this.
- If Chromium fails to launch, `whatsapp-web.js` fails silently-ish — check the terminal, not the GUI.
  Fallback: set `CHROME_PATH` env var to a local Chrome install.
- WhatsApp Web updates occasionally break `whatsapp-web.js`. Symptom: stuck on "authenticating"
  forever. Fix: `npm install whatsapp-web.js@latest` and delete `sessions/`.
- Number normalisation assumes a default country code from settings (default `91`). A list with
  mixed countries must carry full international numbers.
- The daily cap counter resets on calendar date, stored in `data/settings.json`.
- **`ELECTRON_RUN_AS_NODE=1` makes the packaged .exe exit instantly with code 0 and no output.**
  It runs the binary as plain Node instead of Electron. If the app "does nothing" when
  launched from a terminal, check that variable first — it cost an hour of false debugging.
- Installed builds write to `%APPDATA%whatsapp-bulk-sender`, not the install folder.
  `src/paths.js` decides this; running from source keeps everything in the project folder.
- The installer is unsigned, so Windows SmartScreen warns on first run. Expected until a
  code-signing certificate is bought.
- `src/config.js` values are public by design (Firebase apiKey, OAuth client ID). The
  Firestore rules are the security boundary, not secrecy of those strings.

## Modes at a glance

| | local mode | firebase mode |
|---|---|---|
| Set by | `src/config.js` empty | `src/config.js` filled in |
| Accounts | On the device, scrypt-hashed | Firebase Auth |
| Password visible to admin | Never (hash only, on device) | Never (Google holds it) |
| Google sign-in | Needs a per-device client ID | Built in |
| Dashboard | None | Admin tab in the app |
| Works offline | Always | After first sign-in, 30-day grace |

## Session log

- **2026-09-21 (session 2)** — Turned the tool into a distributable product: Electron
  installer (114 MB, no Node needed), account gate, Firebase mode for accounts + usage
  reporting, Google sign-in, admin dashboard, and a real test suite (`npm test`).
  Verified the packaged .exe runs and signs up. Four more bugs found and fixed.
  **Blocked on Aman:** create the Firebase project and fill `src/config.js`.
- **2026-09-21 (session 1)** — Project created from scratch. PRD + this doc + full v1 implementation
  (backend, engine, GUI). Engine, parsing and GUI verified with automated tests and a
  Puppeteer-driven browser; real Chromium launch and QR generation confirmed. Four bugs
  found and fixed (table above). **Still untested: an actual message delivered to a real
  phone** — that is the first thing to do next, with a 2-contact list of your own numbers.
