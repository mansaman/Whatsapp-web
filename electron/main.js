const { app, BrowserWindow, shell, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

/**
 * A packaged Electron app has nowhere to print a stack trace, so anything fatal
 * goes to a file the user (or a support request) can actually find.
 */
const CRASH_LOG = path.join(os.tmpdir(), 'whatsapp-bulk-sender-startup.log');
function logStartup(message) {
  try {
    fs.appendFileSync(CRASH_LOG, `[${new Date().toISOString()}] ${message}\n`);
  } catch {
    /* logging must never be the thing that breaks startup */
  }
}
process.on('uncaughtException', (err) => {
  logStartup(`uncaughtException: ${err && err.stack ? err.stack : err}`);
  try {
    dialog.showErrorBox('WhatsApp Bulk Sender crashed', String((err && err.message) || err));
  } catch {}
  app.exit(1);
});
logStartup(`--- launch (packaged=${app.isPackaged}) ---`);

// Only one copy may run: two instances would fight over the same WhatsApp session
// directory and the same port.
if (!app.requestSingleInstanceLock()) {
  logStartup('another instance holds the lock; exiting');
  app.quit();
  return;
}
logStartup('single-instance lock acquired');

let mainWindow = null;
let server = null;
let appUrl = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 880,
    minWidth: 900,
    minHeight: 640,
    show: false,
    backgroundColor: '#0e1117',
    title: 'WhatsApp Bulk Sender',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => (mainWindow = null));

  // Google sign-in and any other external link opens in the real browser,
  // never inside the app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(appUrl)) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(appUrl)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  return mainWindow;
}

function buildMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Open data folder',
          click: () => shell.openPath(app.getPath('userData')),
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'About',
          click: () =>
            dialog.showMessageBox({
              type: 'info',
              title: 'WhatsApp Bulk Sender',
              message: `WhatsApp Bulk Sender ${app.getVersion()}`,
              detail:
                'Sends WhatsApp messages to a contact list through your own WhatsApp Web session.\n\n' +
                'Bulk messaging is against WhatsApp’s Terms of Service and your number can be banned. ' +
                'Keep the default delays and only message people who expect to hear from you.',
            }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  logStartup('app ready');
  buildMenu();
  const win = createWindow();

  try {
    // Required before the server module loads, so paths.js resolves userData.
    logStartup('window created; loading server module');
    server = require('../server');
    logStartup('server module loaded');
    // A stable port keeps the Google redirect URI predictable; fall back to any
    // free port if something else already holds it.
    let started;
    try {
      started = await server.startServer({ port: 3000 });
    } catch (err) {
      if (err.code !== 'EADDRINUSE') throw err;
      started = await server.startServer({ port: 0 });
    }
    appUrl = started.url;
    logStartup('server listening at ' + appUrl);
    await win.loadURL(appUrl);
    logStartup('window loaded');
  } catch (err) {
    logStartup('startup failed: ' + (err && err.stack ? err.stack : err));
    dialog.showErrorBox(
      'Could not start',
      `The app failed to start.\n\n${err && err.message ? err.message : err}`
    );
    app.quit();
  }
});

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on('window-all-closed', async () => {
  if (server) await server.shutdown().catch(() => {});
  app.quit();
});

app.on('before-quit', async () => {
  if (server) await server.shutdown().catch(() => {});
});
