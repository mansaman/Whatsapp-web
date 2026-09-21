/**
 * Firebase-mode tests, run against a stubbed Firebase so they need no project
 * and no network.
 *
 * Exercises the full auth flow
 * Verifies auth flow, the Firestore value encoding, telemetry queueing/flushing,
 * and that no personal data can reach the wire.
 */
process.env.WA_FIREBASE_API_KEY = 'test-key';
process.env.WA_FIREBASE_AUTH_DOMAIN = 'test.firebaseapp.com';
process.env.WA_FIREBASE_PROJECT_ID = 'test-project';
process.env.WA_ADMIN_EMAIL = 'tools@akoi.in';
process.env.WA_DATA_DIR = require('path').join(require('os').tmpdir(), 'wa-mock-' + Date.now());

const assert = require('assert');

// --- stub the network -------------------------------------------------------
const calls = [];
globalThis.fetch = async (url, options = {}) => {
  const body = options.body ? JSON.parse(String(options.body)) : null;
  calls.push({ url: String(url), method: options.method || 'GET', body });

  const json = (obj, okStatus = true) => ({
    ok: okStatus,
    status: okStatus ? 200 : 400,
    json: async () => obj,
  });

  if (url.includes(':signUp')) {
    return json({ localId: 'uid_123', email: body.email, idToken: 'id_1', refreshToken: 'ref_1', expiresIn: '3600' });
  }
  if (url.includes(':update')) return json({ displayName: body.displayName });
  if (url.includes(':signInWithPassword')) {
    if (body.password !== 'correcthorse') {
      return json({ error: { message: 'INVALID_PASSWORD' } }, false);
    }
    return json({ localId: 'uid_123', email: body.email, displayName: 'Aman', idToken: 'id_2', refreshToken: 'ref_2', expiresIn: '3600' });
  }
  if (url.includes(':signInWithIdp')) {
    return json({ localId: 'uid_g', email: 'g@gmail.com', displayName: 'G User', idToken: 'id_g', refreshToken: 'ref_g', expiresIn: '3600' });
  }
  if (url.includes('securetoken')) {
    return json({ user_id: 'uid_123', id_token: 'id_refreshed', refresh_token: 'ref_3', expires_in: '3600' });
  }
  if (url.includes('/documents/users/') && options.method === 'PATCH') return json({ fields: {} });
  if (url.includes('/events') && options.method === 'POST') return json({ name: 'ev' });
  if (url.includes('/documents/users?')) {
    return json({
      documents: [
        {
          name: 'projects/p/databases/(default)/documents/users/uid_123',
          fields: {
            email: { stringValue: 'tools@akoi.in' },
            totalMessagesSent: { integerValue: '42' },
            totalCampaigns: { integerValue: '3' },
            lastSeenAt: { stringValue: '2026-09-21T00:00:00Z' },
          },
        },
      ],
    });
  }
  return json({});
};

const firebase = require('../src/firebase');
const auth = require('../src/auth');
const telemetry = require('../src/telemetry');
const store = require('../src/store');

(async () => {
  assert.strictEqual(firebase.isConfigured(), true, 'firebase should be configured');
  assert.strictEqual(auth.mode(), 'firebase', 'mode should be firebase');
  console.log('mode:', auth.mode());

  // --- signup ---
  const up = await auth.signup({ email: 'Tools@Akoi.in', password: 'correcthorse', name: 'Aman' });
  assert.ok(up.token, 'signup returns an app token');
  assert.strictEqual(up.account.email, 'tools@akoi.in');
  console.log('signup ok ->', JSON.stringify(up.account));

  // password must never be persisted locally in firebase mode
  const saved = store.read('session.json');
  const savedText = JSON.stringify(saved);
  assert.ok(!savedText.includes('correcthorse'), 'password must not be stored on disk');
  assert.ok(saved.refreshToken, 'refresh token stored for offline re-entry');
  console.log('session stored, no password on disk; keys:', Object.keys(saved).join(','));

  // --- wrong password is rejected with a readable message ---
  try {
    await auth.login({ email: 'tools@akoi.in', password: 'nope' });
    assert.fail('should have thrown');
  } catch (e) {
    assert.strictEqual(e.message, 'Wrong email or password.');
    console.log('wrong password ->', e.message);
  }

  // --- correct login ---
  const inn = await auth.login({ email: 'tools@akoi.in', password: 'correcthorse' });
  assert.ok(auth.verify(inn.token), 'token verifies');
  console.log('login ok, token verifies');

  // --- google ---
  const g = await auth.loginWithGoogleToken({ googleIdToken: 'google_tok', email: 'g@gmail.com' });
  assert.strictEqual(g.account.provider, 'google');
  console.log('google sign-in ok ->', g.account.email);

  // --- restore (refresh token path) ---
  const r = await auth.restore();
  assert.ok(r && r.token, 'restore returns a token');
  console.log('restore ok');

  // --- telemetry: personal data must never reach the wire ---
  // sign-in above already queued events; start from a known-empty queue
  store.write('telemetry.json', []);
  telemetry.record('campaign_finished', {
    sent: 5,
    failed: 1,
    number: '919876543210',
    name: 'Priya',
    body: 'Hi Priya',
    recipients: ['919876543210'],
  });
  const queued = store.read('telemetry.json');
  assert.strictEqual(queued.length, 1, 'event queued');
  const qs = JSON.stringify(queued);
  for (const leak of ['919876543210', 'Priya', 'Hi Priya']) {
    assert.ok(!qs.includes(leak), `queue must not contain ${leak}`);
  }
  console.log('queued event (scrubbed):', qs);

  await telemetry.flush();
  assert.strictEqual((store.read('telemetry.json') || []).length, 0, 'queue drained after flush');
  console.log('flush drained the queue');

  // Contact data must never appear in ANY call.
  const wire = JSON.stringify(calls);
  for (const leak of ['919876543210', 'Priya', 'Hi Priya']) {
    assert.ok(!wire.includes(leak), `no ${leak} on the wire`);
  }

  // The password necessarily goes to Google's auth endpoint over TLS - that is how
  // sign-in works. What matters is that it never reaches Firestore, which is the only
  // place the admin can read.
  const firestoreCalls = calls.filter((c) => c.url.includes('firestore.googleapis.com'));
  const firestoreWire = JSON.stringify(firestoreCalls);
  assert.ok(!firestoreWire.includes('correcthorse'), 'password must never reach Firestore');
  assert.ok(firestoreCalls.length > 0, 'there should be Firestore traffic to check');

  const authCalls = calls.filter((c) => c.url.includes('identitytoolkit'));
  assert.ok(
    JSON.stringify(authCalls).includes('correcthorse'),
    'password does go to Google auth, as expected'
  );
  console.log(
    'no contact data in any of', calls.length, 'calls;',
    'password reaches Google auth only, never Firestore (' + firestoreCalls.length + ' firestore calls checked)'
  );

  // --- offline: flush must not throw and must keep events ---
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('offline'); };
  telemetry.record('app_opened', { offline: true });
  await telemetry.flush();
  assert.strictEqual((store.read('telemetry.json') || []).length, 1, 'event kept while offline');
  console.log('offline flush kept the event, no throw');
  globalThis.fetch = realFetch;

  // --- admin listing decodes Firestore types ---
  const users = await firebase.listUsers('id_1');
  assert.strictEqual(users[0].totalMessagesSent, 42, 'integerValue decoded to number');
  console.log('admin listUsers ->', JSON.stringify(users[0]));

  console.log('\nALL FIREBASE-MODE CHECKS PASSED');
})().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
