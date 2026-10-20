import { Menu, Tray, nativeImage, app } from 'electron';
import path from 'node:path';
import { getMainWindow, showMainWindow, toggleMainWindow, setQuitting } from './window';

let tray: Tray | null = null;

export function createTray(): Tray {
  const image = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'tray.png'));
  tray = new Tray(image);
  tray.setToolTip('Q-Voice');
  refreshTrayMenu();
  tray.on('double-click', () => showMainWindow());
  return tray;
}

export function refreshTrayMenu(): void {
  if (!tray) return;
  const visible = getMainWindow()?.isVisible() ?? false;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: visible ? 'Hide Q-Voice' : 'Show Q-Voice', click: () => toggleMainWindow() },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          setQuitting(true);
          app.quit();
        },
      },
    ])
  );
}

export function setTrayTooltip(text: string): void {
  tray?.setToolTip(text);
}

export function destroyTray(): void {
  tray?.destroy();
  tray = null;
}
