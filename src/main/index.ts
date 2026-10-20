import { app, session } from 'electron';
import { createMainWindow, showMainWindow, setQuitting, getMainWindow } from './window';
import { createTray, destroyTray, refreshTrayMenu } from './tray';
import { registerIpc, refreshWindowModeAtStartup, updateStatus } from './ipc';
import { liveClient } from './game/liveclient';
import { lcu } from './lcu/client';
import { closeOverlay } from './overlay/window';
import { logger } from './logger';
import { getSettings, settingsFilePath } from './settings';
import { ptt } from './ptt/service';
import { bindingLabel } from './ptt/bindings';

// A second launch must not install a second low-level keyboard hook.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showMainWindow();
    refreshTrayMenu();
  });

  app.setAppUserModelId('gg.lolvoice.qvoice');

  app.whenReady().then(() => {
    // Microphone permission is granted only to our own renderer.
    session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
      const isOurs = wc === getMainWindow()?.webContents;
      callback(isOurs && permission === 'media');
    });
    session.defaultSession.setPermissionCheckHandler((wc, permission) => {
      return wc === getMainWindow()?.webContents && permission === 'media';
    });

    logger.init();
    registerIpc();
    createMainWindow();
    createTray();

    const settings = getSettings();
    logger.append('app', `settings file: ${settingsFilePath()}`);
    logger.append(
      'app',
      `pttEnabled=${settings.pttEnabled} binding=${bindingLabel(settings.pttBinding)} ` +
        `overlay=${settings.overlayEnabled} autoConnect=${settings.autoConnectEnabled}`
    );

    ptt.setPttEnabled(settings.pttEnabled);
    ptt.setBinding(settings.pttBinding);
    ptt.start();
    updateStatus({ hookRunning: ptt.isRunning(), hookError: ptt.getError() });

    liveClient.start();
    lcu.setLeaguePath(settings.leaguePath);
    lcu.start();
    // League may be closed at launch; game.cfg still tells us the window mode.
    void refreshWindowModeAtStartup();

    getMainWindow()?.on('show', refreshTrayMenu);
    getMainWindow()?.on('hide', refreshTrayMenu);
  });

  // Windows-only build: closing all windows must not quit (we live in the tray).
  app.on('window-all-closed', () => {
    /* intentionally empty */
  });

  app.on('before-quit', () => {
    setQuitting(true);
    liveClient.stop();
    lcu.stop();
    closeOverlay();
    ptt.stop();
    destroyTray();
  });
}
