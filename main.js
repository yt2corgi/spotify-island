const { app, BrowserWindow, ipcMain, screen, Menu, shell } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const WIN_W = 440;
const WIN_H = 220;

let win = null;
let sidecar = null;
let sidecarBackoff = 1000;
let quitting = false;
const lastMsg = {}; // replay cache: renderer may load after the sidecar's first burst

const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');

function readSettings() {
  try { return JSON.parse(fs.readFileSync(settingsPath(), 'utf8')); }
  catch { return null; }
}

function writeSettings(s) {
  try { fs.writeFileSync(settingsPath(), JSON.stringify(s)); } catch {}
}

function applyLoginItem(enabled) {
  if (app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: enabled, name: 'Ohm' });
  } else {
    // Unpackaged: point the login item at electron.exe with this app dir as the arg.
    app.setLoginItemSettings({
      openAtLogin: enabled,
      name: 'Ohm',
      path: process.execPath,
      args: [__dirname],
    });
  }
}

// productName changed "Spotify Island" -> "Ohm", which moves userData.
function migrateUserData() {
  try {
    const oldDir = path.join(app.getPath('appData'), 'Spotify Island');
    const newDir = app.getPath('userData');
    if (!fs.existsSync(oldDir) || fs.existsSync(path.join(newDir, 'settings.json'))) return;
    fs.mkdirSync(newDir, { recursive: true });
    for (const f of ['settings.json']) {
      const src = path.join(oldDir, f);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(newDir, f));
    }
  } catch {}
}

function initLoginItem() {
  let s = readSettings();
  if (!s) {
    s = { openAtLogin: true };
    writeSettings(s);
  }
  applyLoginItem(!!s.openAtLogin);
  return s;
}

function positionWindow() {
  if (!win) return;
  const d = screen.getPrimaryDisplay();
  win.setBounds({
    x: Math.round(d.bounds.x + (d.bounds.width - WIN_W) / 2),
    y: d.bounds.y,
    width: WIN_W,
    height: WIN_H,
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(true, { forward: true });
  win.setMenu(null);
  positionWindow();

  const hash = process.argv.includes('--demo-expanded') ? 'demo-x'
    : process.argv.includes('--demo') ? 'demo' : undefined;
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), hash ? { hash } : undefined);

  win.once('ready-to-show', () => win.show());
  win.webContents.on('did-finish-load', () => {
    if (lastMsg.art) win.webContents.send('media', lastMsg.art);
    if (lastMsg.state) win.webContents.send('media', lastMsg.state);
    const s = readSettings();
    if (s?.mode && s.mode !== 'dock') win.webContents.send('set-mode', s.mode);
  });
  win.on('closed', () => { win = null; });

  screen.on('display-metrics-changed', positionWindow);
  screen.on('display-added', positionWindow);
  screen.on('display-removed', positionWindow);
}

function sidecarPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'sidecar', 'SmtcBridge.exe')
    : path.join(__dirname, 'sidecar', 'dist', 'SmtcBridge.exe');
}

// Silent auto-update from GitHub Releases (packaged installs only).
function initUpdater() {
  if (!app.isPackaged) return;
  let autoUpdater;
  try { ({ autoUpdater } = require('electron-updater')); } catch { return; }
  autoUpdater.autoDownload = true;
  autoUpdater.on('update-downloaded', () => autoUpdater.quitAndInstall(true, true));
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 30_000);
  setInterval(check, 3 * 60 * 60 * 1000);
}

function startSidecar() {
  const exe = sidecarPath();
  if (!fs.existsSync(exe)) {
    console.error('Sidecar missing. Run: npm run build:sidecar');
    return;
  }
  sidecar = spawn(exe, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });

  let buf = '';
  sidecar.stdout.setEncoding('utf8');
  sidecar.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        lastMsg[msg.type] = msg;
        if (win && !win.isDestroyed()) win.webContents.send('media', msg);
      } catch {}
    }
  });

  sidecar.on('exit', () => {
    sidecar = null;
    if (quitting) return;
    setTimeout(startSidecar, sidecarBackoff);
    sidecarBackoff = Math.min(sidecarBackoff * 2, 15000);
  });
  sidecar.on('spawn', () => { sidecarBackoff = 1000; });
}

const ALLOWED_CMDS = /^(playpause|play|pause|next|prev|shuffle|repeat|seek -?\d{1,10}|vol \d{1,3})$/;

// Hover detection: forwarded mouse events through a click-through transparent
// window are unreliable on Windows, so poll the cursor against the island's
// reported bounds instead (~8Hz; negligible cost).
let zone = null;
let hovering = false;

const DEBUG_HOVER = process.argv.includes('--debug-hover');
let dbgTick = 0;

function startHoverWatch() {
  setInterval(() => {
    if (DEBUG_HOVER && ++dbgTick % 16 === 0) {
      try {
        fs.appendFileSync(path.join(os.tmpdir(), 'island-hover-debug.log'),
          JSON.stringify({
            p: screen.getCursorScreenPoint(),
            b: win && win.getBounds(),
            zone, hovering,
          }) + '\n');
      } catch {}
    }
    if (!win || !zone) return;
    const p = screen.getCursorScreenPoint();
    const b = win.getBounds();
    const pad = 3;
    const inside =
      p.x >= b.x + zone.x - pad && p.x <= b.x + zone.x + zone.w + pad &&
      p.y >= b.y + zone.y - pad && p.y <= b.y + zone.y + zone.h + pad;
    if (inside === hovering) return;
    hovering = inside;
    if (inside) win.setIgnoreMouseEvents(false);
    else win.setIgnoreMouseEvents(true, { forward: true });
    if (!win.isDestroyed()) win.webContents.send('hover-state', inside);
  }, 33);
}

function setupIpc() {
  ipcMain.on('cmd', (_e, cmd) => {
    if (typeof cmd !== 'string' || !ALLOWED_CMDS.test(cmd)) return;
    if (sidecar && sidecar.stdin.writable) sidecar.stdin.write(cmd + '\n');
  });

  ipcMain.on('zone', (_e, r) => {
    if (r && typeof r.x === 'number') zone = r;
  });

  ipcMain.on('save-mode', (_e, mode) => {
    if (!['line', 'dock', 'mini'].includes(mode)) return;
    const s = readSettings() || { openAtLogin: true };
    writeSettings({ ...s, mode });
  });

  ipcMain.on('open-spotify', () => {
    shell.openExternal('spotify:').catch(() => {});
  });

  ipcMain.on('menu', () => {
    if (!win) return;
    const s = readSettings() || { openAtLogin: true };
    const menu = Menu.buildFromTemplate([
      { label: 'Open Spotify', click: () => shell.openExternal('spotify:').catch(() => {}) },
      { type: 'separator' },
      {
        label: s.mode === 'line' ? 'Show the dock' : 'Minimize to a line',
        click: () => {
          const mode = s.mode === 'line' ? 'dock' : 'line';
          writeSettings({ ...s, mode });
          if (win && !win.isDestroyed()) win.webContents.send('set-mode', mode);
        },
      },
      {
        label: 'Start with Windows',
        type: 'checkbox',
        checked: !!s.openAtLogin,
        click: (item) => {
          writeSettings({ ...s, openAtLogin: item.checked });
          applyLoginItem(item.checked);
        },
      },
      { type: 'separator' },
      { label: 'Quit Island', click: () => app.quit() },
    ]);
    menu.popup({ window: win });
  });
}

// The island's animations should play even when Windows' "animation
// effects" accessibility setting is off (the CSS also ignores it).
app.commandLine.appendSwitch('force-prefers-no-reduced-motion');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.whenReady().then(() => {
    try { os.setPriority(os.constants.priority.PRIORITY_ABOVE_NORMAL); } catch {}
    migrateUserData();
    initLoginItem();
    setupIpc();
    createWindow();
    startSidecar();
    startHoverWatch();
    initUpdater();
  });
}

app.on('will-quit', () => {
  quitting = true;
  if (sidecar) { try { sidecar.kill(); } catch {} }
});

app.on('window-all-closed', () => app.quit());
