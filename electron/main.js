// Electron entry point for the ORBLOOD desktop app.
//
//   1. Direct connection to orblood.ir (no URL prompt)
//   2. Refresh + update buttons in the bottom-left
//   3. Update check against this repo's GitHub releases
//
// Security: sandboxed renderer, context isolation, navigation locked to
// the app origin, microphone only for the app origin, update downloads
// only from this repo's release assets.

const { app, BrowserWindow, shell, ipcMain, dialog, session } = require('electron');
const path = require('node:path');
const https = require('node:https');

// Configuration
const APP_URL = 'https://orblood.ir';
const APP_ORIGIN = new URL(APP_URL).origin;
const GITHUB_REPO = 'pvwvuow/orb-lood';
const UPDATE_CHECK_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
// electron-builder artifactName in package.json: ORBLOOD-Setup-${version}.exe
const ASSET_RE = /^ORBLOOD-Setup-[0-9][0-9A-Za-z.\-]*\.exe$/;

let mainWindow = null;
let latestVersion = null;
let downloadUrl = null;

function isAppUrl(raw) {
  try { return new URL(raw).origin === APP_ORIGIN; } catch (_) { return false; }
}

// Only http(s) links leave the app, and only to the system browser.
function openExternalSafe(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol === 'https:' || u.protocol === 'http:') shell.openExternal(u.toString()).catch(() => {});
  } catch (_) { /* ignore malformed */ }
}

// "1.2.10" > "1.2.9"; non-numeric parts compare as 0.
function isNewer(remote, current) {
  const a = String(remote).split(/[.\-+]/).map(n => parseInt(n, 10) || 0);
  const b = String(current).split(/[.\-+]/).map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return false;
}

// Check for updates from this repo's GitHub releases.
function checkForUpdates() {
  return new Promise((resolve) => {
    https.get(UPDATE_CHECK_URL, {
      headers: { 'User-Agent': 'Orblood-Desktop', 'Accept': 'application/vnd.github+json' },
      timeout: 10_000
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; if (data.length > 2e6) res.destroy(); });
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) return resolve({ available: false });
          const release = JSON.parse(data);
          if (release.draft || release.prerelease) return resolve({ available: false });
          const remoteVersion = String(release.tag_name || '').replace(/^v/, '');
          const asset = (release.assets || []).find(a =>
            ASSET_RE.test(a.name) &&
            /^https:\/\/github\.com\/pvwvuow\/orb-lood\/releases\/download\//.test(a.browser_download_url || ''));
          if (remoteVersion && asset && isNewer(remoteVersion, app.getVersion())) {
            latestVersion = remoteVersion;
            downloadUrl = asset.browser_download_url;
            if (mainWindow) {
              mainWindow.webContents.send('update-available', { version: remoteVersion, url: downloadUrl });
            }
            return resolve({ available: true, version: remoteVersion });
          }
          resolve({ available: false, version: remoteVersion });
        } catch (e) {
          console.error('[update] Failed to parse release:', e);
          resolve({ available: false });
        }
      });
    }).on('timeout', function () { this.destroy(); })
      .on('error', (e) => {
        console.error('[update] Check failed:', e.message);
        resolve({ available: false });
      });
  });
}

function downloadUpdate() {
  if (!downloadUrl) return;
  shell.openExternal(downloadUrl).catch(() => {
    dialog.showErrorBox('Download Failed', 'Could not open the download link:\n' + downloadUrl);
  });
}

function lockDownSession() {
  const ses = session.defaultSession;
  // Microphone (voice) only for our own origin; everything else denied.
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const origin = (details && details.requestingUrl) || wc.getURL();
    const allowed = ['media', 'notifications', 'clipboard-sanitized-write', 'fullscreen'];
    callback(isAppUrl(origin) && allowed.includes(permission));
  });
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    return isAppUrl(requestingOrigin) && ['media', 'notifications', 'clipboard-sanitized-write', 'fullscreen'].includes(permission);
  });
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 480,
    minHeight: 600,
    backgroundColor: '#020103',
    autoHideMenuBar: true,
    title: 'ORBLOOD',
    icon: path.join(__dirname, '../public/favicon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false
    }
  });

  // New windows: only our own origin opens inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAppUrl(url)) return { action: 'allow' };
    openExternalSafe(url);
    return { action: 'deny' };
  });

  // The main window must never navigate away from the app.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url)) { event.preventDefault(); openExternalSafe(url); }
  });
  mainWindow.webContents.on('will-redirect', (event, url) => {
    if (!isAppUrl(url)) { event.preventDefault(); openExternalSafe(url); }
  });

  // Inject the desktop controls after page loads (only on our origin).
  mainWindow.webContents.on('did-finish-load', () => {
    if (!isAppUrl(mainWindow.webContents.getURL())) return;
    mainWindow.webContents.insertCSS(`
      .electron-controls { position: fixed; bottom: 20px; left: 20px; z-index: 999999; display: flex; gap: 10px; }
      .electron-btn {
        width: 40px; height: 40px; border-radius: 50%;
        background: rgba(20, 20, 30, 0.95); border: 1px solid rgba(139, 92, 246, 0.3);
        backdrop-filter: blur(10px); display: flex; align-items: center; justify-content: center;
        cursor: pointer; transition: all 0.2s ease; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
      }
      .electron-btn:hover { background: rgba(139, 92, 246, 0.2); border-color: rgba(139, 92, 246, 0.6); transform: translateY(-2px); }
      .electron-btn:active { transform: translateY(0); }
      .electron-btn svg { width: 18px; height: 18px; stroke: rgba(139, 92, 246, 0.9); fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
      .electron-btn.update-available { animation: orbPulse 2s ease-in-out infinite; }
      @keyframes orbPulse { 0%, 100% { box-shadow: 0 4px 12px rgba(139, 92, 246, 0.3); } 50% { box-shadow: 0 4px 20px rgba(139, 92, 246, 0.6); } }
    `);

    mainWindow.webContents.executeJavaScript(`
      (function() {
        if (!window.electronAPI) return;
        const existing = document.querySelector('.electron-controls');
        if (existing) existing.remove();
        const controls = document.createElement('div');
        controls.className = 'electron-controls';
        const refreshBtn = document.createElement('button');
        refreshBtn.className = 'electron-btn';
        refreshBtn.title = 'Refresh';
        refreshBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/></svg>';
        refreshBtn.onclick = () => window.electronAPI.refresh();
        const updateBtn = document.createElement('button');
        updateBtn.className = 'electron-btn';
        updateBtn.title = 'Check for updates';
        updateBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>';
        updateBtn.onclick = () => window.electronAPI.checkUpdate();
        controls.appendChild(refreshBtn);
        controls.appendChild(updateBtn);
        document.body.appendChild(controls);
        window.electronAPI.onUpdateAvailable((data) => {
          updateBtn.classList.add('update-available');
          updateBtn.title = 'Update available: v' + String(data.version) + ' (click to download)';
          updateBtn.onclick = () => window.electronAPI.downloadUpdate();
        });
      })();
    `).catch(() => {});
  });

  await mainWindow.loadURL(APP_URL);

  setTimeout(() => { checkForUpdates(); }, 3000);

  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

// IPC handlers — only accept calls from our own page.
const fromApp = (event) => isAppUrl(event.senderFrame ? event.senderFrame.url : '');

ipcMain.handle('refresh', (event) => {
  if (fromApp(event) && mainWindow) mainWindow.reload();
});

ipcMain.handle('check-update', async (event) => {
  if (!fromApp(event)) return { available: false };
  const result = await checkForUpdates();
  if (result.available) return { available: true, version: latestVersion, url: downloadUrl };
  dialog.showMessageBox(mainWindow, {
    type: 'info', title: 'No Updates', message: 'You are running the latest version.', buttons: ['OK']
  });
  return { available: false };
});

ipcMain.handle('download-update', (event) => {
  if (fromApp(event)) downloadUpdate();
});

// Single instance: a second launch focuses the existing window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
  });

  app.whenReady().then(() => {
    lockDownSession();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

// Block <webview> and any non-app web contents from getting privileges.
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (event) => event.preventDefault());
});

app.on('window-all-closed', () => {
  app.quit();
});
