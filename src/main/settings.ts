import Store from 'electron-store';
import type { Settings, SettingsKey } from '../shared/types';
import { DEFAULT_BINDING } from './ptt/bindings';

/**
 * electron-store is pinned to 8.2.0 on purpose.
 *
 * v9+ is ESM-only. The Electron main process here is CommonJS (Electron's own
 * loader, `require()` of native modules, and electron-builder's asar packing all
 * behave predictably in CJS). Moving the main process to ESM to satisfy one
 * dependency would mean "type": "module", .mjs preload handling, and a bundler
 * step — a lot of moving parts for a settings file. Pinning v8 keeps the whole
 * main process CommonJS. v8 is API-compatible with what we use here.
 */

const defaults: Settings = {
  overlayEnabled: true,
  autoConnectEnabled: true,
  pttEnabled: true,
  pttBinding: DEFAULT_BINDING,
  autoPostLinkEnabled: true,
  inputDeviceId: 'default',
  leaguePath: '',
  tokenServerUrl: 'https://lolvoice.gg',
  lastPostedLobbyId: '',
  overlayPosition: null,
  noiseSuppressionEnabled: true,
  firstRunComplete: false,
};

const store = new Store<Settings>({
  name: 'settings',
  defaults,
  clearInvalidConfig: true,
});

type Listener = (settings: Settings) => void;
const listeners = new Set<Listener>();

export function getSettings(): Settings {
  // Spread through defaults so a config written by an older version still yields
  // a complete object.
  return { ...defaults, ...(store.store as Partial<Settings>) };
}

export function setSetting<K extends SettingsKey>(key: K, value: Settings[K]): Settings {
  store.set(key, value);
  const next = getSettings();
  for (const listener of listeners) listener(next);
  return next;
}

export function onSettingsChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function settingsFilePath(): string {
  return store.path;
}
