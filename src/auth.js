const crypto = require('crypto');
const store = require('./store');
const firebase = require('./firebase');
const telemetry = require('./telemetry');

/**
 * Account gate, in one of two modes.
 *
 *   firebase - accounts live in Firebase. You never hold a password, and usage is
 *              reported to your dashboard. This is the mode for distributed builds.
 *   local    - accounts live on this machine, hashed with scrypt. Used when Firebase
 *              is not configured, so the app still works standalone and in development.
 *
 * The mode is decided by src/config.js, not by the user.
 *
 * In firebase mode the app is offline-tolerant: once someone has signed in, the saved
 * refresh token lets them back in without a network, for OFFLINE_GRACE_MS. Signing up
 * or signing in for the first time does need a connection.
 */

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const OFFLINE_GRACE_MS = 30 * 24 * 60 * 60 * 1000;

const sessions = new Map(); // app token -> { email, uid, expires }

function mode() {
  return firebase.isConfigured() ? 'firebase' : 'local';
}

// ---------------------------------------------------------------- shared helpers

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
}

function hash(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}

function issueToken({ email, uid }) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { email, uid: uid || null, expires: Date.now() + SESSION_TTL_MS });
  return { token, account: publicAccount() };
}

function verify(token) {
  const s = sessions.get(token);
  if (!s) return null;
  if (s.expires < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return s;
}

function logout(token) {
  sessions.delete(token);
}

// ---------------------------------------------------------------- stored identity

/** The saved Firebase session, used to get back in without re-typing a password. */
function savedSession() {
  return store.read('session.json');
}

function saveSession(session) {
  store.write('session.json', {
    uid: session.uid,
    email: session.email,
    name: session.name || null,
    provider: session.provider || 'password',
    refreshToken: session.refreshToken,
    idToken: session.idToken,
    expiresAt: session.expiresAt,
    lastVerifiedAt: Date.now(),
  });
  telemetry.attach(session);
  return session;
}

function localAccount() {
  return store.read('account.json');
}

function isRegistered() {
  return mode() === 'firebase' ? !!savedSession() : !!(localAccount() && localAccount().email);
}

function publicAccount() {
  if (mode() === 'firebase') {
    const s = savedSession();
    if (!s) return null;
    return { email: s.email, name: s.name, provider: s.provider, uid: s.uid };
  }
  const acc = localAccount();
  if (!acc || !acc.email) return null;
  return {
    email: acc.email,
    name: acc.name || null,
    provider: acc.provider || 'local',
    createdAt: acc.createdAt,
  };
}

// ---------------------------------------------------------------- sign up / in

async function signup({ email, password, name }) {
  email = String(email || '').trim().toLowerCase();
  if (!validEmail(email)) throw new Error('Enter a valid email address.');
  if (String(password || '').length < 8) throw new Error('Password must be at least 8 characters.');

  if (mode() === 'firebase') {
    const session = await firebase.signUp({ email, password, name });
    session.provider = 'password';
    saveSession(session);
    telemetry.record('signed_up');
    telemetry.syncProfile();
    return issueToken(session);
  }

  if (isRegistered()) throw new Error('An account already exists on this device.');
  const salt = crypto.randomBytes(16).toString('hex');
  store.write('account.json', {
    email,
    name: name || null,
    provider: 'local',
    salt,
    hash: hash(password, salt),
    createdAt: new Date().toISOString(),
  });
  return issueToken({ email });
}

async function login({ email, password }) {
  email = String(email || '').trim().toLowerCase();

  if (mode() === 'firebase') {
    const session = await firebase.signIn({ email, password });
    session.provider = 'password';
    saveSession(session);
    telemetry.record('signed_in', { method: 0 });
    telemetry.syncProfile();
    return issueToken(session);
  }

  const acc = localAccount();
  if (!acc || !acc.email) throw new Error('No account yet — sign up first.');
  const supplied = hash(password, acc.salt);
  const expected = acc.hash;
  const same =
    supplied.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
  if (email !== acc.email || !same) throw new Error('Wrong email or password.');
  return issueToken({ email: acc.email });
}

/** Completes the Google flow: a verified Google ID token becomes a Firebase session. */
async function loginWithGoogleToken({ googleIdToken, email, name }) {
  if (mode() === 'firebase') {
    const session = await firebase.signInWithGoogle({ googleIdToken });
    session.provider = 'google';
    if (!session.name && name) session.name = name;
    saveSession(session);
    telemetry.record('signed_in', { method: 1 });
    telemetry.syncProfile();
    return issueToken(session);
  }

  // Local mode: trust the verified identity and bind the device to it.
  email = String(email || '').trim().toLowerCase();
  if (!validEmail(email)) throw new Error('Google did not return a usable email address.');
  const acc = localAccount();
  if (!acc || !acc.email) {
    store.write('account.json', {
      email,
      name: name || null,
      provider: 'google',
      salt: null,
      hash: null,
      createdAt: new Date().toISOString(),
    });
  } else if (acc.email !== email) {
    throw new Error(`This device is registered to ${acc.email}. Sign in with that account.`);
  }
  return issueToken({ email });
}

/**
 * Try to get back in using the saved session, so a returning user is not asked to
 * type a password every launch. Falls back to the offline grace window if the
 * network is unavailable.
 */
async function restore() {
  if (mode() !== 'firebase') return null;
  const saved = savedSession();
  if (!saved || !saved.refreshToken) return null;

  try {
    const fresh = await firebase.refresh(saved.refreshToken);
    const session = { ...saved, ...fresh };
    saveSession(session);
    telemetry.record('app_opened');
    telemetry.syncProfile();
    return issueToken(session);
  } catch {
    // Offline or Firebase unreachable: let them in on the last known session.
    const age = Date.now() - (saved.lastVerifiedAt || 0);
    if (age > OFFLINE_GRACE_MS) return null;
    telemetry.attach(saved);
    telemetry.record('app_opened', { offline: true });
    return issueToken(saved);
  }
}

async function changePassword({ currentPassword, newPassword }) {
  if (mode() === 'firebase') {
    throw new Error(
      'Password changes go through Google. Use "Forgot password" on the sign-in screen.'
    );
  }
  const acc = localAccount();
  if (!acc || !acc.email) throw new Error('No account yet.');
  if (acc.provider === 'local') await login({ email: acc.email, password: currentPassword });
  if (String(newPassword || '').length < 8) throw new Error('Password must be at least 8 characters.');
  const salt = crypto.randomBytes(16).toString('hex');
  store.write('account.json', { ...acc, provider: 'local', salt, hash: hash(newPassword, salt) });
}

async function sendPasswordReset(email) {
  if (mode() !== 'firebase') throw new Error('Password reset needs Firebase to be configured.');
  await firebase.sendPasswordReset(String(email || '').trim().toLowerCase());
}

/** Forget this device's identity entirely. */
function signOut(token) {
  logout(token);
  telemetry.detach();
  store.write('session.json', null);
}

/** The signed-in Firebase session, for the admin dashboard to reuse. */
function currentSession() {
  return savedSession();
}

// ---------------------------------------------------------------- express guard

const OPEN_PATHS = new Set([
  '/auth/state',
  '/auth/signup',
  '/auth/login',
  '/auth/reset',
  '/auth/google/start',
  '/auth/google/callback',
]);

function middleware(req, res, next) {
  if (OPEN_PATHS.has(req.path)) return next();
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token || !verify(token)) {
    return res.status(401).json({ ok: false, error: 'Not signed in.', authRequired: true });
  }
  next();
}

module.exports = {
  mode,
  isRegistered,
  publicAccount,
  signup,
  login,
  loginWithGoogleToken,
  restore,
  changePassword,
  sendPasswordReset,
  signOut,
  currentSession,
  verify,
  logout,
  middleware,
};
