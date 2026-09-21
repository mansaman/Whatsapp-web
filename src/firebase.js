const { config, isFirebaseConfigured } = require('./config');

/**
 * Firebase Auth + Firestore over their REST APIs.
 *
 * Deliberately no `firebase` SDK: it is built for browsers, pulls in a large dependency
 * tree, and every call this app makes is a plain HTTPS request. REST keeps the installer
 * smaller and the failure modes obvious.
 *
 * Nothing here throws on a network failure in a way that can take the app down — the
 * caller decides what to do, and telemetry treats every error as "try again later".
 */

const AUTH = 'https://identitytoolkit.googleapis.com/v1/accounts';
const TOKEN = 'https://securetoken.googleapis.com/v1/token';
const FIRESTORE = 'https://firestore.googleapis.com/v1/projects';

function key() {
  return config.firebase.apiKey;
}

async function call(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(friendlyError(data));
  }
  return data;
}

/** Firebase error codes are shouty constants; turn them into something a user can act on. */
function friendlyError(data) {
  const raw = (data && data.error && data.error.message) || 'Request failed';
  const map = {
    EMAIL_EXISTS: 'That email is already registered. Sign in instead.',
    EMAIL_NOT_FOUND: 'No account with that email.',
    INVALID_PASSWORD: 'Wrong email or password.',
    INVALID_LOGIN_CREDENTIALS: 'Wrong email or password.',
    USER_DISABLED: 'This account has been disabled.',
    WEAK_PASSWORD: 'Password must be at least 6 characters.',
    INVALID_EMAIL: 'That email address is not valid.',
    TOO_MANY_ATTEMPTS_TRY_LATER: 'Too many attempts. Wait a few minutes and try again.',
    OPERATION_NOT_ALLOWED: 'That sign-in method is not enabled in Firebase.',
  };
  const code = String(raw).split(' ')[0];
  return map[code] || raw;
}

/** Normalise the three auth endpoints into one shape. */
function toSession(data) {
  return {
    uid: data.localId,
    email: (data.email || '').toLowerCase(),
    name: data.displayName || null,
    idToken: data.idToken,
    refreshToken: data.refreshToken,
    expiresAt: Date.now() + Number(data.expiresIn || 3600) * 1000,
  };
}

async function signUp({ email, password, name }) {
  const data = await call(`${AUTH}:signUp?key=${key()}`, {
    email,
    password,
    returnSecureToken: true,
  });
  if (name) {
    await call(`${AUTH}:update?key=${key()}`, {
      idToken: data.idToken,
      displayName: name,
      returnSecureToken: false,
    }).catch(() => {});
    data.displayName = name;
  }
  return toSession(data);
}

async function signIn({ email, password }) {
  const data = await call(`${AUTH}:signInWithPassword?key=${key()}`, {
    email,
    password,
    returnSecureToken: true,
  });
  return toSession(data);
}

/** Trade a Google ID token for a Firebase session. */
async function signInWithGoogle({ googleIdToken, requestUri }) {
  const data = await call(`${AUTH}:signInWithIdp?key=${key()}`, {
    postBody: `id_token=${encodeURIComponent(googleIdToken)}&providerId=google.com`,
    requestUri: requestUri || `https://${config.firebase.authDomain}`,
    returnIdpCredential: true,
    returnSecureToken: true,
  });
  return toSession(data);
}

/** Swap a refresh token for a fresh ID token. Used on every launch. */
async function refresh(refreshToken) {
  const res = await fetch(`${TOKEN}?key=${key()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(friendlyError(data));
  return {
    uid: data.user_id,
    idToken: data.id_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000,
  };
}

async function sendPasswordReset(email) {
  return call(`${AUTH}:sendOobCode?key=${key()}`, { requestType: 'PASSWORD_RESET', email });
}

// ---------------------------------------------------------------- Firestore

/** Firestore REST wants every value tagged with its type. */
function toFirestoreValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') {
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFirestoreValue) } };
  if (typeof v === 'object') return { mapValue: { fields: toFirestoreFields(v) } };
  return { stringValue: String(v) };
}

function toFirestoreFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) fields[k] = toFirestoreValue(v);
  return fields;
}

function fromFirestoreValue(v) {
  if (!v || typeof v !== 'object') return v;
  if ('nullValue' in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('stringValue' in v) return v.stringValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromFirestoreValue);
  if ('mapValue' in v) return fromFirestoreDoc({ fields: v.mapValue.fields });
  return null;
}

function fromFirestoreDoc(doc) {
  const out = {};
  for (const [k, v] of Object.entries((doc && doc.fields) || {})) out[k] = fromFirestoreValue(v);
  return out;
}

function docUrl(path) {
  return `${FIRESTORE}/${config.firebase.projectId}/databases/(default)/documents/${path}`;
}

/** Merge fields into users/{uid}, creating it if needed. */
async function setUserDoc(idToken, uid, data) {
  const mask = Object.keys(data)
    .map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`)
    .join('&');
  const res = await fetch(`${docUrl(`users/${uid}`)}?${mask}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
    body: JSON.stringify({ fields: toFirestoreFields(data) }),
  });
  if (!res.ok) throw new Error(`Firestore write failed (${res.status})`);
  return fromFirestoreDoc(await res.json());
}

/** Append one usage event under users/{uid}/events. */
async function addEvent(idToken, uid, event) {
  const res = await fetch(`${docUrl(`users/${uid}/events`)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
    body: JSON.stringify({ fields: toFirestoreFields(event) }),
  });
  if (!res.ok) throw new Error(`Firestore write failed (${res.status})`);
  return true;
}

/** Admin view: every user record. */
async function listUsers(idToken) {
  const out = [];
  let pageToken = '';
  do {
    const url = `${docUrl('users')}?pageSize=300${pageToken ? `&pageToken=${pageToken}` : ''}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${idToken}` } });
    if (!res.ok) throw new Error(`Could not read users (${res.status})`);
    const data = await res.json();
    for (const doc of data.documents || []) {
      out.push({ uid: doc.name.split('/').pop(), ...fromFirestoreDoc(doc) });
    }
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return out;
}

/** Admin view: one user's recent events, newest first. */
async function listEvents(idToken, uid, limit = 100) {
  // runQuery is scoped to the parent document, so the subcollection resolves correctly.
  const res = await fetch(`${docUrl(`users/${uid}`)}:runQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: 'events' }],
        orderBy: [{ field: { fieldPath: 'at' }, direction: 'DESCENDING' }],
        limit,
      },
    }),
  });
  if (!res.ok) throw new Error(`Could not read events (${res.status})`);
  const rows = await res.json();
  return rows.filter((r) => r.document).map((r) => fromFirestoreDoc(r.document));
}

module.exports = {
  isConfigured: isFirebaseConfigured,
  signUp,
  signIn,
  signInWithGoogle,
  refresh,
  sendPasswordReset,
  setUserDoc,
  addEvent,
  listUsers,
  listEvents,
};
