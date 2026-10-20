import { contextBridge, ipcRenderer } from 'electron';
import type { AppStatus, Binding, BindCheck, LogEntry, Settings, SettingsKey } from '../shared/types';

/**
 * Narrow contextBridge surface. The renderer gets these functions and nothing
 * else — no ipcRenderer, no node, no dynamic channel names.
 */

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_e: unknown, payload: T) => cb(payload);
  ipcRenderer.on(channel, handler as never);
  return () => ipcRenderer.removeListener(channel, handler as never);
}

const api = {
  settings: {
    getAll: (): Promise<Settings> => ipcRenderer.invoke('settings:getAll'),
    set: (key: SettingsKey, value: unknown): Promise<Settings> =>
      ipcRenderer.invoke('settings:set', key, value),
    onChanged: (cb: (settings: Settings) => void) => subscribe('settings:changed', cb),
  },
  status: {
    get: (): Promise<AppStatus> => ipcRenderer.invoke('status:get'),
    setMuted: (muted: boolean): Promise<AppStatus> => ipcRenderer.invoke('status:setMuted', muted),
    onChanged: (cb: (status: AppStatus) => void) => subscribe('status:changed', cb),
  },
  ptt: {
    getState: (): Promise<boolean> => ipcRenderer.invoke('ptt:getState'),
    onState: (cb: (transmitting: boolean) => void) => subscribe('ptt:state', cb),
    beginCapture: (): Promise<void> => ipcRenderer.invoke('ptt:beginCapture'),
    cancelCapture: (): Promise<void> => ipcRenderer.invoke('ptt:cancelCapture'),
    onCaptured: (cb: (binding: Binding) => void) => subscribe('ptt:captured', cb),
    onSideButton: (cb: (button: number) => void) => subscribe('ptt:sideButton', cb),
    checkBinding: (binding: Binding): Promise<BindCheck> =>
      ipcRenderer.invoke('ptt:checkBinding', binding),
  },
  game: {
    join: (): Promise<AppStatus> => ipcRenderer.invoke('game:join'),
  },
  voice: {
    token: (roomName: string): Promise<unknown> => ipcRenderer.invoke('voice:token', roomName),
    setConnection: (state: string, detail?: string): Promise<AppStatus> =>
      ipcRenderer.invoke('voice:setConnection', state, detail),
    manualRoom: (link: string): Promise<unknown> => ipcRenderer.invoke('voice:manualRoom', link),
  },
  overlay: {
    refreshWindowMode: (): Promise<AppStatus> => ipcRenderer.invoke('overlay:refreshWindowMode'),
  },
  diagnostics: {
    recent: (): Promise<LogEntry[]> => ipcRenderer.invoke('log:recent'),
    onEntry: (cb: (entry: LogEntry) => void) => subscribe('log:entry', cb),
    openFolder: (): void => ipcRenderer.send('log:openFolder'),
  },
  window: {
    hideToTray: (): void => ipcRenderer.send('window:hideToTray'),
    quit: (): void => ipcRenderer.send('window:quit'),
  },
  log: (message: string): void => ipcRenderer.send('log', message),
};

contextBridge.exposeInMainWorld('qvoice', api);

export type PreloadApi = typeof api;
