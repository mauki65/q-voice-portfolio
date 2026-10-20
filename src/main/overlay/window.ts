import { BrowserWindow, screen } from 'electron';
import path from 'node:path';
import type { Participant } from '../../shared/types';

/**
 * The speaking overlay.
 *
 * Transparent, frameless, always-on-top at the 'screen-saver' level (above a
 * borderless game), and click-through so it never steals a click meant for
 * League. `forward: true` keeps mouse move events flowing to the window so it
 * can still show hover feedback while remaining transparent to clicks.
 *
 * Toggling the setting off DESTROYS the window rather than hiding it: a hidden
 * always-on-top window still holds a compositor surface and a renderer process,
 * and "off" should mean gone.
 */

const WIDTH = 210;
const HEIGHT = 190;

let overlay: BrowserWindow | null = null;
let dragging = false;
let onMoved: ((position: { x: number; y: number }) => void) | null = null;

export function isOpen(): boolean {
  return overlay !== null && !overlay.isDestroyed();
}

function clampToDisplay(position: { x: number; y: number } | null): { x: number; y: number } {
  const area = screen.getPrimaryDisplay().workArea;
  if (!position) {
    // Default: right edge, a third of the way down — out of the HUD's way.
    return { x: area.x + area.width - WIDTH - 24, y: area.y + Math.round(area.height / 3) };
  }
  // A monitor may have been unplugged since the position was saved.
  const nearest = screen.getDisplayNearestPoint(position).workArea;
  return {
    x: Math.min(Math.max(position.x, nearest.x), nearest.x + nearest.width - WIDTH),
    y: Math.min(Math.max(position.y, nearest.y), nearest.y + nearest.height - HEIGHT),
  };
}

export function openOverlay(
  position: { x: number; y: number } | null,
  moved: (position: { x: number; y: number }) => void
): void {
  if (isOpen()) return;
  onMoved = moved;
  const { x, y } = clampToDisplay(position);

  overlay = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    x,
    y,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', '..', 'preload', 'overlay.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  overlay.setAlwaysOnTop(true, 'screen-saver');
  // Follows the user across virtual desktops rather than being stranded.
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlay.setIgnoreMouseEvents(true, { forward: true });
  overlay.loadFile(path.join(__dirname, '..', '..', 'renderer', 'overlay.html'));
  overlay.once('ready-to-show', () => overlay?.showInactive());

  overlay.on('moved', () => {
    if (!overlay || overlay.isDestroyed()) return;
    const [nx, ny] = overlay.getPosition();
    onMoved?.({ x: nx, y: ny });
  });

  overlay.on('closed', () => {
    overlay = null;
    dragging = false;
  });
}

export function closeOverlay(): void {
  if (!overlay || overlay.isDestroyed()) {
    overlay = null;
    return;
  }
  overlay.destroy();
  overlay = null;
  dragging = false;
}

/**
 * While the drag modifier is held the overlay stops being click-through so it
 * can be picked up and moved. It is restored the instant the modifier is
 * released, including if the release happens while the window is being dragged.
 */
export function setDragMode(enabled: boolean): void {
  if (!overlay || overlay.isDestroyed() || dragging === enabled) return;
  dragging = enabled;
  overlay.setIgnoreMouseEvents(!enabled, { forward: true });
  overlay.webContents.send('overlay:drag', enabled);
}

export function sendParticipants(participants: Participant[]): void {
  if (!overlay || overlay.isDestroyed()) return;
  overlay.webContents.send('overlay:participants', participants);
}
