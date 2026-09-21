# PRD — WhatsApp Bulk Sender (WhatsApp Web automation)

**Status:** v1 in development
**Owner:** Aman Sharma
**Last updated:** 2026-09-21

---

## 1. Problem

Sending the same (or lightly personalised) WhatsApp message to a list of people one-by-one
from the phone or WhatsApp Web is slow and error prone. There is no free way to do it from a
personal number without the WhatsApp Business Cloud API (paid, template approval, business
verification).

## 2. Goal

A locally-run desktop-style app that:
1. Logs in to the user's own WhatsApp account by scanning a QR code (same as WhatsApp Web).
2. Accepts a contact list (CSV / XLSX / paste) plus a message template.
3. Sends the message to each contact, safely paced, with live progress and a full log.

## 3. Non-goals (v1)

- Multi-account / multi-session at the same time.
- Receiving and auto-replying to inbound messages (only opt-out detection is in scope).
- Cloud hosting / multi-user SaaS. This runs on the user's own machine only.
- Anything that evades WhatsApp's spam detection. The app slows sending down, it does not hide it.

## 4. Users

Single user: the owner of the WhatsApp number. Non-technical enough that the app must be
GUI-first (double-click start, browser UI), not a CLI.

## 5. Core requirements

### 5.1 Session / login
- R1. Show a QR code in the GUI; user scans with WhatsApp > Linked devices.
- R2. Persist the session on disk (`sessions/`) so a restart does not require a re-scan.
- R3. Show connection state live: `disconnected / qr / authenticating / ready`.
- R4. "Log out" button that clears the stored session.

### 5.2 Contacts
- R5. Upload CSV or XLSX; first row is the header.
- R6. Also accept pasted numbers (one per line, optional `number,name`).
- R7. Column mapping UI: pick which column is the phone number, which is the name, and
  any extra columns become template variables.
- R8. Normalise numbers to E.164-ish digits, with a configurable default country code
  (e.g. 91) applied to numbers that lack one.
- R9. De-duplicate, and show a validation summary (valid / invalid / duplicate).
- R10. Verify each number is actually registered on WhatsApp before sending; skip and log
  those that are not.

### 5.3 Message composition
- R11. Free-text message body with `{{variable}}` placeholders resolved per contact
  (`{{name}}`, plus any extra column).
- R12. Spintax support: `{a|b|c}` picks one at random per message, so every message differs
  slightly. This materially reduces spam flagging.
- R13. Optional single media attachment (image / pdf / video) sent with a caption.
- R14. Live preview rendered against the first contact in the list.

### 5.4 Sending engine
- R15. Sequential queue, one message at a time.
- R16. Randomised delay between messages, configurable min/max (default 8–25 s).
- R17. Longer pause every N messages (default: 60–180 s rest every 40 messages).
- R18. Daily cap (default 200/day for a warmed number; lower for a new one).
- R19. Start / Pause / Resume / Stop, with progress surviving a pause.
- R20. Per-contact result recorded: `sent / failed / skipped_not_on_whatsapp / skipped_opted_out`,
  with the error text on failure.
- R21. Retry a failed contact at most once, at the end of the run.
- R22. Resume an interrupted campaign after an app restart (state is on disk).

### 5.5 Safety / compliance
- R23. Opt-out list: any number in `data/optout.json` is never messaged.
- R24. Inbound "STOP" / "UNSUBSCRIBE" from a contact adds them to the opt-out list automatically.
- R25. First-run warning screen about ToS and ban risk; must be acknowledged once.
- R26. Hard-block sending to a list larger than the remaining daily cap without an explicit override.

### 5.6 Reporting
- R27. Live dashboard: sent / failed / skipped / remaining, current contact, ETA.
- R28. Scrolling log with timestamps.
- R29. Export the run report as CSV.
- R30. Campaign history persisted across restarts.

## 6. Technical design

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node.js 24 | Already installed |
| WhatsApp | `whatsapp-web.js` (Puppeteer-driven WhatsApp Web) | Only free route from a personal number |
| Server | Express | Serves GUI + REST |
| Live updates | Socket.IO | QR, progress and logs are push-shaped |
| Storage | JSON files under `data/` | No native modules, no DB install, easy to inspect |
| Parsing | `xlsx` + `papaparse` | CSV and Excel in one UI |
| GUI | Plain HTML/CSS/JS served at `localhost:3000` | No build step; loads instantly, easy to hack on |

**Why not Electron in v1:** it triples install size and adds a build step for zero functional
gain — the browser UI is the same UI. Packaging as a desktop app is a v2 item.

### Data files
- `data/contacts.json` — the currently loaded list
- `data/campaign.json` — active campaign state (for resume)
- `data/history.json` — finished campaign summaries
- `data/optout.json` — opted-out numbers
- `data/settings.json` — delays, caps, country code
- `sessions/` — Puppeteer/WhatsApp auth state (never commit)

## 7. Risks

| Risk | Mitigation |
|---|---|
| Number banned for bulk messaging | Conservative defaults, spintax, opt-out, daily cap, in-app warning |
| `whatsapp-web.js` breaks on a WhatsApp Web update | Pin version; upgrade path documented in NOTES |
| Chromium download fails behind proxy/firewall | Document `PUPPETEER_SKIP_DOWNLOAD` + system Chrome path |
| User uploads a junk list | Validation + WhatsApp-registration check before sending |

## 8. Acceptance criteria

1. Fresh clone → `npm install` → `npm start` → browser opens → QR shown → scan → `ready`.
2. Upload a 5-row CSV, map columns, compose `Hi {{name}}`, preview correct.
3. Start → messages arrive with the right names, spaced by the configured delay.
4. Pause mid-run, restart the app, resume → continues from where it stopped.
5. A number not on WhatsApp is skipped and logged, not counted as failed.
6. Export CSV matches what the dashboard showed.

## 9. Roadmap after v1

- Electron packaging + installer
- Scheduled sends
- Multiple message variants A/B
- Per-contact attachments
- Inbound reply inbox
