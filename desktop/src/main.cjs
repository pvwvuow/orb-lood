// Orblood desktop — Electron main process.
//
// Loads the frontend from a backend the user picks on first launch (editable
// later from the tray). Security model:
//   - sandboxed renderer, context isolation, no node integration
//   - the window may only navigate inside the chosen backend origin
//     (plus the bundled setup page / local error page)
//   - microphone & notifications are granted ONLY to that origin
//   - IPC only answers the setup page, the error page and the backend

const { app, BrowserWindow, ipcMain, shell, Tray, Menu, nativeImage, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

// --- Single-instance lock --------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

// --- Persistent settings ---------------------------------------------------
const userDataDir = app.getPath('userData');
const settingsPath = path.join(userDataDir, 'orblood-settings.json');

function readSettings() {
  try { return JSON.parse(fs.readFileSync(settingsPath, 'utf8')); }
  catch { return {}; }
}

function writeSettings(patch) {
  const next = Object.assign({}, readSettings(), patch || {});
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(next, null, 2));
  return next;
}

const SETUP_FILE = path.join(__dirname, '..', 'renderer', 'setup.html');
const SETUP_URL = pathToFileURL(SETUP_FILE).toString();

function backendOrigin() {
  const b = readSettings().backendUrl;
  if (!b) return null;
  try { return new URL(b).origin; } catch { return null; }
}

function isBackendUrl(raw) {
  const origin = backendOrigin();
  if (!origin) return false;
  try { return new URL(raw).origin === origin; } catch { return false; }
}

function isLocalPage(raw) {
  return typeof raw === 'string' && (raw.split('#')[0].split('?')[0] === SETUP_URL || raw.startsWith('data:text/html'));
}

function openExternalSafe(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol === 'https:' || u.protocol === 'http:') shell.openExternal(u.toString()).catch(() => {});
  } catch { /* ignore */ }
}

const ALLOWED_PERMISSIONS = new Set(['media', 'notifications', 'clipboard-sanitized-write', 'fullscreen']);

function lockDownSession() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const origin = (details && details.requestingUrl) || wc.getURL();
    if (permission === 'media' && details && Array.isArray(details.mediaTypes) && details.mediaTypes.includes('video')) {
      // Voice only: no camera.
      return callback(false);
    }
    callback(ALLOWED_PERMISSIONS.has(permission) && isBackendUrl(origin));
  });
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    return ALLOWED_PERMISSIONS.has(permission) && isBackendUrl(requestingOrigin);
  });
}

// --- Window creation -------------------------------------------------------
let mainWindow = null;
let tray = null;
let isQuitting = false;

function createWindow() {
  const settings = readSettings();
  const bounds = settings.windowBounds || { width: 1320, height: 860 };

  mainWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: 980,
    minHeight: 640,
    show: false,
    backgroundColor: '#020103',
    autoHideMenuBar: true,
    title: 'Orblood',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false
    }
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  const saveBounds = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isFullScreen() || mainWindow.isMinimized()) return;
    writeSettings({ windowBounds: mainWindow.getBounds() });
  };
  mainWindow.on('resize', saveBounds);
  mainWindow.on('move', saveBounds);

  // Close → hide to tray on Windows/Linux so voice stays alive.
  mainWindow.on('close', e => {
    if (isQuitting) return;
    if (process.platform !== 'darwin' && tray) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  // New windows never open inside the app; http(s) links go to the browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url);
    return { action: 'deny' };
  });

  // The window itself may not wander off to another site.
  const guardNav = (event, url) => {
    if (isBackendUrl(url) || isLocalPage(url)) return;
    event.preventDefault();
    openExternalSafe(url);
  };
  mainWindow.webContents.on('will-navigate', guardNav);
  mainWindow.webContents.on('will-redirect', guardNav);

  loadFrontend();
}

function loadFrontend() {
  const backend = (readSettings().backendUrl || '').replace(/\/$/, '');
  if (!backend) {
    mainWindow.loadFile(SETUP_FILE);
    return;
  }
  mainWindow.loadURL(backend + '/?desktop=1').catch(err => showLoadError(backend, err));
}

function showLoadError(url, err) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Orblood</title>
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
    <style>body{font-family:system-ui,-apple-system,sans-serif;background:#020103;color:#f8f0f0;padding:48px;line-height:1.55}
      h1{color:#b91c4a;font-size:1.4rem}
      code{background:rgba(255,255,255,0.05);padding:2px 6px;border-radius:4px}
      button{background:#b91c4a;color:#fff;border:none;padding:10px 18px;border-radius:8px;font-size:1rem;cursor:pointer;margin-top:18px}</style>
    </head><body>
    <h1>Cannot reach Orblood server</h1>
    <p>Tried: <code>${escapeHtml(url)}</code></p>
    <p style="opacity:0.7">${escapeHtml(err && err.message || String(err))}</p>
    <button id="retry">Retry</button>
    <button id="reset" style="background:transparent;color:#f8f0f0;border:1px solid rgba(255,255,255,0.15);margin-left:10px">Change server</button>
    <script>
      document.getElementById('retry').onclick = () => window.orblood.reload();
      document.getElementById('reset').onclick = () => window.orblood.resetBackend();
    </script>
    </body></html>`;
  mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

// --- IPC -------------------------------------------------------------------
// Only our own pages may call into the main process.
function senderUrl(evt) {
  return (evt.senderFrame && evt.senderFrame.url) || '';
}
function fromTrusted(evt) {
  const u = senderUrl(evt);
  return isLocalPage(u) || isBackendUrl(u);
}

ipcMain.handle('orblood:getSettings', (evt) => {
  if (!fromTrusted(evt)) return {};
  const s = readSettings();
  return { backendUrl: s.backendUrl || null, lastBackendUrl: s.lastBackendUrl || null };
});

ipcMain.handle('orblood:setBackendUrl', async (evt, url) => {
  if (!isLocalPage(senderUrl(evt))) return { ok: false, error: 'not allowed' };
  const cleaned = String(url || '').trim().replace(/\/+$/, '');
  let parsed;
  try { parsed = new URL(cleaned); } catch { parsed = null; }
  if (!parsed || !/^https?:$/.test(parsed.protocol)) {
    return { ok: false, error: 'Enter a full URL like https://orblood.ir' };
  }
  if (parsed.protocol === 'http:' && !/^(localhost|127\.0\.0\.1)$/.test(parsed.hostname)) {
    return { ok: false, error: 'Use https:// (plain http only works for localhost)' };
  }
  try {
    const res = await fetch(parsed.origin + '/api/healthz', { method: 'GET' });
    if (!res.ok && res.status !== 503) throw new Error('health check returned ' + res.status);
  } catch (e) {
    return { ok: false, error: 'Could not reach ' + parsed.origin + ' — ' + (e.message || e) };
  }
  writeSettings({ backendUrl: parsed.origin, lastBackendUrl: parsed.origin });
  loadFrontend();
  return { ok: true };
});

ipcMain.handle('orblood:resetBackend', (evt) => {
  if (!fromTrusted(evt)) return { ok: false };
  writeSettings({ backendUrl: null });
  loadFrontend();
  return { ok: true };
});

ipcMain.handle('orblood:reload', (evt) => {
  if (!fromTrusted(evt)) return { ok: false };
  loadFrontend();
  return { ok: true };
});

ipcMain.handle('orblood:openExternal', (evt, url) => {
  if (fromTrusted(evt) && typeof url === 'string') openExternalSafe(url);
});

// --- Tray ------------------------------------------------------------------
function createTray() {
  if (process.platform === 'darwin') return;
  const iconPath = path.join(__dirname, '..', 'build', 'tray.png');
  let img;
  try {
    img = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  } catch { img = nativeImage.createEmpty(); }
  tray = new Tray(img);
  tray.setToolTip('Orblood');
  const menu = Menu.buildFromTemplate([
    { label: 'Show Orblood', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
    { type: 'separator' },
    { label: 'Change server…', click: () => { writeSettings({ backendUrl: null }); loadFrontend(); if (mainWindow) mainWindow.show(); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { isQuitting = true; app.quit(); } }
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } });
}

// --- Lifecycle -------------------------------------------------------------
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
  }
});

app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (event) => event.preventDefault());
});

app.whenReady().then(() => {
  lockDownSession();
  createWindow();
  createTray();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else if (mainWindow) mainWindow.show();
  });
});

app.on('before-quit', () => { isQuitting = true; });

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && isQuitting) app.quit();
});
