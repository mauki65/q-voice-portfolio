import type { BindConflict } from '../../shared/types';

/**
 * The player's REAL keybinds, which are what the conflict warning should be
 * based on. A warning drawn from stock defaults is wrong for anyone who has
 * rebound anything, and rebinding is common.
 *
 * Three sources, best first:
 *   1. the LCU input settings, while League is running — authoritative and live
 *   2. <install>/Config/input.ini, which works even with League closed
 *   3. the hardcoded stock table in ptt/bindings.ts
 *
 * Both of the first two express bindings as internal event names, which is why
 * EVENT_ACTIONS below is keyed by event name rather than by key.
 */

/** Internal event name -> what the player would see happen. */
const EVENT_ACTIONS: Record<string, { action: string; severity: 'high' | 'medium' }> = {
  CastSpell1: { action: 'Ability 1', severity: 'high' },
  CastSpell2: { action: 'Ability 2', severity: 'high' },
  CastSpell3: { action: 'Ability 3', severity: 'high' },
  CastSpell4: { action: 'Ultimate', severity: 'high' },
  CastAvatarSpell1: { action: 'Summoner Spell 1', severity: 'high' },
  CastAvatarSpell2: { action: 'Summoner Spell 2', severity: 'high' },
  UseVisionItem: { action: 'Activate Trinket', severity: 'high' },
  UseItem1: { action: 'Item Slot 1', severity: 'high' },
  UseItem2: { action: 'Item Slot 2', severity: 'high' },
  UseItem3: { action: 'Item Slot 3', severity: 'high' },
  UseItem4: { action: 'Item Slot 4', severity: 'high' },
  UseItem5: { action: 'Item Slot 5', severity: 'high' },
  UseItem6: { action: 'Item Slot 6', severity: 'high' },
  JumpBack: { action: 'Recall', severity: 'high' },
  PlayerAttackMove: { action: 'Attack Move', severity: 'high' },
  PlayerAttackMoveClick: { action: 'Attack Move Click', severity: 'high' },
  PlayerHoldPosition: { action: 'Hold Position', severity: 'high' },
  PlayerStopPosition: { action: 'Stop', severity: 'high' },
  PlayerMoveClick: { action: 'Move / Attack', severity: 'high' },
  ChampionOnly: { action: 'Target Champions Only', severity: 'medium' },
  CameraSnap: { action: 'Center Camera on Champion', severity: 'high' },
  CameraLockToggle: { action: 'Toggle Camera Lock', severity: 'medium' },
  SelectSelf: { action: 'Select Self', severity: 'medium' },
  SelectAlly1: { action: 'Select Ally 1', severity: 'medium' },
  SelectAlly2: { action: 'Select Ally 2', severity: 'medium' },
  SelectAlly3: { action: 'Select Ally 3', severity: 'medium' },
  SelectAlly4: { action: 'Select Ally 4', severity: 'medium' },
  ScrollUp: { action: 'Scroll Camera Up', severity: 'medium' },
  ScrollDown: { action: 'Scroll Camera Down', severity: 'medium' },
  ScrollLeft: { action: 'Scroll Camera Left', severity: 'medium' },
  ScrollRight: { action: 'Scroll Camera Right', severity: 'medium' },
  PlayerPingCursor: { action: 'Alert Ping', severity: 'high' },
  PlayerPingCursorDanger: { action: 'Caution Ping', severity: 'high' },
  PlayerPingAreaIsWarded: { action: 'Enemy Vision Ping', severity: 'high' },
  PlayerPing: { action: 'Quick Alert Ping', severity: 'high' },
  PlayerPingDanger: { action: 'Quick Caution Ping', severity: 'high' },
  RadialEmoteInstantOpen: { action: 'Emote Wheel', severity: 'medium' },
  ReciprocityTrigger: { action: 'Fist Bump', severity: 'medium' },
  ChatHistory: { action: 'Chat History', severity: 'medium' },
  ShowScoreboard: { action: 'Show Scoreboard', severity: 'medium' },
  HoldShowScoreboard: { action: 'Show Scoreboard (hold)', severity: 'high' },
  ShowCharacterMenu: { action: 'Show Advanced Player Stats', severity: 'medium' },
  OpenShop: { action: 'Open Shop', severity: 'high' },
  SysMenu: { action: 'System Menu', severity: 'high' },
  ToggleDeathRecapShowcase: { action: 'Toggle Death Recap Showcase', severity: 'medium' },
  ToggleMouseClip: { action: 'Toggle Mouse Screen Lock', severity: 'medium' },
  ShowVoicePanel: { action: 'Show League Voice Panel', severity: 'medium' },
  PushToTalk: { action: "League Voice's own Push-to-Talk", severity: 'high' },
};

/**
 * League writes key names in its own vocabulary. Map them onto the uiohook
 * labels the rest of the app uses, so a live bind and a captured binding are
 * comparable. Unrecognised tokens are dropped rather than guessed — a wrong
 * mapping produces a wrong warning, which is worse than no warning.
 */
const KEY_ALIASES: Record<string, string> = {
  space: 'Space',
  tab: 'Tab',
  return: 'Enter',
  enter: 'Enter',
  escape: 'Escape',
  esc: 'Escape',
  shift: 'Shift',
  lshift: 'Shift',
  rshift: 'ShiftRight',
  ctrl: 'Ctrl',
  control: 'Ctrl',
  lctrl: 'Ctrl',
  rctrl: 'CtrlRight',
  alt: 'Alt',
  lalt: 'Alt',
  ralt: 'AltRight',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  backquote: 'Backquote',
  tilde: 'Backquote',
  grave: 'Backquote',
};

/** "[q]" -> "Q", "[Button 4]" -> "Mouse4", "[Shift][q]" -> null (a combo). */
export function normalizeLeagueKey(token: string): string | null {
  const parts = token.match(/\[([^\]]+)\]/g);
  if (!parts || parts.length !== 1) return null; // unbound, or a modifier combo
  const raw = parts[0].slice(1, -1).trim();

  const button = /^button\s*(\d+)$/i.exec(raw);
  if (button) return `Mouse${Number(button[1])}`;

  const lower = raw.toLowerCase();
  if (KEY_ALIASES[lower]) return KEY_ALIASES[lower];
  if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(raw)) return raw.toUpperCase();
  if (/^[a-z0-9]$/i.test(raw)) return raw.toUpperCase();
  return null;
}

export type BindTable = Record<string, BindConflict>;

/**
 * Build a key-label -> conflict map from event/binding pairs. Later entries do
 * not overwrite earlier ones, so the first (highest severity ordering in
 * EVENT_ACTIONS insertion order) wins for a doubly-bound key.
 */
export function buildBindTable(bindings: Iterable<[string, string]>): BindTable {
  const table: BindTable = {};
  for (const [event, value] of bindings) {
    const meta = EVENT_ACTIONS[event];
    if (!meta) continue;
    // A single event can carry several comma-separated bindings, e.g. [a],[x].
    for (const token of value.split(',')) {
      const label = normalizeLeagueKey(token);
      if (!label || table[label]) continue;
      table[label] = { label, leagueAction: meta.action, severity: meta.severity };
    }
  }
  return table;
}

/** input.ini is a plain INI of `evtEventName=[key]` lines. */
export function parseInputIni(contents: string): BindTable {
  const pairs: [string, string][] = [];
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('[') || trimmed.startsWith(';')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!key.startsWith('evt')) continue;
    pairs.push([key.slice(3), trimmed.slice(eq + 1).trim()]);
  }
  return buildBindTable(pairs);
}

/**
 * The LCU returns input settings as a nested object of sections. The exact
 * shape has changed across patches, so this walks whatever comes back and picks
 * up any `evt*` string leaf rather than assuming a fixed layout. Anything it
 * does not recognise is ignored and the caller falls back a level.
 */
export function parseLcuInputSettings(payload: unknown): BindTable {
  const pairs: [string, string][] = [];

  const walk = (node: unknown, depth: number): void => {
    if (depth > 6 || node === null || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (typeof value === 'string' && key.startsWith('evt')) {
        pairs.push([key.slice(3), value]);
      } else if (typeof value === 'object') {
        walk(value, depth + 1);
      }
    }
  };

  walk(payload, 0);
  return buildBindTable(pairs);
}

export const KNOWN_EVENT_COUNT = Object.keys(EVENT_ACTIONS).length;
