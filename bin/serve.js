#!/usr/bin/env node
/** Run the app as a plain local server (no Electron window). */
const { startServer } = require('../server');

startServer({ openBrowser: !process.env.NO_OPEN }).catch((err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port is already in use. Try:  set PORT=3100 && npm start\n`);
  } else {
    console.error('Failed to start:', err.message);
  }
  process.exit(1);
});
