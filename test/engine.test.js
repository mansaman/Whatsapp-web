/**
 * Send-engine and contact-parsing tests. No network, no WhatsApp: the transport is
 * stubbed, so these run anywhere in a second.
 */
const os = require('os');
const path = require('path');
const assert = require('assert');

process.env.WA_DATA_DIR = path.join(os.tmpdir(), 'wa-engine-' + Date.now());

const contacts = require('../src/contacts');
const template = require('../src/template');
const store = require('../src/store');
const wa = require('../src/whatsapp');

// ---------------------------------------------------------------- numbers

const numberCases = [
  ['9123456789', '91', '919123456789', 'national number that starts with the country code'],
  ['9876543210', '91', '919876543210', 'plain national number'],
  ['+91 9876543210', '91', '919876543210', 'international with spaces'],
  ['0091-98765 43210', '91', '919876543210', '00 prefix with punctuation'],
  ['09876543210', '91', '919876543210', 'leading trunk zero'],
  ['919876543210', '91', '919876543210', 'already international'],
  ['9.19876543210e+11', '91', '919876543210', 'excel scientific notation'],
  ['4155551234', '1', '14155551234', 'US national'],
  ['abc', '91', null, 'not a number'],
  ['123', '91', null, 'too short'],
];

for (const [input, cc, expected, label] of numberCases) {
  assert.strictEqual(contacts.normalizeNumber(input, cc), expected, `${label}: ${input}`);
}
console.log(`numbers: ${numberCases.length} cases pass`);

// ---------------------------------------------------------------- templates

assert.strictEqual(template.render('Hi {{name}}', { name: 'Aman' }), 'Hi Aman');
assert.strictEqual(template.render('Hi {{missing}}!', {}), 'Hi !');
const spun = new Set();
for (let i = 0; i < 60; i++) spun.add(template.render('{a|b|c}', {}));
assert.deepStrictEqual([...spun].sort(), ['a', 'b', 'c'], 'spintax covers every branch');
assert.deepStrictEqual(template.usedVariables('{{a}} {{B}} {{a}}').sort(), ['a', 'b']);
console.log('templates: substitution, spintax and variable discovery pass');

// ---------------------------------------------------------------- send engine

const sent = [];
wa.isReady = () => true;
wa.send = async (number, text) => {
  if (number.endsWith('0003')) {
    const e = new Error('not registered');
    e.code = 'NOT_ON_WHATSAPP';
    throw e;
  }
  if (number.endsWith('0004')) throw new Error('simulated network failure');
  sent.push({ number, text });
};

const campaign = require('../src/campaign');

function makeContacts(n) {
  return Array.from({ length: n }, (_, i) => ({
    number: `91000000000${i + 1}`,
    name: `P${i + 1}`,
    vars: { name: `P${i + 1}` },
  }));
}

function waitForIdle() {
  return new Promise((resolve) => {
    const t = setInterval(() => {
      if (!campaign.running) {
        clearInterval(t);
        resolve();
      }
    }, 50);
  });
}

(async () => {
  // --- outcomes: sent / skipped / failed+retry / opted out ---
  store.saveSettings({ minDelaySec: 0, maxDelaySec: 0, restEvery: 0, dailyCap: 1000, sentToday: 0 });
  store.write('optout.json', ['910000000005']);

  campaign.create(makeContacts(5), { body: 'Hi {{name}}' }, {
    ...store.getSettings(),
    verifyNumbers: false,
  });
  campaign.start();
  await waitForIdle();

  let snap = campaign.snapshot();
  assert.strictEqual(snap.status, 'done');
  assert.deepStrictEqual(snap.counts, { sent: 2, failed: 1, skipped: 2, pending: 0 });

  const byNumber = Object.fromEntries(campaign.state.items.map((i) => [i.number, i]));
  assert.strictEqual(byNumber['910000000003'].status, 'skipped_not_on_whatsapp');
  assert.strictEqual(byNumber['910000000004'].status, 'failed');
  assert.strictEqual(byNumber['910000000004'].attempts, 2, 'failures are retried exactly once');
  assert.strictEqual(byNumber['910000000005'].status, 'skipped_opted_out');
  assert.strictEqual(store.getSettings().sentToday, 2, 'only real sends count to the cap');
  assert.deepStrictEqual(sent.map((s) => s.text), ['Hi P1', 'Hi P2'], 'templates rendered per contact');
  console.log('engine: outcomes, retry-once, opt-out and daily counter pass');

  // --- CSV report ---
  const csv = campaign.reportCsv().split('\n');
  assert.ok(csv[0].startsWith('number,name,status'));
  assert.strictEqual(csv.length, 6, 'header + 5 rows');
  console.log('engine: CSV report pass');

  // --- daily cap stops the run ---
  store.write('optout.json', []);
  store.saveSettings({ dailyCap: 3, sentToday: 0 });
  campaign.clear();
  campaign.create(makeContacts(6).map((c, i) => ({ ...c, number: `9188800000${i}` })), { body: 'hi' }, {
    ...store.getSettings(),
    verifyNumbers: false,
  });
  campaign.start();
  await waitForIdle();
  snap = campaign.snapshot();
  assert.strictEqual(snap.counts.sent, 3, 'stops exactly at the cap');
  assert.strictEqual(snap.status, 'paused', 'cap pauses rather than finishing');
  console.log('engine: daily cap pass');

  // --- pause keeps pending work, and state survives a reload ---
  store.saveSettings({ dailyCap: 1000, sentToday: 0, minDelaySec: 1, maxDelaySec: 1 });
  campaign.clear();
  campaign.create(makeContacts(8).map((c, i) => ({ ...c, number: `9199900000${i}` })), { body: 'hi' }, {
    ...store.getSettings(),
    verifyNumbers: false,
  });
  campaign.start();
  await new Promise((r) => setTimeout(r, 2600));
  campaign.pause();
  await waitForIdle();

  snap = campaign.snapshot();
  assert.strictEqual(snap.status, 'paused');
  assert.ok(snap.counts.sent >= 1 && snap.counts.pending > 0, 'paused mid-run');
  const onDisk = store.read('campaign.json');
  assert.strictEqual(onDisk.items.filter((i) => i.status === 'pending').length, snap.counts.pending,
    'pending work is persisted for resume after a restart');
  console.log('engine: pause and persisted resume state pass');

  console.log('\nALL ENGINE CHECKS PASSED');
})().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
