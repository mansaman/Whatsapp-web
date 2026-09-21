const path = require('path');
const fs = require('fs');

/**
 * Where the app keeps its data.
 *
 * Installed (Electron), the app folder lives under Program Files and is read-only,
 * so everything writable goes to the per-user app-data directory. Run from source,
 * it all stays in the project folder so the repo is self-contained.
 *
 * Electron is resolved lazily and defensively: this module is also loaded by plain
 * `node server.js`, where `electron` is either missing or resolves to a path string.
 */
function resolveRoot() {
  if (process.env.WA_DATA_DIR) return process.env.WA_DATA_DIR;
  try {
    const electron = require('electron');
    if (electron && electron.app && typeof electron.app.getPath === 'function') {
      return electron.app.getPath('userData');
    }
  } catch {
    /* not running under Electron */
  }
  return path.join(__dirname, '..');
}

const ROOT = resolveRoot();

const DATA_DIR = path.join(ROOT, 'data');
const SESSION_DIR = path.join(ROOT, 'sessions');
const UPLOAD_DIR = path.join(ROOT, 'uploads');
const CACHE_DIR = path.join(ROOT, 'cache');

function ensureDirs() {
  for (const dir of [DATA_DIR, SESSION_DIR, UPLOAD_DIR, CACHE_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

module.exports = { ROOT, DATA_DIR, SESSION_DIR, UPLOAD_DIR, CACHE_DIR, ensureDirs };
