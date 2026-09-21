# WhatsApp Bulk Sender

A Windows desktop app that sends WhatsApp messages to a list of contacts through **your own**
WhatsApp Web session. No API keys, no business verification — you scan a QR code
exactly like you do for WhatsApp Web.

## Install (for end users)

Download **WhatsApp-Bulk-Sender-Setup-1.0.0.exe** and run it. Nothing else is needed —
no Node, no npm, no command line. Windows will warn that the app is unsigned: click
**More info → Run anyway**.

On first launch you create an account with your email, or sign in with Google.

> **Read this first.** Bulk messaging breaks WhatsApp's Terms of Service and your number
> can be banned. This tool slows sending down and enforces opt-outs to keep that risk
> low, but it cannot eliminate it. Message people who expect to hear from you.

## Run from source (for development)

```bash
npm install      # first time only
npm start        # desktop app
npm run serve    # browser-only, at http://localhost:3000
npm test         # engine + firebase-mode tests
npm run dist     # build the Windows installer into dist/
```

1. **Connection** — click Connect, scan the QR with WhatsApp → Settings → Linked devices.
2. **Contacts** — drop a CSV/XLSX (or paste numbers), pick the phone and name columns, Validate.
3. **Message** — write the text. `{{name}}` and any other column become variables.
4. **Send** — Build queue → Start. Watch the progress and the live log.

## Message features

| Syntax | Does |
|---|---|
| `{{name}}` | Inserts that contact's value. Any column works: `Full Name` → `{{full_name}}` |
| `{Hi\|Hello\|Hey}` | Picks one at random per message, so no two messages are identical |
| Attachment | One image/PDF/video, sent with your text as the caption |

## Defaults that keep your number alive

- 8–25 s random gap between messages
- 60–180 s rest every 40 messages
- 200 messages/day cap (drop this to ~30 on a brand-new number)
- Every number checked against WhatsApp before sending
- `STOP` / `UNSUBSCRIBE` replies auto-added to the opt-out list

All of these are editable in **Settings**.

## Contact file format

First row is the header. Any columns you like; you map them in the UI.

```csv
name,phone,city
Aman,9876543210,Delhi
Priya,+91 9123456789,Mumbai
```

Numbers without a country code get the default one from Settings (`91` out of the box).

## Where things are stored

| Path | Contents |
|---|---|
| `sessions/` | WhatsApp login. Deleting it forces a fresh QR scan |
| `data/` | Contacts, campaign state, history, opt-outs, settings |
| `uploads/` | Attachments |

None of these are committed — see `.gitignore`.

## Troubleshooting

**Stuck on "Authenticating" forever.** WhatsApp Web changed and the library is behind.
`npm install whatsapp-web.js@latest`, delete `sessions/`, restart.

**Browser won't launch.** Point it at a local Chrome:
```powershell
$env:CHROME_PATH = "C:\Program Files\Google\Chrome\Application\chrome.exe"; npm start
```

**Port 3000 in use.** `$env:PORT = 3100; npm start`

**Messages failing after a while.** You are being rate-limited. Stop, wait a day,
raise the delays and lower the cap.

## Accounts and the dashboard

The app runs in one of two modes, set by `src/config.js`:

- **local** (default, nothing configured) — accounts live on the user's machine, passwords
  are scrypt-hashed, nothing is uploaded, and there is no dashboard.
- **firebase** — accounts live in Firebase Auth, Google sign-in works out of the box, and
  usage counts appear in a Dashboard tab visible only to the admin account.

See [FIREBASE_SETUP.md](FIREBASE_SETUP.md) to switch it on. Even in firebase mode,
**contacts, phone numbers and message text never leave the user's computer** — only
counts and account identity are uploaded. Passwords are handled by Google and are never
stored by, or visible to, the app owner.

## Docs

- `PRD.md` — what this is and what it must do
- `PROGRESS.md` — architecture, work graph, decisions, and where to pick up
- `FIREBASE_SETUP.md` — one-time Firebase setup for accounts + dashboard
- `firestore.rules` — database permissions (publish these before going live)
