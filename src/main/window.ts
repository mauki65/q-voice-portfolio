import { BrowserWindow, shell } from 'electron';
import path from 'node:path';

let mainWindow: BrowserWindow | null = null;
let quitting = false;

export function setQuitting(value: boolean): void {
  quitting = value;
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

export function createMainWindow(): BrowserWindow {
  mainWindow = new BrowserWindow({
    width: 720,
    height: 600,
    minWidth: 660,
    minHeight: 540,
    show: false,
    backgroundColor: '#0d0e12',
    autoHideMenuBar: true,
    title: 'Q-Voice',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  // Closing the window minimises to tray instead of quitting.
  mainWindow.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Nothing in this app should navigate or open windows.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());

  return mainWindow;
}

export function showMainWindow(): void {
  if (!mainWindow) {
    createMainWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

export function toggleMainWindow(): void {
  if (mainWindow?.isVisible()) mainWindow.hide();
  else showMainWindow();
}

export function sendToRenderer(channel: string, payload?: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}
