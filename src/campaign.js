const EventEmitter = require('events');
const store = require('./store');
const wa = require('./whatsapp');
const { render } = require('./template');
const telemetry = require('./telemetry');

const TICK = 250; // ms granularity for interruptible waits

/**
 * Sequential send engine.
 *
 * The full campaign (every contact and its outcome) is persisted to
 * data/campaign.json after each message, so a crash or restart can resume.
 */
class CampaignEngine extends EventEmitter {
  constructor() {
    super();
    this.state = store.read('campaign.json');
    this.running = false;
    this.stopRequested = false;
    this.pauseRequested = false;
    this.waitUntil = null;
    this.currentIndex = null;
  }

  // ---------- state helpers ----------

  persist() {
    store.write('campaign.json', this.state);
  }

  snapshot() {
    if (!this.state) return { active: false };
    const items = this.state.items;
    const counts = { sent: 0, failed: 0, skipped: 0, pending: 0 };
    for (const it of items) {
      if (it.status === 'sent') counts.sent++;
      else if (it.status === 'failed') counts.failed++;
      else if (it.status === 'pending') counts.pending++;
      else counts.skipped++;
    }
    const done = items.length - counts.pending;
    const s = this.state.settings;
    const avgDelay = (s.minDelaySec + s.maxDelaySec) / 2;
    return {
      active: true,
      id: this.state.id,
      status: this.state.status,
      createdAt: this.state.createdAt,
      total: items.length,
      counts,
      done,
      percent: items.length ? Math.round((done / items.length) * 100) : 0,
      currentIndex: this.currentIndex,
      current: this.currentIndex === null ? null : items[this.currentIndex] || null,
      waitSecondsLeft: this.waitUntil
        ? Math.max(0, Math.ceil((this.waitUntil - Date.now()) / 1000))
        : 0,
      etaSeconds: Math.round(counts.pending * avgDelay),
    };
  }

  emitProgress() {
    this.emit('progress', this.snapshot());
  }

  log(message, level = 'info') {
    this.emit('log', { message, level, at: new Date().toISOString() });
  }

  // ---------- lifecycle ----------

  create(contacts, message, settings) {
    if (this.running) throw new Error('A campaign is already running.');
    if (!contacts.length) throw new Error('No contacts to send to.');
    if (!message.body && !message.mediaPath) throw new Error('The message is empty.');

    this.state = {
      id: `c_${Date.now()}`,
      createdAt: new Date().toISOString(),
      status: 'paused',
      message,
      settings,
      items: contacts.map((c) => ({
        number: c.number,
        name: c.name,
        vars: c.vars,
        status: 'pending',
        attempts: 0,
        error: null,
        renderedBody: null,
        at: null,
      })),
    };
    this.currentIndex = null;
    this.persist();
    this.emitProgress();
    return this.snapshot();
  }

  start() {
    if (!this.state) throw new Error('No campaign loaded.');
    if (this.running) return this.snapshot();

    const settings = store.getSettings();
    const pending = this.state.items.filter((i) => i.status === 'pending').length;
    const remainingCap = settings.dailyCap - settings.sentToday;
    if (remainingCap <= 0) {
      throw new Error(
        `Daily cap reached (${settings.sentToday}/${settings.dailyCap}). Raise the cap in Settings or try tomorrow.`
      );
    }
    if (pending > remainingCap) {
      this.log(
        `${pending} pending but only ${remainingCap} left in today's cap - the run will pause when the cap is hit.`,
        'warn'
      );
    }

    this.stopRequested = false;
    this.pauseRequested = false;
    this.state.status = 'running';
    this.persist();
    telemetry.record('campaign_started', { pending });
    this.loop();
    return this.snapshot();
  }

  pause() {
    if (!this.running) return this.snapshot();
    this.pauseRequested = true;
    this.log('Pause requested - finishing the current message first.', 'warn');
    return this.snapshot();
  }

  stop() {
    this.stopRequested = true;
    if (!this.running && this.state) {
      this.state.status = 'stopped';
      this.persist();
      this.emitProgress();
    }
    this.log('Stop requested.', 'warn');
    return this.snapshot();
  }

  clear() {
    if (this.running) throw new Error('Stop the running campaign first.');
    this.state = null;
    this.currentIndex = null;
    store.write('campaign.json', null);
    this.emitProgress();
  }

  // ---------- the loop ----------

  async loop() {
    this.running = true;
    this.emitProgress();

    try {
      await this.pass(1);

      // one retry pass over failures, if we were not interrupted
      if (!this.stopRequested && !this.pauseRequested) {
        const retryable = this.state.items.filter((i) => i.status === 'failed' && i.attempts < 2);
        if (retryable.length) {
          this.log(`Retrying ${retryable.length} failed contact(s)...`);
          retryable.forEach((i) => {
            i.status = 'pending';
          });
          this.persist();
          await this.pass(2);
        }
      }
    } catch (err) {
      this.log(`Engine error: ${err.message}`, 'error');
    } finally {
      this.running = false;
      this.currentIndex = null;
      this.waitUntil = null;

      const stillPending = this.state.items.some((i) => i.status === 'pending');
      if (this.stopRequested) this.state.status = 'stopped';
      else if (stillPending) this.state.status = 'paused';
      else this.state.status = 'done';

      this.persist();

      if (this.state.status === 'done') {
        this.archive();
        const counts = this.snapshot().counts;
        telemetry.bump('campaigns');
        telemetry.record('campaign_finished', {
          total: this.state.items.length,
          sent: counts.sent,
          failed: counts.failed,
          skipped: counts.skipped,
        });
        telemetry.syncProfile();
        this.log('Campaign finished.', 'success');
      }
      this.emitProgress();
    }
  }

  async pass(attemptNo) {
    const items = this.state.items;
    let sinceRest = 0;

    for (let i = 0; i < items.length; i++) {
      if (this.stopRequested || this.pauseRequested) return;

      const item = items[i];
      if (item.status !== 'pending') continue;

      const settings = store.getSettings();
      if (settings.sentToday >= settings.dailyCap) {
        this.log(`Daily cap of ${settings.dailyCap} reached - pausing.`, 'warn');
        this.pauseRequested = true;
        return;
      }

      if (!wa.isReady()) {
        this.log('WhatsApp is not connected - pausing the campaign.', 'error');
        this.pauseRequested = true;
        return;
      }

      if (store.getOptOuts().includes(item.number)) {
        item.status = 'skipped_opted_out';
        item.at = new Date().toISOString();
        this.persist();
        this.log(`Skipped +${item.number} - opted out.`, 'warn');
        this.emitProgress();
        continue;
      }

      this.currentIndex = i;
      item.attempts = attemptNo;
      const body = render(this.state.message.body || '', item.vars);
      item.renderedBody = body;
      this.emitProgress();

      try {
        await wa.send(
          item.number,
          body,
          this.state.message.mediaPath
            ? { path: this.state.message.mediaPath, name: this.state.message.mediaName }
            : null,
          { verify: this.state.settings.verifyNumbers }
        );
        item.status = 'sent';
        item.error = null;
        item.at = new Date().toISOString();
        store.bumpSentToday(1);
        telemetry.bump('sent');
        this.log(`Sent to ${item.name || '+' + item.number}`, 'success');
      } catch (err) {
        if (err.code === 'NOT_ON_WHATSAPP') {
          item.status = 'skipped_not_on_whatsapp';
          item.error = 'Not registered on WhatsApp';
          this.log(`Skipped +${item.number} - not on WhatsApp.`, 'warn');
        } else {
          item.status = 'failed';
          item.error = err.message;
          telemetry.bump('failed');
          this.log(`Failed +${item.number}: ${err.message}`, 'error');
        }
        item.at = new Date().toISOString();
      }

      this.persist();
      this.emitProgress();
      sinceRest++;

      if (!items.some((x) => x.status === 'pending')) break;
      if (this.stopRequested || this.pauseRequested) return;

      const s = this.state.settings;
      if (s.restEvery > 0 && sinceRest >= s.restEvery) {
        sinceRest = 0;
        const rest = randInt(s.restMinSec, s.restMaxSec);
        this.log(`Resting ${rest}s after ${s.restEvery} messages.`, 'warn');
        await this.wait(rest);
      } else {
        await this.wait(randInt(s.minDelaySec, s.maxDelaySec));
      }
    }
  }

  /** Interruptible sleep that keeps the UI countdown fed. */
  async wait(seconds) {
    this.waitUntil = Date.now() + seconds * 1000;
    this.emitProgress();
    let tick = 0;
    while (Date.now() < this.waitUntil) {
      if (this.stopRequested || this.pauseRequested) break;
      await new Promise((r) => setTimeout(r, TICK));
      if (++tick % 4 === 0) this.emitProgress();
    }
    this.waitUntil = null;
    this.emitProgress();
  }

  archive() {
    const history = store.read('history.json') || [];
    const snap = this.snapshot();
    history.unshift({
      id: this.state.id,
      createdAt: this.state.createdAt,
      finishedAt: new Date().toISOString(),
      total: snap.total,
      counts: snap.counts,
      preview: (this.state.message.body || '').slice(0, 120),
    });
    store.write('history.json', history.slice(0, 50));
  }

  /** CSV report of the current campaign. */
  reportCsv() {
    const esc = (v) => `"${String(v === null || v === undefined ? '' : v).replace(/"/g, '""')}"`;
    const lines = ['number,name,status,error,sent_at,message'];
    if (!this.state) return lines.join('\n') + '\n';
    for (const i of this.state.items) {
      lines.push([i.number, i.name, i.status, i.error, i.at, i.renderedBody].map(esc).join(','));
    }
    return lines.join('\n');
  }
}

function randInt(min, max) {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return Math.floor(lo + Math.random() * (hi - lo + 1));
}

module.exports = new CampaignEngine();
