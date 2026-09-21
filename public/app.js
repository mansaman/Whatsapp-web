/* WhatsApp Bulk Sender — front end */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

let token = null;
try {
  token = localStorage.getItem('wa_token');
} catch {
  /* storage can be blocked; the user just signs in again */
}

let socket = null;
let settings = {};
let contactsMeta = { headers: [], mapping: {}, fileName: null };
let lastProgress = { active: false };

// ------------------------------------------------------------ helpers

async function api(path, options = {}) {
  const headers = options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`/api${path}`, { ...options, headers });
  const data = await res.json().catch(() => ({ ok: false, error: 'Bad response' }));

  // The session died (app restarted, token expired) - fall back to the sign-in screen.
  if (res.status === 401 && data.authRequired) {
    clearToken();
    showAuth();
    throw new Error(data.error || 'Not signed in.');
  }
  if (!data.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function setToken(value) {
  token = value;
  try {
    localStorage.setItem('wa_token', value);
  } catch {}
}

function clearToken() {
  token = null;
  try {
    localStorage.removeItem('wa_token');
  } catch {}
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}

let toastTimer;
function toast(msg, bad = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('bad', bad);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3800);
}

function fmtDuration(sec) {
  if (!sec || sec < 0) return '—';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

// ------------------------------------------------------------ first-run warning

function initWarning() {
  if (settings.warningAcknowledged) return;
  $('#warningModal').hidden = false;
  $('#warnAck').addEventListener('change', (e) => {
    $('#warnContinue').disabled = !e.target.checked;
  });
  $('#warnContinue').addEventListener('click', async () => {
    await api('/settings', { method: 'POST', body: JSON.stringify({ warningAcknowledged: true }) });
    $('#warningModal').hidden = true;
  });
}

// ------------------------------------------------------------ tabs

$$('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('.nav-item').forEach((b) => b.classList.remove('active'));
    $$('.tab').forEach((t) => t.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    $(`#tab-${tab}`).classList.add('active');
    $('#pageTitle').textContent = btn.textContent.trim().replace(/^[0-9⚙↺]\s*/, '');
    if (tab === 'history') loadHistory();
    if (tab === 'admin') loadAdmin();
  });
});

// ------------------------------------------------------------ live socket

function connectSocket() {
  if (socket) return;
  socket = io({ auth: { token } });

  socket.on('wa:status', renderWaStatus);
  socket.on('campaign:progress', renderProgress);
  socket.on('optouts', renderOptOuts);
  socket.on('log', addLog);
  socket.on('logs:bulk', (items) => {
    $('#logBox').innerHTML = '';
    items.forEach(addLog);
  });

  socket.on('connect_error', (err) => {
    // The only reason the handshake is refused is a dead session.
    if (/signed in/i.test(err.message)) {
      clearToken();
      showAuth();
    }
  });
}

// ------------------------------------------------------------ connection

function renderWaStatus(s) {
  const pill = $('#statusPill');
  const labels = {
    disconnected: 'Disconnected',
    starting: 'Starting…',
    qr: 'Scan the QR code',
    authenticating: 'Authenticating…',
    ready: 'Connected',
  };
  // classList.add('') throws, which used to abort the rest of this function
  // and leave the whole status panel stale.
  const tone =
    s.state === 'ready' ? 'ready' : s.state === 'disconnected' ? (s.lastError ? 'error' : '') : 'pending';
  pill.className = tone ? `status-pill ${tone}` : 'status-pill';

  $('#statusText').textContent = labels[s.state] || s.state;
  $('#accState').textContent = s.state;
  $('#accName').textContent = s.me?.name || '—';
  $('#accNumber').textContent = s.me?.number ? '+' + s.me.number : '—';

  const err = $('#accError');
  err.hidden = !s.lastError;
  err.textContent = s.lastError || '';
  err.className = 'note bad';

  const img = $('#qrImage');
  const ph = $('#qrPlaceholder');
  if (s.qr) {
    img.src = s.qr;
    img.hidden = false;
    ph.hidden = true;
  } else {
    img.hidden = true;
    ph.hidden = false;
    ph.textContent =
      s.state === 'ready'
        ? '✅ Linked — you can close this tab’s QR step.'
        : s.state === 'disconnected'
        ? 'Not connected'
        : 'Loading…';
  }
  $('#btnConnect').disabled = s.state !== 'disconnected';
}

$('#btnConnect').addEventListener('click', async () => {
  try {
    $('#btnConnect').disabled = true;
    await api('/wa/connect', { method: 'POST' });
    toast('Starting the browser session — the QR takes a few seconds.');
  } catch (e) {
    toast(e.message, true);
  }
});

$('#btnLogout').addEventListener('click', async () => {
  if (!confirm('Log out and clear the saved session? You will need to scan the QR again.')) return;
  try {
    await api('/wa/logout', { method: 'POST' });
    toast('Logged out.');
  } catch (e) {
    toast(e.message, true);
  }
});

// ------------------------------------------------------------ contacts

const dropZone = $('#dropZone');
const fileInput = $('#fileInput');

dropZone.addEventListener('click', () => fileInput.click());
['dragenter', 'dragover'].forEach((ev) =>
  dropZone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropZone.classList.add('over');
  })
);
['dragleave', 'drop'].forEach((ev) =>
  dropZone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropZone.classList.remove('over');
  })
);
dropZone.addEventListener('drop', (e) => {
  if (e.dataTransfer.files[0]) uploadContacts(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) uploadContacts(fileInput.files[0]);
});

async function uploadContacts(file) {
  const fd = new FormData();
  fd.append('file', file);
  try {
    const { contacts, rowCount } = await api('/contacts/upload', { method: 'POST', body: fd });
    contactsMeta = contacts;
    renderMapping(rowCount);
    toast(`Loaded ${rowCount} rows.`);
  } catch (e) {
    toast(e.message, true);
  }
}

$('#btnPaste').addEventListener('click', async () => {
  const text = $('#pasteBox').value.trim();
  if (!text) return toast('Paste some numbers first.', true);
  try {
    const { contacts, rowCount } = await api('/contacts/paste', {
      method: 'POST',
      body: JSON.stringify({ text }),
    });
    contactsMeta = contacts;
    renderMapping(rowCount);
    toast(`Loaded ${rowCount} numbers.`);
  } catch (e) {
    toast(e.message, true);
  }
});

function renderMapping(rowCount) {
  $('#mapCard').hidden = false;
  $('#fileChip').textContent = `${contactsMeta.fileName} · ${rowCount ?? contactsMeta.rows?.length ?? 0} rows`;

  const fill = (sel, allowBlank) => {
    const el = $(sel);
    el.innerHTML = '';
    if (allowBlank) el.append(new Option('— none —', ''));
    contactsMeta.headers.forEach((h) => el.append(new Option(h, h)));
  };
  fill('#mapNumber', false);
  fill('#mapName', true);
  $('#mapNumber').value = contactsMeta.mapping.number || contactsMeta.headers[0] || '';
  $('#mapName').value = contactsMeta.mapping.name || '';
  $('#mapCC').value = settings.countryCode || '91';
}

$('#btnValidate').addEventListener('click', async () => {
  try {
    const cc = $('#mapCC').value.trim();
    if (cc !== settings.countryCode) {
      const r = await api('/settings', { method: 'POST', body: JSON.stringify({ countryCode: cc }) });
      settings = r.settings;
    }
    const mapping = { number: $('#mapNumber').value, name: $('#mapName').value };
    const { stats, preview, variables } = await api('/contacts/map', {
      method: 'POST',
      body: JSON.stringify({ mapping }),
    });

    $('#statsRow').hidden = false;
    $('#stTotal').textContent = stats.total;
    $('#stValid').textContent = stats.valid;
    $('#stDup').textContent = stats.duplicates;
    $('#stInvalid').textContent = stats.invalid;
    $('#stOpt').textContent = stats.optedOut;

    const hint = $('#varsHint');
    hint.hidden = !variables.length;
    hint.className = 'note';
    hint.innerHTML =
      'Available variables: ' + variables.map((v) => `<code>{{${v}}}</code>`).join(' ');

    renderPreviewTable(preview);

    const iw = $('#invalidWrap');
    if (stats.invalid) {
      iw.hidden = false;
      iw.innerHTML =
        `<b>${stats.invalid} row(s) skipped.</b> First few: ` +
        stats.invalidSample.map((s) => `row ${s.row} ("${s.value}")`).join(', ');
    } else {
      iw.hidden = true;
    }

    toast(`${stats.valid} contacts ready.`);
    refreshPreview();
  } catch (e) {
    toast(e.message, true);
  }
});

function renderPreviewTable(rows) {
  const wrap = $('#previewWrap');
  const table = $('#previewTable');
  if (!rows.length) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  // 'number' already has its own column, and it is not useful as a preview variable
  const cols = Object.keys(rows[0].vars).filter((c) => c !== 'number');
  table.querySelector('thead').innerHTML =
    '<tr><th>number</th>' + cols.map((c) => `<th>${esc(c)}</th>`).join('') + '</tr>';
  table.querySelector('tbody').innerHTML = rows
    .map(
      (r) =>
        `<tr><td>+${esc(r.number)}</td>` +
        cols.map((c) => `<td>${esc(r.vars[c])}</td>`).join('') +
        '</tr>'
    )
    .join('');
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ------------------------------------------------------------ message

const msgBody = $('#msgBody');
let previewTimer;

msgBody.addEventListener('input', () => {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(refreshPreview, 350);
});

$$('[data-insert]').forEach((btn) =>
  btn.addEventListener('click', () => {
    const text = btn.dataset.insert;
    const start = msgBody.selectionStart;
    msgBody.value = msgBody.value.slice(0, start) + text + msgBody.value.slice(msgBody.selectionEnd);
    msgBody.focus();
    msgBody.selectionStart = msgBody.selectionEnd = start + text.length;
    refreshPreview();
  })
);

async function refreshPreview() {
  const body = msgBody.value;
  try {
    await api('/message', { method: 'POST', body: JSON.stringify({ body }) });
    const { preview, variables, available } = await api('/message/preview', {
      method: 'POST',
      body: JSON.stringify({ body }),
    });
    $('#previewBubble').textContent = preview || 'Your message will appear here.';
    const unknown = variables.filter((v) => !available.includes(v));
    $('#varList').textContent = unknown.length
      ? `⚠ unknown variable(s): ${unknown.join(', ')}`
      : available.length
      ? `available: ${available.join(', ')}`
      : '';
  } catch (e) {
    /* preview is best-effort */
  }
}

$('#btnMediaUpload').addEventListener('click', async () => {
  const file = $('#mediaInput').files[0];
  if (!file) return toast('Pick a file first.', true);
  const fd = new FormData();
  fd.append('file', file);
  try {
    const { message } = await api('/message/media', { method: 'POST', body: fd });
    renderMedia(message);
    toast('Attachment added.');
  } catch (e) {
    toast(e.message, true);
  }
});

$('#btnMediaClear').addEventListener('click', async () => {
  const { message } = await api('/message/media', { method: 'DELETE' });
  $('#mediaInput').value = '';
  renderMedia(message);
});

function renderMedia(message) {
  const has = !!message.mediaName;
  $('#mediaName').textContent = has ? `Attached: ${message.mediaName}` : 'No attachment.';
  $('#btnMediaClear').hidden = !has;
}

// ------------------------------------------------------------ campaign

function renderProgress(p) {
  lastProgress = p;
  const running = p.active && p.status === 'running';

  $('#btnStart').disabled = !p.active || running || p.counts?.pending === 0;
  $('#btnPause').disabled = !running;
  $('#btnStop').disabled = !running;
  $('#btnExport').disabled = !p.active;
  $('#btnClear').disabled = !p.active || running;

  if (!p.active) {
    $('#progLabel').textContent = 'No campaign queued.';
    $('#progPct').textContent = '0%';
    $('#progBar').style.width = '0%';
    ['cSent', 'cFailed', 'cSkipped', 'cPending'].forEach((id) => ($(`#${id}`).textContent = '0'));
    $('#cEta').textContent = '—';
    $('#currentBox').hidden = true;
    return;
  }

  const statusLabel = {
    running: 'Running',
    paused: 'Paused',
    stopped: 'Stopped',
    done: 'Finished',
  }[p.status] || p.status;

  $('#progLabel').textContent = `${statusLabel} — ${p.done} of ${p.total}`;
  $('#progPct').textContent = `${p.percent}%`;
  $('#progBar').style.width = `${p.percent}%`;
  $('#cSent').textContent = p.counts.sent;
  $('#cFailed').textContent = p.counts.failed;
  $('#cSkipped').textContent = p.counts.skipped;
  $('#cPending').textContent = p.counts.pending;
  $('#cEta').textContent = running ? fmtDuration(p.etaSeconds) : '—';

  const box = $('#currentBox');
  if (running && p.current) {
    box.hidden = false;
    $('#currentWho').textContent = p.current.name
      ? `${p.current.name} (+${p.current.number})`
      : `+${p.current.number}`;
    $('#currentWait').textContent = p.waitSecondsLeft
      ? `Next message in ${p.waitSecondsLeft}s`
      : 'Sending…';
  } else {
    box.hidden = true;
  }
}

$('#btnBuild').addEventListener('click', async () => {
  try {
    const { campaign } = await api('/campaign/create', { method: 'POST' });
    renderProgress(campaign);
    toast(`Queue built: ${campaign.total} contacts.`);
  } catch (e) {
    toast(e.message, true);
  }
});

$('#btnStart').addEventListener('click', async () => {
  const pending = lastProgress.counts?.pending ?? 0;
  if (!confirm(`Start sending to ${pending} contact(s)?`)) return;
  try {
    await api('/campaign/start', { method: 'POST' });
  } catch (e) {
    toast(e.message, true);
  }
});
$('#btnPause').addEventListener('click', () => api('/campaign/pause', { method: 'POST' }).catch(() => {}));
$('#btnStop').addEventListener('click', () => {
  if (confirm('Stop this campaign? Pending contacts stay pending.')) {
    api('/campaign/stop', { method: 'POST' }).catch(() => {});
  }
});
$('#btnClear').addEventListener('click', async () => {
  if (!confirm('Clear the campaign and its results?')) return;
  try {
    await api('/campaign/clear', { method: 'POST' });
    toast('Campaign cleared.');
  } catch (e) {
    toast(e.message, true);
  }
});
$('#btnExport').addEventListener('click', () => window.open('/api/campaign/report.csv'));

// ------------------------------------------------------------ logs

function addLog(entry) {
  const box = $('#logBox');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  const div = document.createElement('div');
  div.className = `log-line ${entry.level || 'info'}`;
  const time = new Date(entry.at || Date.now()).toLocaleTimeString('en-GB', { hour12: false });
  div.innerHTML = `<span class="log-time">${time}</span><span class="log-msg">${esc(entry.message)}</span>`;
  box.appendChild(div);
  while (box.children.length > 400) box.removeChild(box.firstChild);
  if (atBottom) box.scrollTop = box.scrollHeight;
}

$('#btnClearLog').addEventListener('click', () => ($('#logBox').innerHTML = ''));

// ------------------------------------------------------------ settings

function renderSettings(s) {
  settings = s;
  $('#setMin').value = s.minDelaySec;
  $('#setMax').value = s.maxDelaySec;
  $('#setRestEvery').value = s.restEvery;
  $('#setRestMin').value = s.restMinSec;
  $('#setRestMax').value = s.restMaxSec;
  $('#setCap').value = s.dailyCap;
  $('#setCC').value = s.countryCode;
  $('#setVerify').checked = !!s.verifyNumbers;
  $('#setAutoOpt').checked = !!s.autoOptOut;
  $('#setGoogleId').value = s.googleClientId || '';
  $('#setGoogleSecret').value = s.googleClientSecret || '';

  const pct = Math.min(100, Math.round((s.sentToday / s.dailyCap) * 100));
  $('#capText').textContent = `${s.sentToday} / ${s.dailyCap}`;
  $('#capBar').style.width = `${pct}%`;
}

$('#btnSaveSettings').addEventListener('click', async () => {
  try {
    const { settings: s } = await api('/settings', {
      method: 'POST',
      body: JSON.stringify({
        minDelaySec: $('#setMin').value,
        maxDelaySec: $('#setMax').value,
        restEvery: $('#setRestEvery').value,
        restMinSec: $('#setRestMin').value,
        restMaxSec: $('#setRestMax').value,
        dailyCap: $('#setCap').value,
        countryCode: $('#setCC').value.trim(),
        verifyNumbers: $('#setVerify').checked,
        autoOptOut: $('#setAutoOpt').checked,
      }),
    });
    renderSettings(s);
    toast('Settings saved.');
  } catch (e) {
    toast(e.message, true);
  }
});

// ------------------------------------------------------------ opt-outs

function renderOptOuts(list) {
  $('#optList').innerHTML = list.length
    ? list.map((n) => `<span class="chip" data-number="${esc(n)}">+${esc(n)} ✕</span>`).join('')
    : '<span class="muted small">Nobody opted out yet.</span>';
  $$('#optList .chip').forEach((chip) =>
    chip.addEventListener('click', async () => {
      await fetch(`/api/optouts/${chip.dataset.number}`, { method: 'DELETE' });
      loadOptOuts();
    })
  );
}

$('#btnAddOpt').addEventListener('click', async () => {
  const numbers = $('#optAdd').value.trim();
  if (!numbers) return;
  const { optouts } = await api('/optouts', { method: 'POST', body: JSON.stringify({ numbers }) });
  $('#optAdd').value = '';
  renderOptOuts(optouts);
  toast('Added to opt-out list.');
});

async function loadOptOuts() {
  const { optouts } = await api('/optouts');
  renderOptOuts(optouts);
}

// ------------------------------------------------------------ history

async function loadHistory() {
  const { history } = await api('/history');
  const tbody = $('#historyTable').querySelector('tbody');
  tbody.innerHTML = history.length
    ? history
        .map(
          (h) => `<tr>
            <td>${new Date(h.finishedAt).toLocaleString()}</td>
            <td>${h.total}</td><td>${h.counts.sent}</td>
            <td>${h.counts.failed}</td><td>${h.counts.skipped}</td>
            <td>${esc(h.preview)}</td></tr>`
        )
        .join('')
    : '<tr><td colspan="6" class="muted">No campaigns yet.</td></tr>';
}

// ------------------------------------------------------------ sign in / sign up

let authMode = 'signup'; // or 'login'

function showAuth() {
  $('#appShell').hidden = true;
  $('#authScreen').hidden = false;
}

function showApp() {
  $('#authScreen').hidden = true;
  $('#appShell').hidden = false;
}

function authError(message) {
  const el = $('#authError');
  el.hidden = !message;
  el.textContent = message || '';
}

function renderAuthMode(state) {
  authMode = state.registered ? 'login' : 'signup';
  const signingUp = authMode === 'signup';

  $('#authSub').textContent = signingUp
    ? 'Create your account to get started'
    : `Welcome back${state.account && state.account.name ? ', ' + state.account.name : ''}`;
  $('#authSubmit').textContent = signingUp ? 'Create account' : 'Sign in';
  $('#nameField').hidden = !signingUp;
  $('#authPassword').setAttribute('autocomplete', signingUp ? 'new-password' : 'current-password');
  $('#authPassword').placeholder = signingUp ? 'At least 8 characters' : 'Your password';

  if (!signingUp && state.account) {
    $('#authEmail').value = state.account.email;
  }

  const firebaseMode = state.mode === 'firebase';
  if (firebaseMode) {
    $('#authFoot').innerHTML = signingUp
      ? 'We store your email and how much you use the app. Your contacts and messages stay on this computer and are never uploaded.'
      : 'Forgotten it? <span class="auth-switch" id="resetLink">Email me a reset link</span>';
  } else {
    $('#authFoot').innerHTML = signingUp
      ? 'Your account is stored only on this computer. There is no server and nothing is uploaded anywhere.'
      : 'Signed up with a different email? <span class="auth-switch" id="resetHint">Where is my account stored?</span>';
  }

  const resetLink = $('#resetLink');
  if (resetLink) {
    resetLink.addEventListener('click', async () => {
      const email = $('#authEmail').value.trim();
      if (!email) return authError('Type your email address first.');
      try {
        await api('/auth/reset', { method: 'POST', body: JSON.stringify({ email }) });
        authError('');
        toast('Reset link sent — check your inbox.');
      } catch (err) {
        authError(err.message);
      }
    });
  }

  const hint = $('#resetHint');
  if (hint) {
    hint.addEventListener('click', () =>
      alert(
        'Your account lives in account.json inside the app data folder ' +
          '(File > Open data folder). Deleting that file lets you sign up again, ' +
          'but it does not touch your WhatsApp session or contacts.'
      )
    );
  }

  const googleOn = !!state.googleEnabled;
  $('#googleWrap').hidden = !googleOn;
  $('#btnGoogle').hidden = !googleOn;
}

$('#authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  authError('');
  const btn = $('#authSubmit');
  btn.disabled = true;
  try {
    const payload = {
      email: $('#authEmail').value.trim(),
      password: $('#authPassword').value,
      name: $('#authName').value.trim(),
    };
    const path = authMode === 'signup' ? '/auth/signup' : '/auth/login';
    const { token: newToken } = await api(path, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    setToken(newToken);
    $('#authPassword').value = '';
    await enterApp();
  } catch (err) {
    authError(err.message);
  } finally {
    btn.disabled = false;
  }
});

$('#btnGoogle').addEventListener('click', () => {
  // The callback page hands the token back through postMessage.
  window.open('/api/auth/google/start', 'wa-google', 'width=520,height=640');
});

window.addEventListener('message', async (event) => {
  if (event.origin !== window.location.origin) return;
  if (!event.data || event.data.type !== 'wa-auth' || !event.data.token) return;
  setToken(event.data.token);
  await enterApp();
});

// ------------------------------------------------------------ account settings

$('#btnSignOut').addEventListener('click', async () => {
  if (!confirm('Sign out of the app? Your WhatsApp link and data stay on this computer.')) return;
  try {
    await api('/auth/logout', { method: 'POST' });
  } catch {
    /* signing out locally is what matters */
  }
  clearToken();
  location.reload();
});

$('#btnChangePw').addEventListener('click', async () => {
  const currentPassword = prompt('Current password:');
  if (currentPassword === null) return;
  const newPassword = prompt('New password (at least 8 characters):');
  if (newPassword === null) return;
  try {
    await api('/auth/password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    toast('Password changed.');
  } catch (e) {
    toast(e.message, true);
  }
});

$('#btnSaveGoogle').addEventListener('click', async () => {
  try {
    const { settings: fresh } = await api('/settings', {
      method: 'POST',
      body: JSON.stringify({
        googleClientId: $('#setGoogleId').value.trim(),
        googleClientSecret: $('#setGoogleSecret').value.trim(),
      }),
    });
    settings = fresh;
    toast('Google settings saved. They apply at the next sign-in.');
  } catch (e) {
    toast(e.message, true);
  }
});

function renderAccount(account, mode) {
  if (!account) return;
  if (mode === 'firebase') $('#btnChangePw').hidden = true;
  $('#acctEmail').textContent = account.email;
  $('#acctProvider').textContent = account.provider === 'google' ? 'Google' : 'Email + password';
  $('#btnChangePw').hidden = false;
}

// ------------------------------------------------------------ admin dashboard

async function loadAdmin() {
  const note = $('#adminNote');
  try {
    const { users, totals } = await api('/admin/users');
    $('#adUsers').textContent = totals.users;
    $('#adSent').textContent = totals.sent;
    $('#adFailed').textContent = totals.failed;
    $('#adCampaigns').textContent = totals.campaigns;
    note.hidden = true;

    const tbody = $('#adminTable').querySelector('tbody');
    if (!users.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="muted">Nobody has signed in yet.</td></tr>';
      return;
    }

    users.sort((a, b) => String(b.lastSeenAt || '').localeCompare(String(a.lastSeenAt || '')));
    tbody.innerHTML = users
      .map(
        (u) => `<tr data-uid="${esc(u.uid)}" data-email="${esc(u.email)}" class="clickable">
          <td>${esc(u.email)}</td>
          <td>${esc(u.name || '—')}</td>
          <td>${esc(u.provider === 'google' ? 'Google' : 'Email')}</td>
          <td>${u.totalMessagesSent || 0}</td>
          <td>${u.totalMessagesFailed || 0}</td>
          <td>${u.totalCampaigns || 0}</td>
          <td>${u.lastSeenAt ? new Date(u.lastSeenAt).toLocaleString() : '—'}</td>
          <td>${esc(u.appVersion || '—')}</td>
        </tr>`
      )
      .join('');

    $('#adminTable tbody tr.clickable').forEach((row) =>
      row.addEventListener('click', () => loadEvents(row.dataset.uid, row.dataset.email))
    );
  } catch (e) {
    note.hidden = false;
    note.className = 'note bad';
    note.textContent = e.message;
  }
}

async function loadEvents(uid, email) {
  try {
    const { events } = await api(`/admin/users/${encodeURIComponent(uid)}/events`);
    $('#eventsCard').hidden = false;
    $('#eventsWho').textContent = email;
    const tbody = $('#eventsTable').querySelector('tbody');
    tbody.innerHTML = events.length
      ? events
          .map((ev) => {
            const { type, at, ...rest } = ev;
            const details = Object.entries(rest)
              .map(([k, v]) => `${k}: ${v}`)
              .join(', ');
            return `<tr><td>${at ? new Date(at).toLocaleString() : '—'}</td>
                    <td>${esc(type)}</td><td>${esc(details || '—')}</td></tr>`;
          })
          .join('')
      : '<tr><td colspan="3" class="muted">No activity recorded yet.</td></tr>';
  } catch (e) {
    toast(e.message, true);
  }
}

$('#btnRefreshAdmin').addEventListener('click', loadAdmin);
$('#btnCloseEvents').addEventListener('click', () => ($('#eventsCard').hidden = true));

// ------------------------------------------------------------ boot

/** Everything that needs a signed-in session. */
async function enterApp() {
  showApp();
  connectSocket();

  const { settings: s } = await api('/settings');
  renderSettings(s);
  initWarning();

  const state = await api('/auth/state');
  renderAccount(state.account, state.mode);
  $('#navAdmin').hidden = !state.isAdmin;

  const { message } = await api('/message');
  msgBody.value = message.body || '';
  renderMedia(message);

  const { contacts } = await api('/contacts');
  if (contacts.rows && contacts.rows.length) {
    contactsMeta = contacts;
    renderMapping(contacts.rows.length);
  }

  await loadOptOuts();
  refreshPreview();

  // keep the daily-cap meter honest while a run is going
  clearInterval(capTimer);
  capTimer = setInterval(async () => {
    try {
      const { settings: fresh } = await api('/settings');
      settings = fresh;
      const pct = Math.min(100, Math.round((fresh.sentToday / fresh.dailyCap) * 100));
      $('#capText').textContent = `${fresh.sentToday} / ${fresh.dailyCap}`;
      $('#capBar').style.width = `${pct}%`;
    } catch {}
  }, 15000);
}

let capTimer = null;

(async function init() {
  const state = await api('/auth/state');
  renderAuthMode(state);

  // An app token from this browser session.
  if (token) {
    try {
      await enterApp();
      return;
    } catch {
      clearToken();
    }
  }

  // No token, but the device remembers a signed-in account: get back in silently.
  if (state.mode === 'firebase' && state.registered) {
    try {
      const { token: restored } = await api('/auth/restore', { method: 'POST' });
      setToken(restored);
      await enterApp();
      return;
    } catch {
      /* expired, or offline past the grace window - fall through to the form */
    }
  }

  showAuth();
  $('#authEmail').focus();
})();
