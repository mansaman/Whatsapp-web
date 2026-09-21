# WhatsApp Bulk Sender

A local app that sends WhatsApp messages to a list of contacts through **your own**
WhatsApp Web session. No API keys, no business verification — you scan a QR code
exactly like you do for WhatsApp Web.

> **Read this first.** Bulk messaging breaks WhatsApp's Terms of Service and your number
> can be banned. This tool slows sending down and enforces opt-outs to keep that risk
> low, but it cannot eliminate it. Message people who expect to hear from you.

## Run it

```bash
npm install     # first time only
npm start
```

Your browser opens at <http://localhost:3000>.

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

## Docs

- `PRD.md` — what this is and what it must do
- `PROGRESS.md` — architecture, work graph, decisions, and where to pick up
