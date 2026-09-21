const fs = require('fs');
const EventEmitter = require('events');
const QRCode = require('qrcode');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const store = require('./store');
const { SESSION_DIR, CACHE_DIR } = require('./paths');
const { findChrome } = require('./browser');

/**
 * Thin wrapper around whatsapp-web.js that exposes a simple state machine
 * and emits everything the GUI needs.
 *
 * States: disconnected -> starting -> qr -> authenticating -> ready
 */
class WhatsAppService extends EventEmitter {
  constructor() {
    super();
    this.client = null;
    this.state = 'disconnected';
    this.qrDataUrl = null;
    this.me = null;
    this.lastError = null;
  }

  status() {
    return {
      state: this.state,
      qr: this.qrDataUrl,
      me: this.me,
      lastError: this.lastError,
    };
  }

  setState(state, extra = {}) {
    this.state = state;
    this.emit('status', this.status());
    if (extra.log) this.emit('log', extra.log);
  }

  async start() {
    if (this.client) return this.status();

    this.lastError = null;
    this.setState('starting', { log: 'Launching browser session...' });

    const puppeteer = {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    };
    const chrome = findChrome();
    if (!chrome) {
      this.lastError =
        'No Chrome or Edge found on this computer. Install Google Chrome, then try again.';
      this.setState('disconnected', { log: this.lastError });
      return this.status();
    }
    puppeteer.executablePath = chrome;

    this.client = new Client({
      authStrategy: new LocalAuth({ dataPath: SESSION_DIR }),
      webVersionCache: { type: 'local', path: CACHE_DIR },
      puppeteer,
    });

    this.client.on('qr', async (qr) => {
      this.qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 300 });
      this.setState('qr', { log: 'Scan the QR code with WhatsApp > Linked devices.' });
    });

    this.client.on('authenticated', () => {
      this.qrDataUrl = null;
      this.setState('authenticating', { log: 'Authenticated. Loading your chats...' });
    });

    this.client.on('auth_failure', (msg) => {
      this.lastError = `Authentication failed: ${msg}`;
      this.setState('disconnected', { log: this.lastError });
    });

    this.client.on('ready', () => {
      this.qrDataUrl = null;
      const info = this.client.info || {};
      this.me = { number: info.wid?.user || null, name: info.pushname || null };
      this.setState('ready', { log: `Connected as ${this.me.name || this.me.number}.` });
    });

    this.client.on('disconnected', (reason) => {
      this.lastError = `Disconnected: ${reason}`;
      this.me = null;
      this.client = null;
      this.setState('disconnected', { log: this.lastError });
    });

    // Auto opt-out on STOP / UNSUBSCRIBE
    this.client.on('message', (msg) => {
      try {
        const settings = store.getSettings();
        if (!settings.autoOptOut) return;
        const body = String(msg.body || '').trim().toLowerCase();
        if (!/^(stop|unsubscribe|remove me|opt ?out)\b/.test(body)) return;
        const number = String(msg.from || '').split('@')[0];
        if (!number) return;
        store.addOptOut(number);
        this.emit('optout', number);
        this.emit('log', `Opt-out recorded for +${number} ("${msg.body}").`);
      } catch {
        /* never let an inbound message crash the app */
      }
    });

    this.client.initialize().catch((err) => {
      this.lastError = err.message;
      this.client = null;
      this.setState('disconnected', { log: `Failed to start: ${err.message}` });
    });

    return this.status();
  }

  async logout() {
    try {
      if (this.client) {
        await this.client.logout().catch(() => {});
        await this.client.destroy().catch(() => {});
      }
    } finally {
      this.client = null;
      this.me = null;
      this.qrDataUrl = null;
      fs.rmSync(SESSION_DIR, { recursive: true, force: true });
      this.setState('disconnected', { log: 'Logged out and session cleared.' });
    }
  }

  /** Shut the browser down without clearing the saved session. */
  async destroy() {
    if (!this.client) return;
    const client = this.client;
    this.client = null;
    this.me = null;
    this.qrDataUrl = null;
    this.state = 'disconnected';
    await client.destroy().catch(() => {});
  }

  isReady() {
    return this.state === 'ready' && !!this.client;
  }

  /** Resolve a plain number to a WhatsApp chat id, or null if not registered. */
  async resolveChatId(number) {
    const id = await this.client.getNumberId(number);
    return id ? id._serialized : null;
  }

  /**
   * Send one message. `media` is { path, name } or null.
   * Returns the chat id it was sent to.
   */
  async send(number, text, media = null, { verify = true } = {}) {
    if (!this.isReady()) throw new Error('WhatsApp is not connected.');

    let chatId = `${number}@c.us`;
    if (verify) {
      const resolved = await this.resolveChatId(number);
      if (!resolved) {
        const err = new Error('Number is not registered on WhatsApp');
        err.code = 'NOT_ON_WHATSAPP';
        throw err;
      }
      chatId = resolved;
    }

    if (media && media.path && fs.existsSync(media.path)) {
      const attachment = MessageMedia.fromFilePath(media.path);
      await this.client.sendMessage(chatId, attachment, { caption: text || undefined });
    } else {
      await this.client.sendMessage(chatId, text);
    }
    return chatId;
  }
}

module.exports = new WhatsAppService();
