/**
 * Build-time configuration.
 *
 * These values ship inside every copy of the app. That is fine and intended: a Firebase
 * web apiKey and an OAuth client ID are public identifiers, not secrets. What protects
 * the data is the Firestore rules (see firestore.rules), not hiding these strings.
 *
 * Leave them empty and the app runs in local-only mode: accounts live on the user's
 * machine, nothing is uploaded, and you get no dashboard. Fill them in and the same
 * app starts using Firebase for accounts and usage reporting.
 *
 * See FIREBASE_SETUP.md.
 */

const config = {
  firebase: {
    apiKey: process.env.WA_FIREBASE_API_KEY || '',
    authDomain: process.env.WA_FIREBASE_AUTH_DOMAIN || '',
    projectId: process.env.WA_FIREBASE_PROJECT_ID || '',
    googleClientId: process.env.WA_GOOGLE_CLIENT_ID || '',
  },

  /** Who may read everyone's data in the dashboard. Must match firestore.rules. */
  adminEmail: process.env.WA_ADMIN_EMAIL || 'tools@akoi.in',

  /** How often queued usage events are flushed, in ms. */
  telemetryFlushMs: 60 * 1000,
};

/** Firebase is only usable once the three core values are present. */
function isFirebaseConfigured() {
  const f = config.firebase;
  return !!(f.apiKey && f.authDomain && f.projectId);
}

/** The Google button needs a client ID on top of the Firebase basics. */
function isGoogleConfigured() {
  return isFirebaseConfigured() && !!config.firebase.googleClientId;
}

module.exports = { config, isFirebaseConfigured, isGoogleConfigured };
