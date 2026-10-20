import { ipcMain, app } from 'electron';
import type { AppStatus, Binding, LiveGame, Participant, Settings, SettingsKey } from '../shared/types';
import { getSettings, setSetting, onSettingsChanged } from './settings';
import { ptt } from './ptt/service';
import { bindingLabel, checkBinding, clearLiveBinds, rejectionReason, setLiveBinds } from './ptt/bindings';
import { liveClient } from './game/liveclient';
import { deriveLobbyRoom, deriveRoomName, roomKind } from './game/room';
import { lcu, type GameflowPhase } from './lcu/client';
import { lookupMapping, publishMapping, requestToken } from './game/directory';
import { overlayCanRender, readWindowModeFromDisk, parseLcuGameSettings, type WindowMode } from './game/windowmode';
import { closeOverlay, isOpen as overlayIsOpen, openOverlay, sendParticipants, setDragMode } from './overlay/window';
import { keyLabel } from './ptt/bindings';
import { logger } from './logger';
import { getMainWindow, sendToRenderer, setQuitting } from './window';
import { refreshTrayMenu, setTrayTooltip } from './tray';

/**
 * Labels are always re-derived here so the store never holds a stale or
 * renderer-invented label, and refused bindings are rejected at the boundary
 * rather than trusting the UI to have filtered them.
 */
function normalizeBinding(binding: Binding): Binding {
  const normalized = { ...binding, label: bindingLabel(binding) };
  const reason = rejectionReason(normalized);
  if (reason) throw new Error(reason);
  return normalized;
}

const status: AppStatus = {
  connection: 'disconnected',
  roomName: null,
  muted: false,
  hookRunning: false,
  hookError: null,
  inGame: false,
  joinRequested: false,
  gameTime: 0,
  participants: [],
  region: null,
  identity: null,
  leagueClient: false,
  phase: null,
  linkPosted: false,
  roomLookupFailed: false,
  roomLookupReason: null,
  windowMode: 'unknown',
  overlayOpen: false,
};

/**
 * Overlay lifecycle.
 *
 * The window exists only while the setting is on AND League is not in exclusive
 * fullscreen, where nothing can composite over the game. Turning the setting
 * off destroys the window rather than hiding it.
 */
function syncOverlay(): void {
  const settings = getSettings();
  const blocked = !overlayCanRender(status.windowMode);
  const wanted = settings.overlayEnabled && !blocked;

  if (wanted && !overlayIsOpen()) {
    openOverlay(settings.overlayPosition, (position) => setSetting('overlayPosition', position));
    logger.append('overlay', 'overlay opened');
    sendParticipants(status.participants);
  } else if (!wanted && overlayIsOpen()) {
    closeOverlay();
    logger.append('overlay', blocked ? 'overlay closed: exclusive fullscreen' : 'overlay closed');
  }
  if (status.overlayOpen !== overlayIsOpen()) updateStatus({ overlayOpen: overlayIsOpen() });
}

/** Ctrl+Shift held: not a League bind on its own, unlike either key alone. */
const DRAG_MODIFIERS = new Set(['Ctrl', 'CtrlRight', 'Shift', 'ShiftRight']);
const heldModifiers = new Set<string>();

function onRawKey(code: number, down: boolean): void {
  const label = keyLabel(code);
  if (!DRAG_MODIFIERS.has(label)) return;
  if (down) heldModifiers.add(label);
  else heldModifiers.delete(label);
  const ctrl = heldModifiers.has('Ctrl') || heldModifiers.has('CtrlRight');
  const shift = heldModifiers.has('Shift') || heldModifiers.has('ShiftRight');
  setDragMode(ctrl && shift);
}

export async function refreshWindowModeAtStartup(): Promise<void> {
  await refreshWindowMode();
  syncOverlay();
}

async function refreshWindowMode(): Promise<void> {
  let mode: WindowMode = 'unknown';
  try {
    const payload = await lcu.get<unknown>('/lol-game-settings/v1/game-settings');
    if (payload) mode = parseLcuGameSettings(payload);
  } catch {
    /* fall through to disk */
  }
  if (mode === 'unknown') mode = readWindowModeFromDisk(getSettings().leaguePath);
  if (mode !== status.windowMode) {
    logger.append('overlay', `league window mode: ${mode}`);
    updateStatus({ windowMode: mode });
    syncOverlay();
  }
}

export const ROOM_BASE = 'https://lolvoice.gg/';

/**
 * Which room the app uses, and the gap in it.
 *
 * Champ select can only produce a LOBBY room (room names come from the ally
 * roster, and Solo Queue hides teammates' names in champ select). In game the
 * roster is visible, so the ROSTER room is computable — and it is the only one
 * a client that never saw champ select can compute.
 *
 * So: once this app has seen champ select it sticks with the lobby room for the
 * whole match, because that is the room whose link went into team chat and the
 * one any browser guest is sitting in. It falls back to the roster room only
 * when it never saw champ select at all.
 *
 * THE GAP: a player whose app started mid-game derives the roster room while
 * everyone else is in the lobby room, and the two groups cannot hear each other.
 * Closing it needs the token server to hold a lobby -> roster mapping, written
 * only by a client that already passed spectator verification. That is a small
 * amount of coordination and it is not built yet — see the note in the README.
 */
let lobbyRoom: string | null = null;
let lobbyIdInProgress: string | null = null;
/** Roster rooms we have already resolved or published, so we do it once per game. */
let mappingHandledFor: string | null = null;

function pushStatus(): void {
  sendToRenderer('status:changed', status);
  setTrayTooltip(
    `Q-Voice — ${status.connection}${status.roomName ? ` · ${status.roomName}` : ''}${
      status.muted ? ' · muted' : ''
    }`
  );
}

export function getStatus(): AppStatus {
  return { ...status };
}

export function updateStatus(patch: Partial<AppStatus>): void {
  Object.assign(status, patch);
  pushStatus();
}

function onGame(game: LiveGame): void {
  const rosterRoom = deriveRoomName(game.allies.map((p) => p.riotId));
  const room = lobbyRoom ?? rosterRoom;

  if (rosterRoom !== mappingHandledFor) {
    mappingHandledFor = rosterRoom;
    void reconcileRoom(rosterRoom);
  }

  const autoConnect = getSettings().autoConnectEnabled;
  const isNewRoom = room !== status.roomName;
  // A new game starts fresh; within one game a manual Join sticks.
  const join = isNewRoom ? autoConnect : status.joinRequested || autoConnect;
  if (isNewRoom && !autoConnect) {
    logger.append('game', 'auto-connect is off — waiting for the user to press Join');
  }

  const participants: Participant[] = game.allies.map((p) => ({
    identity: p.riotId,
    championName: p.championName,
    position: p.position,
    inVoice: false,
    speaking: false,
    isSelf: p.riotId === game.activePlayerRiotId,
  }));

  updateStatus({
    inGame: true,
    roomName: room,
    gameTime: Math.round(game.gameTime),
    joinRequested: join,
    participants,
  });
  sendParticipants(participants);
}

/**
 * Reconcile the lobby room and the roster room for this game.
 *
 *   - We saw champ select: publish lobby -> roster so anyone starting mid-game
 *     can find us. First write wins server-side, so a conflict just means an
 *     ally got there first and we follow their mapping.
 *   - We did not: look the roster room up. If a mapping exists, move to the
 *     lobby room where everyone else already is. If none exists, we are alone
 *     in the roster room — say so loudly rather than sitting silent.
 */
async function reconcileRoom(rosterRoom: string): Promise<void> {
  const { tokenServerUrl } = getSettings();
  const identity = status.identity;
  const platform = status.region?.toLowerCase() ?? '';

  if (lobbyRoom) {
    if (!identity || !platform) {
      logger.append('game', 'cannot publish the room mapping without a Riot ID and region from the LCU');
      return;
    }
    const result = await publishMapping(tokenServerUrl, {
      lobbyRoom,
      rosterRoom,
      identity,
      platform,
    });
    logger.append('game', `mapping ${lobbyRoom} -> ${rosterRoom}: ${result.status}`);
    if (result.status === 'conflict') {
      // An ally published first. Their mapping is authoritative; adopt it.
      const existing = await lookupMapping(tokenServerUrl, rosterRoom);
      if (existing.status === 'found' && existing.mapping.lobbyRoom !== lobbyRoom) {
        lobbyRoom = existing.mapping.lobbyRoom;
        logger.append('game', `adopted the established lobby room ${lobbyRoom}`);
        updateStatus({ roomName: lobbyRoom });
      }
    }
    updateStatus({ roomLookupFailed: false, roomLookupReason: null });
    return;
  }

  const found = await lookupMapping(tokenServerUrl, rosterRoom);
  if (found.status === 'found') {
    lobbyRoom = found.mapping.lobbyRoom;
    logger.append('game', `found the team room ${lobbyRoom} for roster ${rosterRoom}`);
    updateStatus({ roomName: lobbyRoom, roomLookupFailed: false, roomLookupReason: null });
    return;
  }

  const reason =
    found.status === 'none'
      ? 'no teammate has published this game\u2019s room yet'
      : `the room directory is unreachable (${found.reason})`;
  logger.append('game', `room lookup failed: ${reason}`);
  updateStatus({ roomLookupFailed: true, roomLookupReason: reason });
}

function onIdle(): void {
  if (!status.inGame && !status.roomName) return;
  mappingHandledFor = null;
  updateStatus({
    inGame: false,
    roomName: lobbyRoom,
    gameTime: 0,
    joinRequested: false,
    participants: [],
    roomLookupFailed: false,
    roomLookupReason: null,
  });
}

/**
 * Post the room link into team chat exactly once per lobby.
 *
 * "Once" has to survive three things: the champ select session being polled
 * repeatedly, the LCU dropping and reconnecting mid-champ-select, and the app
 * itself being restarted. The first two are covered by the in-memory guard; the
 * third is why the posted lobby id is persisted to the settings store.
 */
async function onChampSelect(): Promise<void> {
  const session = await lcu.champSelectSession();
  if (!session) return;

  if (session.lobbyId !== lobbyIdInProgress) {
    lobbyIdInProgress = session.lobbyId;
    lobbyRoom = deriveLobbyRoom(session.lobbyId);
    logger.append('lcu', `champ select lobby room ${lobbyRoom}`);
    updateStatus({ roomName: lobbyRoom, linkPosted: false });
  }

  const settings = getSettings();
  if (!settings.autoPostLinkEnabled) return;
  if (settings.lastPostedLobbyId === session.lobbyId) {
    // Already posted for this lobby, in this run or a previous one.
    updateStatus({ linkPosted: true });
    return;
  }
  if (!session.conversationId) return; // chat not up yet; try again next poll

  // Persist BEFORE posting. A crash between the two costs one missing link;
  // the other order costs a duplicate post every restart, which is spam.
  setSetting('lastPostedLobbyId', session.lobbyId);
  try {
    const httpStatus = await lcu.postToChampSelectChat(
      session.conversationId,
      `${ROOM_BASE}${lobbyRoom} — voice for this team, no signup`
    );
    logger.append('lcu', `posted room link to team chat (HTTP ${httpStatus})`);
    updateStatus({ linkPosted: true });
  } catch (err) {
    logger.append('lcu', `could not post room link: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function onPhase(phase: GameflowPhase): Promise<void> {
  updateStatus({ phase });

  if (phase === 'ChampSelect') {
    await onChampSelect();
    return;
  }

  // Anything that is not champ select and not the game itself ends the lobby.
  if (phase === 'None' || phase === 'Lobby' || phase === 'Matchmaking' || phase === 'EndOfGame') {
    if (lobbyRoom) logger.append('lcu', 'lobby ended, dropping the champ select room');
    lobbyRoom = null;
    lobbyIdInProgress = null;
    updateStatus({ linkPosted: false });
  }
}

/** Real keybinds, refreshed whenever League appears. */
async function refreshBinds(): Promise<void> {
  try {
    const binds = await lcu.keybinds();
    if (binds) {
      setLiveBinds(binds.table, binds.source);
      logger.append('lcu', `loaded ${Object.keys(binds.table).length} real keybinds from ${binds.source}`);
    } else {
      clearLiveBinds();
      logger.append('lcu', 'no readable keybinds; conflict warnings use stock defaults');
    }
  } catch (err) {
    clearLiveBinds();
    logger.append('lcu', `keybind read failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  sendToRenderer('settings:changed', getSettings()); // nudges the UI to re-check
}

export function registerIpc(): void {
  // ---- settings ----
  ipcMain.handle('settings:getAll', () => getSettings());

  ipcMain.handle('settings:set', (_e, key: SettingsKey, value: unknown) => {
    const current = getSettings();
    if (!(key in current)) throw new Error(`unknown setting: ${String(key)}`);
    if (key === 'pttBinding') {
      return setSetting('pttBinding', normalizeBinding(value as Binding));
    }
    return setSetting(key, value as Settings[typeof key]);
  });

  onSettingsChanged((settings) => {
    // Settings take effect immediately — no restart.
    ptt.setPttEnabled(settings.pttEnabled);
    ptt.setBinding(settings.pttBinding);
    lcu.setLeaguePath(settings.leaguePath);
    sendToRenderer('settings:changed', settings);
    syncOverlay();
  });

  // ---- status ----
  ipcMain.handle('status:get', () => getStatus());
  ipcMain.handle('status:setMuted', (_e, muted: boolean) => {
    status.muted = Boolean(muted);
    pushStatus();
    logger.append('app', `muted=${status.muted}`);
    return getStatus();
  });

  // ---- voice ----
  /**
   * The token request lives in main, not the renderer: main already holds the
   * verified identity and region from the LCU, and keeping it here means the
   * renderer never needs to know the token server exists.
   */
  ipcMain.handle('voice:token', async (_e, roomName: string) => {
    const { tokenServerUrl } = getSettings();
    if (roomKind(roomName) === null) return { ok: false, reason: 'invalid room name' };
    const identity = status.identity ?? `guest-${roomName}`;
    const result = await requestToken(tokenServerUrl, {
      roomName,
      identity,
      platform: status.region?.toLowerCase() ?? undefined,
    });
    logger.append('voice', `token for ${roomName} as ${identity}: ${result.ok ? 'granted' : result.reason}`);
    return result;
  });

  ipcMain.handle('voice:setConnection', (_e, state: AppStatus['connection'], detail?: string) => {
    updateStatus({ connection: state });
    if (detail) logger.append('voice', detail);
    return getStatus();
  });

  ipcMain.handle('overlay:refreshWindowMode', async () => {
    await refreshWindowMode();
    return getStatus();
  });

  ipcMain.handle('voice:manualRoom', (_e, link: string) => {
    const match = /([RLX][0-9A-Z]{12,20})\s*$/.exec(String(link).trim().toUpperCase());
    const candidate = match?.[1] ?? '';
    if (!roomKind(candidate)) {
      logger.append('voice', `manual link rejected: ${String(link).slice(0, 80)}`);
      return { ok: false as const, reason: 'that does not look like a Q-Voice link' };
    }
    logger.append('voice', `manual room override: ${candidate}`);
    lobbyRoom = candidate;
    updateStatus({ roomName: candidate, roomLookupFailed: false, roomLookupReason: null, joinRequested: true });
    return { ok: true as const, roomName: candidate };
  });

  // ---- game ----
  ipcMain.handle('game:join', () => {
    if (!status.roomName) return getStatus();
    logger.append('game', `manual join requested for ${status.roomName}`);
    updateStatus({ joinRequested: true });
    return getStatus();
  });

  liveClient.on('game', onGame);
  liveClient.on('idle', onIdle);
  liveClient.on('log', (message: string) => logger.append('game', message));

  // ---- league client ----
  lcu.on('log', (message: string) => logger.append('lcu', message));
  lcu.on('phase', (phase: GameflowPhase) => void onPhase(phase));
  lcu.on('connected', async () => {
    updateStatus({ leagueClient: true });
    await refreshWindowMode();
    const [region, identity] = await Promise.all([lcu.region(), lcu.identity()]);
    if (region) logger.append('lcu', `region ${region}`);
    updateStatus({ region, identity: identity?.riotId ?? null });
    await refreshBinds();
  });
  lcu.on('disconnected', () => {
    updateStatus({ leagueClient: false, phase: null });
    // Region and identity are kept: they do not change, and the token server
    // still needs them if a game is somehow already running.
    void refreshBinds(); // falls back to input.ini, then to defaults
  });

  // ---- ptt ----
  ipcMain.handle('ptt:beginCapture', () => {
    ptt.beginCapture();
  });
  ipcMain.handle('ptt:cancelCapture', () => {
    ptt.cancelCapture();
  });
  ipcMain.handle('ptt:checkBinding', (_e, binding: Binding) => checkBinding(binding));
  ipcMain.handle('ptt:getState', () => ptt.isTransmitting());

  ptt.on('log', (message: string) => logger.append('ptt', message));
  ptt.on('state', (transmitting: boolean) => sendToRenderer('ptt:state', transmitting));
  ptt.on('captured', (binding: Binding) =>
    sendToRenderer('ptt:captured', { ...binding, label: bindingLabel(binding) })
  );
  ptt.on('sideButton', (button: number) => sendToRenderer('ptt:sideButton', button));
  ptt.on('rawKey', onRawKey);
  ptt.on('hook', (running: boolean, error: string | null) => {
    updateStatus({ hookRunning: running, hookError: error });
  });

  // ---- diagnostics ----
  ipcMain.handle('log:recent', () => logger.recent());
  ipcMain.on('log:openFolder', () => void logger.openFolder());
  logger.on('entry', (entry) => sendToRenderer('log:entry', entry));

  // ---- window ----
  ipcMain.on('window:hideToTray', () => {
    getMainWindow()?.hide();
    refreshTrayMenu();
  });
  ipcMain.on('window:quit', () => {
    setQuitting(true);
    app.quit();
  });

  ipcMain.on('log', (_e, message: string) => logger.append('ui', String(message).slice(0, 500)));
}
