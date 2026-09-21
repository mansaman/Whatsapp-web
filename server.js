const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const multer = require('multer');
const { Server } = require('socket.io');

const store = require('./src/store');
const auth = require('./src/auth');
const telemetry = require('./src/telemetry');
const google = require('./src/google');
const firebase = require('./src/firebase');
const paths = require('./src/paths');
const { config } = require('./src/config');
const wa = require('./src/whatsapp');
const campaign = require('./src/campaign');
const contactsLib = require('./src/contacts');
const { render, usedVariables } = require('./src/template');

const UPLOAD_DIR = paths.UPLOAD_DIR;
paths.ensureDirs();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 30 * 1024 * 1024 },
});

// ---------------------------------------------------------------- log buffer

const logBuffer = [];
function pushLog(entry) {
  const item =
    typeof entry === 'string'
      ? { message: entry, level: 'info', at: new Date().toISOString() }
      : entry;
  logBuffer.push(item);
  if (logBuffer.length > 500) logBuffer.shift();
  io.emit('log', item);
}

wa.on('status', (s) => io.emit('wa:status', s));
wa.on('log', pushLog);
wa.on('optout', () => io.emit('optouts', store.getOptOuts()));
campaign.on('progress', (p) => io.emit('campaign:progress', p));
campaign.on('log', pushLog);

// ---------------------------------------------------------------- sockets

io.use((socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  if (!token || !auth.verify(token)) return next(new Error('Not signed in.'));
  next();
});

io.on('connection', (socket) => {
  socket.emit('wa:status', wa.status());
  socket.emit('campaign:progress', campaign.snapshot());
  socket.emit('logs:bulk', logBuffer.slice(-200));
});

// ---------------------------------------------------------------- helpers

function ok(res, data) {
  res.json({ ok: true, ...data });
}
function fail(res, err, code = 400) {
  res.status(code).json({ ok: false, error: err.message || String(err) });
}

// ---------------------------------------------------------------- auth

/** Everything under /api needs a session, except the auth endpoints themselves. */
app.use('/api', auth.middleware);

app.get('/api/auth/state', (req, res) =>
  ok(res, {
    mode: auth.mode(),
    registered: auth.isRegistered(),
    account: auth.publicAccount(),
    googleEnabled: google.isConfigured(),
    isAdmin: isAdminAccount(),
  })
);

/** Let a returning user back in from the saved session, without a password. */
app.post('/api/auth/restore', async (req, res) => {
  try {
    const result = await auth.restore();
    if (!result) return res.status(401).json({ ok: false, error: 'No saved session.', authRequired: true });
    ok(res, result);
  } catch (err) {
    fail(res, err, 401);
  }
});

app.post('/api/auth/reset', async (req, res) => {
  try {
    await auth.sendPasswordReset(req.body && req.body.email);
    ok(res, {});
  } catch (err) {
    fail(res, err);
  }
});

/**
 * The dashboard only exists in firebase mode - in local mode there is no shared data
 * to read, so the tab must not appear at all, even for the admin's own email.
 */
function isAdminAccount() {
  if (auth.mode() !== 'firebase') return false;
  const account = auth.publicAccount();
  return !!(
    account &&
    account.email &&
    account.email === String(config.adminEmail).trim().toLowerCase()
  );
}

app.post('/api/auth/signup', async (req, res) => {
  try {
    ok(res, await auth.signup(req.body || {}));
  } catch (err) {
    fail(res, err);
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    ok(res, await auth.login(req.body || {}));
  } catch (err) {
    fail(res, err, 401);
  }
});

app.post('/api/auth/logout', (req, res) => {
  const header = req.get('authorization') || '';
  auth.signOut(header.startsWith('Bearer ') ? header.slice(7) : null);
  ok(res, {});
});

app.post('/api/auth/password', async (req, res) => {
  try {
    await auth.changePassword(req.body || {});
    ok(res, {});
  } catch (err) {
    fail(res, err);
  }
});

/** Google sign-in: hand the browser a consent URL that redirects back to us. */
app.get('/api/auth/google/start', (req, res) => {
  try {
    const redirectUri = `http://localhost:${activePort}/api/auth/google/callback`;
    const { url } = google.buildAuthUrl(redirectUri);
    res.redirect(url);
  } catch (err) {
    res.status(400).send(errorPage(err.message));
  }
});

app.get('/api/auth/google/callback', async (req, res) => {
  try {
    if (req.query.error) throw new Error(`Google returned: ${req.query.error}`);
    const redirectUri = `http://localhost:${activePort}/api/auth/google/callback`;
    const identity = await google.exchange({
      code: req.query.code,
      state: req.query.state,
      redirectUri,
    });
    const { token } = await auth.loginWithGoogleToken(identity);
    // Hand the token back to the app window and close this one.
    res.send(`<!doctype html><meta charset="utf-8"><title>Signed in</title>
      <body style="font-family:system-ui;background:#0e1117;color:#e6edf3;display:grid;place-items:center;height:100vh;margin:0">
      <div style="text-align:center">
        <h2 style="color:#25d366">Signed in as ${escapeHtml(identity.email)}</h2>
        <p>You can close this window.</p>
      </div>
      <script>
        try { localStorage.setItem('wa_token', ${JSON.stringify(token)}); } catch (e) {}
        if (window.opener) { try { window.opener.postMessage({ type: 'wa-auth', token: ${JSON.stringify(
          token
        )} }, '*'); } catch (e) {} }
        setTimeout(function () { window.close(); }, 1200);
      </script></body>`);
  } catch (err) {
    res.status(400).send(errorPage(err.message));
  }
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

function errorPage(message) {
  return `<!doctype html><meta charset="utf-8"><title>Sign-in failed</title>
    <body style="font-family:system-ui;background:#0e1117;color:#e6edf3;display:grid;place-items:center;height:100vh;margin:0">
    <div style="text-align:center;max-width:460px">
      <h2 style="color:#f4525f">Sign-in failed</h2>
      <p>${escapeHtml(message)}</p>
      <p style="color:#8b98a9;font-size:13px">Close this window and try again.</p>
    </div></body>`;
}

// ---------------------------------------------------------------- admin

/**
 * The dashboard. Only the admin account may read across users, and Firestore's own
 * rules enforce that too - this check is convenience, not the security boundary.
 */
function requireAdmin(req, res, next) {
  if (!isAdminAccount()) {
    return res.status(403).json({ ok: false, error: 'Admin only.' });
  }
  next();
}

app.get('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    const session = auth.currentSession();
    if (!session) throw new Error('Not signed in.');
    const users = await firebase.listUsers(session.idToken);
    const totals = users.reduce(
      (acc, u) => ({
        users: acc.users + 1,
        sent: acc.sent + (u.totalMessagesSent || 0),
        failed: acc.failed + (u.totalMessagesFailed || 0),
        campaigns: acc.campaigns + (u.totalCampaigns || 0),
      }),
      { users: 0, sent: 0, failed: 0, campaigns: 0 }
    );
    ok(res, { users, totals });
  } catch (err) {
    fail(res, err);
  }
});

app.get('/api/admin/users/:uid/events', requireAdmin, async (req, res) => {
  try {
    const session = auth.currentSession();
    if (!session) throw new Error('Not signed in.');
    ok(res, { events: await firebase.listEvents(session.idToken, req.params.uid, 100) });
  } catch (err) {
    fail(res, err);
  }
});

// ---------------------------------------------------------------- settings

app.get('/api/settings', (req, res) => ok(res, { settings: store.getSettings() }));

app.post('/api/settings', (req, res) => {
  try {
    const allowed = [
      'countryCode',
      'minDelaySec',
      'maxDelaySec',
      'restEvery',
      'restMinSec',
      'restMaxSec',
      'dailyCap',
      'verifyNumbers',
      'autoOptOut',
      'warningAcknowledged',
      'googleClientId',
      'googleClientSecret',
    ];
    const patch = {};
    for (const key of allowed) {
      if (req.body[key] === undefined) continue;
      patch[key] =
        typeof store.getSettings()[key] === 'number' ? Number(req.body[key]) : req.body[key];
    }
    ok(res, { settings: store.saveSettings(patch) });
  } catch (err) {
    fail(res, err);
  }
});

// ---------------------------------------------------------------- whatsapp

app.get('/api/wa/status', (req, res) => ok(res, { status: wa.status() }));
app.post('/api/wa/connect', async (req, res) => {
  try {
    ok(res, { status: await wa.start() });
  } catch (err) {
    fail(res, err);
  }
});
app.post('/api/wa/logout', async (req, res) => {
  try {
    campaign.stop();
    await wa.logout();
    ok(res, { status: wa.status() });
  } catch (err) {
    fail(res, err);
  }
});

// ---------------------------------------------------------------- contacts

app.get('/api/contacts', (req, res) => ok(res, { contacts: store.read('contacts.json') }));

/** Upload a CSV/XLSX: returns headers + a preview so the UI can map columns. */
app.post('/api/contacts/upload', upload.single('file'), (req, res) => {
  try {
    if (!req.file) throw new Error('No file uploaded.');
    const { headers, rows } = contactsLib.parseFile(req.file.path, req.file.originalname);
    fs.unlink(req.file.path, () => {});
    if (!rows.length) throw new Error('The file has no data rows.');

    const guess = guessMapping(headers);
    const saved = store.write('contacts.json', {
      fileName: req.file.originalname,
      headers,
      rows,
      mapping: guess,
      stats: null,
    });
    pushLog(`Loaded ${rows.length} rows from ${req.file.originalname}.`);
    ok(res, { contacts: { ...saved, rows: rows.slice(0, 10) }, rowCount: rows.length });
  } catch (err) {
    fail(res, err);
  }
});

/** Paste path: plain lines of numbers. */
app.post('/api/contacts/paste', (req, res) => {
  try {
    const { headers, rows } = contactsLib.parsePasted(req.body.text || '');
    if (!rows.length) throw new Error('Nothing to parse.');
    const saved = store.write('contacts.json', {
      fileName: 'pasted list',
      headers,
      rows,
      mapping: { number: 'number', name: 'name' },
      stats: null,
    });
    pushLog(`Loaded ${rows.length} pasted numbers.`);
    ok(res, { contacts: { ...saved, rows: rows.slice(0, 10) }, rowCount: rows.length });
  } catch (err) {
    fail(res, err);
  }
});

/** Apply the column mapping and validate -> the send-ready list. */
app.post('/api/contacts/map', (req, res) => {
  try {
    const stored = store.read('contacts.json');
    if (!stored.rows.length) throw new Error('Upload a contact list first.');
    const mapping = req.body.mapping || stored.mapping;
    if (!mapping.number) throw new Error('Pick which column holds the phone number.');

    const settings = store.getSettings();
    const { contacts, stats } = contactsLib.buildContacts(
      stored.rows,
      mapping,
      settings.countryCode,
      store.getOptOuts()
    );

    store.write('contacts.json', { ...stored, mapping, stats });
    ok(res, {
      stats,
      preview: contacts.slice(0, 10),
      variables: contacts.length ? Object.keys(contacts[0].vars) : [],
    });
  } catch (err) {
    fail(res, err);
  }
});

function guessMapping(headers) {
  const find = (patterns) =>
    headers.find((h) => patterns.some((p) => new RegExp(p, 'i').test(h))) || '';
  return {
    number: find(['^number$', 'phone', 'mobile', 'whats', 'contact', '^no$', 'msisdn']) || headers[0] || '',
    name: find(['^name$', 'first', 'full.?name', 'customer', 'person']) || '',
  };
}

// ---------------------------------------------------------------- message

app.get('/api/message', (req, res) => ok(res, { message: store.read('message.json') }));

app.post('/api/message', (req, res) => {
  try {
    const current = store.read('message.json');
    ok(res, {
      message: store.write('message.json', { ...current, body: req.body.body || '' }),
    });
  } catch (err) {
    fail(res, err);
  }
});

app.post('/api/message/media', upload.single('file'), (req, res) => {
  try {
    if (!req.file) throw new Error('No file uploaded.');
    const dest = path.join(UPLOAD_DIR, `media_${Date.now()}_${req.file.originalname}`);
    fs.renameSync(req.file.path, dest);
    const current = store.read('message.json');
    ok(res, {
      message: store.write('message.json', {
        ...current,
        mediaPath: dest,
        mediaName: req.file.originalname,
      }),
    });
  } catch (err) {
    fail(res, err);
  }
});

app.delete('/api/message/media', (req, res) => {
  const current = store.read('message.json');
  if (current.mediaPath) fs.unlink(current.mediaPath, () => {});
  ok(res, { message: store.write('message.json', { ...current, mediaPath: null, mediaName: null }) });
});

/** Render the template against the first mapped contact. */
app.post('/api/message/preview', (req, res) => {
  try {
    const body = req.body.body || '';
    const stored = store.read('contacts.json');
    let vars = { name: 'Sample Name', number: '910000000000' };
    if (stored.rows.length && stored.mapping.number) {
      const settings = store.getSettings();
      const { contacts } = contactsLib.buildContacts(
        stored.rows.slice(0, 1),
        stored.mapping,
        settings.countryCode,
        []
      );
      if (contacts.length) vars = contacts[0].vars;
    }
    ok(res, {
      preview: render(body, vars),
      variables: usedVariables(body),
      available: Object.keys(vars),
    });
  } catch (err) {
    fail(res, err);
  }
});

// ---------------------------------------------------------------- campaign

app.get('/api/campaign', (req, res) => ok(res, { campaign: campaign.snapshot() }));

app.post('/api/campaign/create', (req, res) => {
  try {
    const stored = store.read('contacts.json');
    if (!stored.rows.length) throw new Error('Upload a contact list first.');
    const settings = store.getSettings();
    const { contacts } = contactsLib.buildContacts(
      stored.rows,
      stored.mapping,
      settings.countryCode,
      store.getOptOuts()
    );
    const message = store.read('message.json');
    const snap = campaign.create(contacts, message, settings);
    pushLog(`Campaign queued: ${contacts.length} contacts.`);
    ok(res, { campaign: snap });
  } catch (err) {
    fail(res, err);
  }
});

app.post('/api/campaign/start', (req, res) => {
  try {
    if (!wa.isReady()) throw new Error('Connect WhatsApp first.');
    ok(res, { campaign: campaign.start() });
  } catch (err) {
    fail(res, err);
  }
});
app.post('/api/campaign/pause', (req, res) => ok(res, { campaign: campaign.pause() }));
app.post('/api/campaign/stop', (req, res) => ok(res, { campaign: campaign.stop() }));
app.post('/api/campaign/clear', (req, res) => {
  try {
    campaign.clear();
    ok(res, { campaign: campaign.snapshot() });
  } catch (err) {
    fail(res, err);
  }
});

app.get('/api/campaign/items', (req, res) => {
  const items = campaign.state ? campaign.state.items : [];
  ok(res, { items });
});

app.get('/api/campaign/report.csv', (req, res) => {
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="whatsapp-report.csv"');
  res.send(campaign.reportCsv());
});

app.get('/api/history', (req, res) => ok(res, { history: store.read('history.json') }));

// ---------------------------------------------------------------- opt-outs

app.get('/api/optouts', (req, res) => ok(res, { optouts: store.getOptOuts() }));
app.post('/api/optouts', (req, res) => {
  const numbers = String(req.body.numbers || '')
    .split(/[\s,;\n]+/)
    .map((n) => contactsLib.normalizeNumber(n, store.getSettings().countryCode))
    .filter(Boolean);
  numbers.forEach(store.addOptOut);
  ok(res, { optouts: store.getOptOuts() });
});
app.delete('/api/optouts/:number', (req, res) =>
  ok(res, { optouts: store.removeOptOut(req.params.number) })
);

// ---------------------------------------------------------------- boot

let activePort = Number(process.env.PORT) || 3000;

/**
 * Start listening. Electron calls this and waits for the resolved URL before
 * pointing its window at the app; `npm start` calls it from bin/serve.js.
 */
function startServer({ port = activePort, openBrowser = false } = {}) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', async () => {
      activePort = server.address().port;
      const url = `http://localhost:${activePort}`;
      console.log('');
      console.log('  WhatsApp Bulk Sender is running');
      console.log(`  Open ${url} in your browser`);
      console.log('  Press Ctrl+C to stop');
      console.log('');
      pushLog('Server started.');

      const resumed = campaign.snapshot();
      if (resumed.active && resumed.counts.pending > 0) {
        pushLog(
          `Found an unfinished campaign: ${resumed.counts.pending} contact(s) still pending. Open the Send tab to resume.`,
          'warn'
        );
      }

      if (openBrowser) {
        try {
          const open = (await import('open')).default;
          await open(url);
        } catch {
          /* the user can open it manually */
        }
      }
      resolve({ url, port: activePort });
    });
  });
}

async function shutdown() {
  campaign.stop();
  try {
    await wa.destroy();
  } catch {
    /* best effort */
  }
}

process.on('SIGINT', async () => {
  console.log('Stopping...');
  await shutdown();
  process.exit(0);
});

module.exports = { app, server, startServer, shutdown, getPort: () => activePort };
