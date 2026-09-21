const os = require('os');
const store = require('./store');
const firebase = require('./firebase');
const { config } = require('./config');

/**
 * Usage reporting.
 *
 * Rules this module follows, in order of importance:
 *
 *  1. It never breaks the app. Every failure is swallowed and retried later. A dashboard
 *     being down must not stop someone sending messages.
 *  2. It never sends personal data. Only counts and account identity go out — no phone
 *     numbers, no names from contact lists, no message text, no attachments. `scrub()`
 *     enforces that on the way out, so a careless call site cannot leak anything.
 *  3. It works offline. Events queue on disk and flush when a connection returns.
 */

const MAX_QUEUE = 500;

// Anything resembling contact data is dropped before it can reach the network.
const BANNED_KEYS = new Set([
  'contacts',
  'numbers',
  'number',
  'phone',
  'phones',
  'recipients',
  'message',
  'messageBody',
  'body',
  'text',
  'name',
  'names',
  'vars',
  'media',
  'attachment',
]);

class Telemetry {
  constructor() {
    this.session = null; // { uid, idToken, email }
    this.timer = null;
    this.flushing = false;
  }

  /** Called once the user is signed in with a Firebase session. */
  attach(session) {
    this.session = session;
    this.startTimer();
    this.flush();
  }

  detach() {
    this.session = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  startTimer() {
    if (this.timer) return;
    this.timer = setInterval(() => this.flush(), config.telemetryFlushMs);
    if (this.timer.unref) this.timer.unref();
  }

  /**
   * Strip anything that is not a plain count or identifier. Unknown keys are kept only
   * if their value is a number or boolean, so adding a field at a call site can never
   * accidentally start uploading strings of user data.
   */
  scrub(payload = {}) {
    const clean = {};
    for (const [k, v] of Object.entries(payload)) {
      if (BANNED_KEYS.has(k.toLowerCase())) continue;
      if (typeof v === 'number' || typeof v === 'boolean') clean[k] = v;
      else if (k === 'status' || k === 'reason' || k === 'version' || k === 'platform') {
        clean[k] = String(v).slice(0, 120);
      }
    }
    return clean;
  }

  /** Queue an event. Safe to call from anywhere, including hot paths. */
  record(type, payload = {}) {
    try {
      if (!firebase.isConfigured()) return;
      const queue = store.read('telemetry.json') || [];
      queue.push({
        type: String(type).slice(0, 60),
        at: new Date().toISOString(),
        ...this.scrub(payload),
      });
      // Drop the oldest first: recent activity is the useful part.
      store.write('telemetry.json', queue.slice(-MAX_QUEUE));
    } catch {
      /* telemetry must never throw into the caller */
    }
  }

  /** Push whatever is queued. Returns quietly if offline or not signed in. */
  async flush() {
    if (this.flushing) return;
    if (!firebase.isConfigured() || !this.session || !this.session.idToken) return;

    const queue = store.read('telemetry.json') || [];
    if (!queue.length) return;

    this.flushing = true;
    const sent = [];
    try {
      for (const event of queue.slice(0, 50)) {
        await firebase.addEvent(this.session.idToken, this.session.uid, event);
        sent.push(event);
      }
    } catch {
      // Offline, token expired, or rules rejected it. Keep what did not send.
    } finally {
      if (sent.length) {
        const remaining = (store.read('telemetry.json') || []).slice(sent.length);
        store.write('telemetry.json', remaining);
      }
      this.flushing = false;
    }
  }

  /**
   * Refresh the user's summary record: who they are and their running totals.
   * This is what the dashboard lists.
   */
  async syncProfile(extra = {}) {
    try {
      if (!firebase.isConfigured() || !this.session) return;
      const totals = store.read('totals.json') || {};
      await firebase.setUserDoc(this.session.idToken, this.session.uid, {
        email: this.session.email,
        name: this.session.name || null,
        lastSeenAt: new Date().toISOString(),
        appVersion: process.env.npm_package_version || require('../package.json').version,
        platform: `${os.platform()} ${os.release()}`,
        totalMessagesSent: totals.sent || 0,
        totalMessagesFailed: totals.failed || 0,
        totalCampaigns: totals.campaigns || 0,
        ...this.scrub(extra),
      });
    } catch {
      /* try again on the next flush */
    }
  }

  /** Running totals, kept locally so they survive offline stretches. */
  bump(field, by = 1) {
    try {
      const totals = store.read('totals.json') || {};
      totals[field] = (totals[field] || 0) + by;
      store.write('totals.json', totals);
      return totals;
    } catch {
      return {};
    }
  }

  getTotals() {
    return store.read('totals.json') || { sent: 0, failed: 0, campaigns: 0 };
  }
}

module.exports = new Telemetry();
