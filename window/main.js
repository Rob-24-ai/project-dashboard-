const { app, BrowserWindow, WebContentsView, ipcMain, nativeTheme, screen, Tray, Menu, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

// App identity (best-effort; unsigned dev shell keeps a generic dock icon).
app.setName('AI Code');

const TOWER_URL = 'http://127.0.0.1:4433';
const BG = '#13151b';
const BOUNDS_FILE = path.join(__dirname, 'bounds.json');
const SHELL = path.join(__dirname, 'shell.html');
const LOADER = 'file://' + path.join(__dirname, 'loader.html');

const DEFAULT_BOUNDS = { width: 980, height: 784 };
const MIN_WIDTH = 260;
const MIN_HEIGHT = 90;
const STRIP_HEIGHT = 24; // slim custom titlebar strip height in px

let win = null;        // the BrowserWindow (hosts the shell titlebar)
let view = null;       // WebContentsView holding the Tower page
let alwaysOnTop = true;
let retryTimer = null;
let saveTimer = null;
let towerLoaded = false;
let lastLayout = '';
let tray = null;
let quitting = false;

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function readBounds() {
  try {
    const b = JSON.parse(fs.readFileSync(BOUNDS_FILE, 'utf8'));
    if (b && typeof b.width === 'number' && typeof b.height === 'number') return b;
  } catch (e) { /* no saved bounds yet */ }
  return DEFAULT_BOUNDS;
}

function saveBounds() {
  if (!win || win.isDestroyed()) return;
  try {
    const b = win.getBounds();
    fs.writeFileSync(BOUNDS_FILE, JSON.stringify({ ...b, layoutVersion: 4 }, null, 2));
    log(`bounds saved: ${JSON.stringify(b)}`);
  } catch (e) {
    log(`bounds save failed: ${e.message}`);
  }
}

function saveBoundsDebounced() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveTimer = null; saveBounds(); }, 400);
}

function showTower() {
  if (!win || win.isDestroyed()) { createWindow(); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function hideTower() {
  if (!win || win.isDestroyed()) return;
  saveBounds();
  win.hide();
}

function createTray() {
  if (tray) return;
  const icon = nativeImage.createFromPath(path.join(__dirname, 'trayTemplate.png'));
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip('Tower');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show Tower', click: showTower },
    { label: 'Hide Tower', click: hideTower },
    { type: 'separator' },
    { label: 'Quit Tower', click: () => app.quit() }
  ]));
  tray.on('double-click', showTower);
}

// Keep the Tower view sized to fill the window below the titlebar strip.
function layoutView() {
  if (!win || win.isDestroyed() || !view) return;
  const [w, h] = win.getContentSize();
  view.setBounds({ x: 0, y: STRIP_HEIGHT, width: w, height: Math.max(0, h - STRIP_HEIGHT) });
}

function loadTower() {
  if (!view) return;
  log(`attempting to load ${TOWER_URL}`);
  view.webContents.loadURL(TOWER_URL);
}

function scheduleRetry() {
  if (retryTimer) return;
  retryTimer = setInterval(() => {
    if (!view) return;
    log('retrying Tower load...');
    view.webContents.loadURL(TOWER_URL);
  }, 2000);
}

function stopRetry() {
  if (retryTimer) { clearInterval(retryTimer); retryTimer = null; }
}

function createWindow() {
  if (win && !win.isDestroyed()) return;
  nativeTheme.themeSource = 'dark';
  const saved = readBounds();
  const hasPosition = Number.isFinite(saved.x) && Number.isFinite(saved.y);
  const display = hasPosition
    ? screen.getDisplayMatching({ x: saved.x, y: saved.y, width: saved.width, height: saved.height })
    : screen.getPrimaryDisplay();
  const area = display.workArea;
  // Adopt a readable dashboard once, then retain the user's chosen window size.
  const migrated = saved.layoutVersion >= 4;
  const width = Math.min(area.width, Math.max(390, migrated ? saved.width : DEFAULT_BOUNDS.width));
  const height = Math.min(area.height, Math.max(260, migrated ? saved.height : DEFAULT_BOUNDS.height));
  const x = migrated && hasPosition
    ? Math.max(area.x, Math.min(saved.x, area.x + area.width - width))
    : area.x + Math.round((area.width - width) / 2);
  const y = migrated && hasPosition
    ? Math.max(area.y, Math.min(saved.y, area.y + area.height - height))
    : area.y + Math.round((area.height - height) / 2);

  win = new BrowserWindow({
    width,
    height,
    x,
    y,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    backgroundColor: BG,
    frame: false,
    titleBarStyle: 'hidden',
    alwaysOnTop: alwaysOnTop,
    // A click on the panel from another app should press the button, not only raise the window.
    acceptFirstMouse: true,
    title: 'Tower · On your desk',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  saveBoundsDebounced();
  win.setAlwaysOnTop(alwaysOnTop, 'screen-saver');
  win.setVisibleOnAllWorkspaces(alwaysOnTop, { visibleOnFullScreen: true });

  // The shell HTML draws the slim titlebar strip (drag region + pin + close).
  win.loadFile(SHELL);

  // The Tower page lives in a child content view below the strip.
  view = new WebContentsView({
    // The page plays two quiet sound cues (a request, a finished turn) without waiting for a click.
    webPreferences: { preload:path.join(__dirname, 'content-preload.js'), contextIsolation: true, nodeIntegration: false, autoplayPolicy: 'no-user-gesture-required' }
  });
  view.setBackgroundColor(BG);
  win.contentView.addChildView(view);

  // Start on the dark loader so there is never a white flash.
  view.webContents.loadURL(LOADER);
  layoutView();

  win.once('ready-to-show', () => {
    win.show();
    loadTower();
  });

  view.webContents.on('did-finish-load', () => {
    const current = view.webContents.getURL();
    if (current.startsWith(TOWER_URL)) {
      towerLoaded = true;
      log(`Tower page loaded: ${current}`);
      stopRetry();
    }
  });

  view.webContents.on('did-fail-load', (e, code, desc, url) => {
    if (code === -3) return; // aborted (rapid reload) — ignore
    if (url && url.startsWith(TOWER_URL)) {
      log(`Tower load failed (${code} ${desc}); showing loader, will retry`);
      view.webContents.loadURL(LOADER);
      scheduleRetry();
    }
  });

  win.on('resize', () => { layoutView(); saveBoundsDebounced(); });
  win.on('move', saveBoundsDebounced);

  win.on('close', event => {
    if (quitting) return;
    event.preventDefault();
    hideTower();
  });

  win.on('closed', () => {
    stopRetry();
    view = null;
    win = null;
    lastLayout = '';
  });
}

ipcMain.on('tower-layout', (event, metrics) => {
  if (!win || win.isDestroyed() || !view || event.sender !== view.webContents ||
      event.senderFrame !== view.webContents.mainFrame) return;
  // Only the fixed local monitor page owns this bridge, never the loader or another origin.
  try { if (new URL(event.senderFrame.url).origin !== TOWER_URL) return; }
  catch (_) { return; }
  if (!metrics || !['focus', 'all', 'desk'].includes(metrics.view) ||
      !Number.isFinite(metrics.width) || !Number.isFinite(metrics.height) ||
      metrics.width <= 0 || metrics.height <= 0) return;
  // Dashboard content scrolls inside the window. Polls and view changes must
  // never resize the user's workspace; initial size is owned by createWindow.
  if (metrics.view === 'desk') return;
  const area = screen.getDisplayMatching(win.getBounds()).workArea;
  const width = Math.min(area.width, Math.max(MIN_WIDTH, Math.min(620, Math.ceil(metrics.width))));
  const height = Math.min(area.height, Math.max(MIN_HEIGHT, Math.min(metrics.view === 'focus' ? 480 : 600, Math.ceil(metrics.height) + STRIP_HEIGHT)));
  const signature = `${metrics.view}:${width}:${height}`;
  if (signature === lastLayout) return; // Polling must not fight a user's manual resize.
  lastLayout = signature;
  const bounds = win.getBounds();
  const x = Math.max(area.x, Math.min(bounds.x, area.x + area.width - width));
  const y = Math.max(area.y, Math.min(bounds.y, area.y + area.height - height));
  win.setBounds({x, y, width, height});
});

// IPC from the titlebar strip.
ipcMain.handle('toggle-pin', () => {
  alwaysOnTop = !alwaysOnTop;
  if (win && !win.isDestroyed()) {
    win.setAlwaysOnTop(alwaysOnTop, 'screen-saver');
    win.setVisibleOnAllWorkspaces(alwaysOnTop, { visibleOnFullScreen: true });
  }
  log(`always-on-top -> ${alwaysOnTop}`);
  return alwaysOnTop;
});

ipcMain.handle('get-pin', () => alwaysOnTop);

// The page holds its row order while the pointer is over the panel. CSS hover
// stops updating while another app is active, so the main process answers instead.
ipcMain.handle('pointer-inside', event => {
  if (!win || win.isDestroyed() || !view || event.sender !== view.webContents) return false;
  const point = screen.getCursorScreenPoint(), bounds = win.getBounds();
  return point.x >= bounds.x && point.x < bounds.x + bounds.width && point.y >= bounds.y && point.y < bounds.y + bounds.height;
});

ipcMain.handle('close-window', () => {
  log('close requested from titlebar; hiding Tower');
  hideTower();
});

// Reopening the launcher brings the existing monitor back instead of creating
// a second menu bar icon and another polling window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => app.whenReady().then(showTower));
  app.whenReady().then(() => {
    log('app ready');
    createTray();
    createWindow();
  });
  app.on('activate', showTower);
}

// The menu bar remains available after every window has been hidden or closed.
app.on('window-all-closed', () => {});
app.on('before-quit', () => {
  quitting = true;
  stopRetry();
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  saveBounds();
});
