import { app, BrowserWindow, Menu, Notification, Tray, nativeImage, nativeTheme, safeStorage, shell } from 'electron';
import { autoUpdater } from 'electron-updater';
import path from 'path';
import { Monitor } from '../core/monitor';
import { startServer } from '../core/server';
import type { SecretBox } from '../core/config';
import { plainSecretBox } from '../core/config';
import type { UpdateInfo } from '../core/types';

const isDev = process.argv.includes('--dev');
const startHidden = process.argv.includes('--hidden');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setAppUserModelId('com.jlmotorsport.parkwifimonitor');
  void app.whenReady().then(boot);
}

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let monitor: Monitor;
let port = 8787;
let quitting = false;
let update: UpdateInfo = { status: 'idle' };

const assets = path.join(__dirname, '..', '..', '..', 'assets');
const icon = (name: string) => nativeImage.createFromPath(path.join(assets, name));

const box: SecretBox = {
  encrypt: (p) =>
    safeStorage.isEncryptionAvailable() ? 'enc:' + safeStorage.encryptString(p).toString('base64') : plainSecretBox.encrypt(p),
  decrypt: (s) =>
    s.startsWith('enc:') ? safeStorage.decryptString(Buffer.from(s.slice(4), 'base64')) : plainSecretBox.decrypt(s),
};

function dashboardUrl() {
  return isDev ? 'http://localhost:5173' : `http://127.0.0.1:${port}/`;
}

function showWindow() {
  if (win && !win.isDestroyed()) {
    win.show();
    win.focus();
    return;
  }
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 380,
    title: 'Park WiFi Monitor',
    icon: icon('icon.png'),
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f1115' : '#f3f4f6',
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  void win.loadURL(dashboardUrl());
  win.once('ready-to-show', () => win?.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  // Closing the window keeps monitoring running in the tray.
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win?.hide();
    }
  });
}

function autostartEnabled(): boolean | null {
  if (process.platform !== 'win32' && process.platform !== 'darwin') return null;
  return app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin;
}

function setAutostart(on: boolean) {
  app.setLoginItemSettings({ openAtLogin: on, args: ['--hidden'] });
  refreshTray();
}

function refreshTray() {
  if (!tray) return;
  const sev = monitor.worstSeverity();
  const n = monitor.alerts.active.size;
  tray.setImage(icon(`tray-${sev === 'good' ? 'good' : sev === 'warning' ? 'warning' : 'critical'}.png`));
  tray.setToolTip(n ? `Park WiFi Monitor: ${n} alert${n > 1 ? 's' : ''}` : 'Park WiFi Monitor: all OK');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open dashboard', click: showWindow },
      { label: 'Poll now', click: () => void monitor.pollNow() },
      { type: 'separator' },
      { label: 'Start with Windows', type: 'checkbox', checked: !!autostartEnabled(), click: (i) => setAutostart(i.checked) },
      { label: updateLabel(), enabled: update.status !== 'checking' && update.status !== 'downloading', click: updateClick },
      { type: 'separator' },
      { label: `Version ${app.getVersion()}`, enabled: false },
      {
        label: 'Quit',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
}

function updateLabel() {
  switch (update.status) {
    case 'ready':
      return `Restart to update to ${update.version}`;
    case 'downloading':
      return `Downloading update ${update.progress ?? 0}%`;
    case 'checking':
      return 'Checking for updates…';
    default:
      return 'Check for updates';
  }
}

function updateClick() {
  if (update.status === 'ready') installUpdate();
  else checkUpdate();
}

function setUpdate(u: UpdateInfo) {
  update = u;
  refreshTray();
  monitor.emit('change');
}

function checkUpdate() {
  if (!app.isPackaged) return setUpdate({ status: 'unsupported', message: 'Updates only work in the installed app' });
  void autoUpdater.checkForUpdates().catch((e: Error) => setUpdate({ status: 'error', message: e.message }));
}

function installUpdate() {
  quitting = true;
  autoUpdater.quitAndInstall(true, true);
}

function setupUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => setUpdate({ status: 'checking' }));
  autoUpdater.on('update-available', (i) => setUpdate({ status: 'downloading', version: i.version, progress: 0 }));
  autoUpdater.on('update-not-available', () => setUpdate({ status: 'none' }));
  autoUpdater.on('download-progress', (p) => setUpdate({ ...update, status: 'downloading', progress: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (i) => {
    setUpdate({ status: 'ready', version: i.version });
    const n = new Notification({ title: 'Park WiFi Monitor update ready', body: `Version ${i.version} installs when you restart the app. Click to restart now.` });
    n.on('click', installUpdate);
    n.show();
  });
  autoUpdater.on('error', (e) => setUpdate({ status: 'error', message: e?.message ?? String(e) }));
  checkUpdate();
  setInterval(checkUpdate, 6 * 3600 * 1000);
}

async function boot() {
  monitor = new Monitor(app.getPath('userData'), box, app.getVersion(), {
    notify: (a) => {
      if (!Notification.isSupported()) return;
      const n = new Notification({ title: a.title, body: a.detail, urgency: a.severity === 'critical' ? 'critical' : 'normal' });
      n.on('click', showWindow);
      n.show();
    },
    update: () => update,
    autostart: autostartEnabled,
  });

  const uiDir = path.join(__dirname, '..', '..', 'ui');
  const srv = await startServer(monitor, uiDir, { checkUpdate, installUpdate, setAutostart });
  port = srv.port;

  tray = new Tray(icon('tray-good.png'));
  tray.on('click', showWindow);
  monitor.on('change', refreshTray);
  refreshTray();

  // First run: start with Windows by default so monitoring survives a reboot.
  if (app.isPackaged && !monitor.cfg.config.autostartInitialised) {
    setAutostart(true);
    monitor.cfg.config.autostartInitialised = true;
    monitor.cfg.save();
  }

  monitor.start();
  setupUpdater();
  if (!startHidden) showWindow();

  app.on('second-instance', showWindow);
  app.on('window-all-closed', () => {
    /* stay alive in the tray */
  });
  app.on('before-quit', () => {
    quitting = true;
    monitor.stop();
    srv.close();
  });
}
