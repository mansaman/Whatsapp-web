const fs = require('fs');
const Papa = require('papaparse');
const XLSX = require('xlsx');

/**
 * Parse an uploaded CSV/XLSX into { headers, rows } where each row is a plain object.
 */
function parseFile(filePath, originalName) {
  const ext = (originalName.split('.').pop() || '').toLowerCase();

  if (ext === 'csv' || ext === 'txt') {
    const text = fs.readFileSync(filePath, 'utf8');
    const out = Papa.parse(text.trim(), { header: true, skipEmptyLines: true });
    const headers = out.meta.fields || [];
    return { headers, rows: out.data };
  }

  if (ext === 'xlsx' || ext === 'xls') {
    const wb = XLSX.readFile(filePath);
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
    const headers = rows.length ? Object.keys(rows[0]) : [];
    return { headers, rows };
  }

  throw new Error(`Unsupported file type: .${ext}. Use CSV or XLSX.`);
}

/**
 * Parse pasted text. Each line is "number" or "number,name" or "number<tab>name".
 */
function parsePasted(text) {
  const rows = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/[,\t;]/).map((p) => p.trim());
      return { number: parts[0] || '', name: parts[1] || '' };
    });
  return { headers: ['number', 'name'], rows };
}

/**
 * Turn a raw phone string into digits-only international form.
 * Strips spaces/punctuation, drops a leading +, 00 or a single national 0,
 * then prepends the default country code if the number looks national.
 */
function normalizeNumber(raw, countryCode = '91') {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim();
  if (!s) return null;

  // Excel sometimes hands numbers back as 9.19e+11
  if (/e\+/i.test(s) && !isNaN(Number(s))) s = Number(s).toFixed(0);

  s = s.replace(/[^\d+]/g, '');
  if (s.startsWith('+')) s = s.slice(1);
  else if (s.startsWith('00')) s = s.slice(2);

  s = s.replace(/\D/g, '');
  if (!s) return null;

  const cc = String(countryCode).replace(/\D/g, '');

  // National form with a trunk 0 (e.g. 098xxxxxxxx)
  if (s.length > 1 && s.startsWith('0')) s = s.replace(/^0+/, '');

  // Only treat it as already-international if it both starts with the country code AND is
  // long enough to be cc + a full national number. A 10-digit Indian number that happens to
  // start with "91" is national, not international.
  const alreadyInternational = s.startsWith(cc) && s.length >= cc.length + 9;
  if (!alreadyInternational) s = cc + s;

  if (s.length < cc.length + 7 || s.length > 15) return null;
  return s;
}

/**
 * Apply a column mapping to parsed rows and produce the send-ready contact list.
 * mapping = { number: 'Phone', name: 'Full Name' }
 * Every other column is carried through as a template variable.
 */
function buildContacts(rows, mapping, countryCode, optOuts = []) {
  const seen = new Set();
  const contacts = [];
  const invalid = [];
  let duplicates = 0;
  let optedOut = 0;

  rows.forEach((row, i) => {
    const rawNumber = row[mapping.number];
    const number = normalizeNumber(rawNumber, countryCode);

    if (!number) {
      invalid.push({ row: i + 2, value: rawNumber ?? '', reason: 'not a valid phone number' });
      return;
    }
    if (seen.has(number)) {
      duplicates++;
      return;
    }
    seen.add(number);

    if (optOuts.includes(number)) {
      optedOut++;
      return;
    }

    const vars = {};
    for (const [key, value] of Object.entries(row)) {
      if (key === mapping.number) continue;
      vars[slug(key)] = String(value ?? '').trim();
    }
    const name = mapping.name ? String(row[mapping.name] ?? '').trim() : '';
    vars.name = name || vars.name || '';
    vars.number = number;

    contacts.push({ number, name: vars.name, vars });
  });

  return {
    contacts,
    stats: {
      total: rows.length,
      valid: contacts.length,
      invalid: invalid.length,
      duplicates,
      optedOut,
      invalidSample: invalid.slice(0, 20),
    },
  };
}

/** Header -> template variable name: "Full Name" becomes "full_name". */
function slug(header) {
  return String(header)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

module.exports = { parseFile, parsePasted, normalizeNumber, buildContacts, slug };
