import { app, BrowserWindow, Menu, clipboard, ipcMain, net, protocol, shell } from 'electron';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.join(__dirname, 'src');
const APP_SCHEME = 'idupi';
const APP_HOST = 'app';
const isDev = process.argv.includes('--dev');

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
]);

let mainWindow = null;

function registerAppProtocol() {
  protocol.handle(APP_SCHEME, async (request) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url).pathname);
    } catch {
      return new Response('Bad request', { status: 400 });
    }
    if (!pathname || pathname === '/') pathname = '/index.html';

    const resolved = path.normalize(path.join(SRC_DIR, pathname));
    if (resolved !== SRC_DIR && !resolved.startsWith(SRC_DIR + path.sep)) {
      return new Response('Forbidden', { status: 403 });
    }

    try {
      return await net.fetch(pathToFileURL(resolved).toString());
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

function windowFromEvent(event) {
  return BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
}

function broadcastFullscreen(win) {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('window:fullscreen-changed', win.isFullScreen());
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 620,
    show: false,
    title: 'Remote PC',
    backgroundColor: '#0b0f16',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: false,
      // El renderer solo carga contenido local, pero habla con un idupi-server
      // arbitrario (host/puerto elegidos por el usuario) que no envía cabeceras
      // CORS. Sin esto, el preflight de `Authorization: Bearer` bloquea toda la API.
      webSecurity: false,
    },
  });

  win.removeMenu();
  win.once('ready-to-show', () => win.show());
  win.on('enter-full-screen', () => broadcastFullscreen(win));
  win.on('leave-full-screen', () => broadcastFullscreen(win));
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11') {
      event.preventDefault();
      win.setFullScreen(!win.isFullScreen());
    }
    if (input.key === 'F12' && isDev) {
      event.preventDefault();
      win.webContents.toggleDevTools();
    }
  });

  if (isDev) win.webContents.openDevTools({ mode: 'detach' });

  win.loadURL(`${APP_SCHEME}://${APP_HOST}/index.html`);
  mainWindow = win;
  return win;
}

ipcMain.handle('window:set-fullscreen', (event, value) => {
  const win = windowFromEvent(event);
  if (!win) return false;
  win.setFullScreen(Boolean(value));
  return win.isFullScreen();
});

ipcMain.handle('window:toggle-fullscreen', (event) => {
  const win = windowFromEvent(event);
  if (!win) return false;
  win.setFullScreen(!win.isFullScreen());
  return win.isFullScreen();
});

ipcMain.handle('window:is-fullscreen', (event) => {
  const win = windowFromEvent(event);
  return Boolean(win?.isFullScreen());
});

ipcMain.handle('clipboard:read', () => {
  try {
    return clipboard.readText() ?? '';
  } catch {
    return '';
  }
});

ipcMain.handle('clipboard:write', (_event, text) => {
  try {
    clipboard.writeText(String(text ?? ''));
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle('app:info', () => ({
  name: app.getName(),
  version: app.getVersion(),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
  platform: process.platform,
}));

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    app.setAppUserModelId('com.idupi.pc');
    Menu.setApplicationMenu(null);
    registerAppProtocol();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
