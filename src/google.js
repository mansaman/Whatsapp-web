const crypto = require('crypto');
const store = require('./store');
const { config } = require('./config');

/**
 * "Sign in with Google" for an installed app, using the loopback redirect flow
 * with PKCE (Google's documented approach for desktop clients).
 *
 * The client ID comes from src/config.js and belongs to the developer, so it is the
 * same in every copy of the app and users configure nothing. A per-device override in
 * Settings still wins, which keeps the standalone/local build usable without a Firebase
 * project.
 *
 * Google calls the installed-app client secret "not really secret" (it ships inside
 * the binary and cannot be protected), which is why PKCE carries the actual security.
 */

const pending = new Map(); // state -> { verifier, createdAt }
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

function credentials() {
  const s = store.getSettings();
  return {
    clientId: s.googleClientId || config.firebase.googleClientId || '',
    clientSecret: s.googleClientSecret || config.firebase.googleClientSecret || '',
  };
}

function isConfigured() {
  return !!credentials().clientId;
}

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Build the consent URL the user's browser should open. */
function buildAuthUrl(redirectUri) {
  const { clientId } = credentials();
  if (!clientId) throw new Error('No Google client ID configured yet.');

  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  const state = base64url(crypto.randomBytes(16));

  pending.set(state, { verifier, createdAt: Date.now() });
  sweep();

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    access_type: 'online',
    prompt: 'select_account',
  });
  return { url: `${AUTH_URL}?${params}`, state };
}

/** Exchange the returned code for an identity. Returns { email, name }. */
async function exchange({ code, state, redirectUri }) {
  const entry = pending.get(state);
  if (!entry) throw new Error('This sign-in request expired or was already used.');
  pending.delete(state);

  const { clientId, clientSecret } = credentials();
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
    code_verifier: entry.verifier,
  });
  if (clientSecret) body.set('client_secret', clientSecret);

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error_description || data.error || 'Google rejected the sign-in.');
  }
  if (!data.id_token) throw new Error('Google did not return an identity token.');

  const claims = decodeIdToken(data.id_token);
  if (!claims.email) throw new Error('Google did not share an email address.');
  if (claims.email_verified === false) throw new Error('That Google email is not verified.');
  if (claims.aud !== clientId) throw new Error('This token was issued for a different app.');

  return { email: claims.email, name: claims.name || null, googleIdToken: data.id_token };
}

/**
 * Read the claims out of the ID token.
 *
 * The signature is not verified here, and does not need to be: the token came
 * straight from Google's token endpoint over TLS in direct response to our own
 * request, which is the case Google explicitly allows skipping verification for.
 * Never trust an id_token from any other source this way.
 */
function decodeIdToken(idToken) {
  const part = String(idToken).split('.')[1];
  if (!part) throw new Error('Malformed identity token.');
  return JSON.parse(Buffer.from(part, 'base64').toString('utf8'));
}

function sweep() {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [state, entry] of pending) {
    if (entry.createdAt < cutoff) pending.delete(state);
  }
}

module.exports = { isConfigured, buildAuthUrl, exchange };
