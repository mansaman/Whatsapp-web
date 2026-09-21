const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

const DEFAULTS = {
  'settings.json': {
    countryCode: '91',
    minDelaySec: 8,
    maxDelaySec: 25,
    restEvery: 40,
    restMinSec: 60,
    restMaxSec: 180,
    dailyCap: 200,
    verifyNumbers: true,
    autoOptOut: true,
    warningAcknowledged: false,
    sentToday: 0,
    sentTodayDate: null,
  },
  'contacts.json': { fileName: null, headers: [], rows: [], mapping: {}, stats: null },
  'campaign.json': null,
  'history.json': [],
  'optout.json': [],
  'message.json': { body: '', mediaPath: null, mediaName: null },
};

function file(name) {
  return path.join(DATA_DIR, name);
}

function read(name) {
  try {
    const raw = fs.readFileSync(file(name), 'utf8');
    return JSON.parse(raw);
  } catch {
    return clone(DEFAULTS[name]);
  }
}

function write(name, value) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(file(name), JSON.stringify(value, null, 2), 'utf8');
  return value;
}

function clone(v) {
  return v === null || v === undefined ? v : JSON.parse(JSON.stringify(v));
}

/** Settings merged over defaults, with the daily counter rolled over on a new date. */
function getSettings() {
  const s = { ...DEFAULTS['settings.json'], ...(read('settings.json') || {}) };
  const today = new Date().toISOString().slice(0, 10);
  if (s.sentTodayDate !== today) {
    s.sentToday = 0;
    s.sentTodayDate = today;
    write('settings.json', s);
  }
  return s;
}

function saveSettings(patch) {
  return write('settings.json', { ...getSettings(), ...patch });
}

function bumpSentToday(n = 1) {
  const s = getSettings();
  return saveSettings({ sentToday: s.sentToday + n });
}

function getOptOuts() {
  return read('optout.json') || [];
}

function addOptOut(number) {
  const list = getOptOuts();
  if (!list.includes(number)) {
    list.push(number);
    write('optout.json', list);
  }
  return list;
}

function removeOptOut(number) {
  return write('optout.json', getOptOuts().filter((n) => n !== number));
}

module.exports = {
  DATA_DIR,
  read,
  write,
  getSettings,
  saveSettings,
  bumpSentToday,
  getOptOuts,
  addOptOut,
  removeOptOut,
};
