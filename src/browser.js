const fs = require('fs');
const path = require('path');

/**
 * Find a Chromium to drive.
 *
 * Bundling one would add ~170 MB to the installer, so instead we look for a browser
 * that is almost certainly already there. On Windows, Edge ships with the OS and is
 * Chromium underneath, which makes it a reliable last resort.
 *
 * Order: explicit override -> browser shipped beside the installed app ->
 * Puppeteer's download -> system Chrome -> system Edge.
 */
function findChrome() {
  const candidates = [];

  if (process.env.CHROME_PATH) candidates.push(process.env.CHROME_PATH);

  // A browser placed next to the packaged app by electron-builder's extraResources
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'chrome', 'chrome.exe'));
  }

  try {
    const p = require('puppeteer').executablePath();
    if (p) candidates.push(p);
  } catch {
    /* puppeteer may not have a download in a packaged build */
  }

  const programFiles = [
    process.env['PROGRAMFILES'],
    process.env['PROGRAMFILES(X86)'],
    process.env['LOCALAPPDATA'],
  ].filter(Boolean);

  for (const base of programFiles) {
    candidates.push(path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    candidates.push(path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  }

  // macOS / Linux, for running from source
  candidates.push(
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium'
  );

  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) return candidate;
    } catch {
      /* unreadable path, keep looking */
    }
  }
  return null;
}

module.exports = { findChrome };
