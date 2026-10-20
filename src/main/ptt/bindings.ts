import type { Binding, BindCheck, BindConflict } from '../../shared/types';

/**
 * Binding helpers. Deliberately does NOT import uiohook-napi at module load —
 * the native addon is resolved lazily so that a broken/missing .node binary
 * degrades to "hook not running" instead of crashing settings and the UI.
 */

/**
 * Labels are the raw button number libuiohook reports — deliberately no
 * "Back"/"Forward" semantics. Which physical side button emits 4 and which
 * emits 5 varies by mouse and driver (verified: on the dev machine the BACK
 * button reports as Mouse5, the opposite of libuiohook's nominal X1/X2 order).
 * Labelling by number keeps the UI, the diagnostics log and the stored binding
 * all saying the same thing, and the first-run picker binds whatever the user
 * actually presses — which is why the picker exists.
 */
export const MOUSE_LABELS: Record<number, string> = {
  1: 'Mouse1',
  2: 'Mouse2',
  3: 'Mouse3',
  4: 'Mouse4',
  5: 'Mouse5',
};

/**
 * Default: Mouse5, the button verified as "back" on real hardware. The thumb
 * button is the natural talk key, so the default follows the hardware rather
 * than libuiohook's nominal numbering.
 */
export const DEFAULT_BINDING: Binding = { kind: 'mouse', code: 5, label: 'Mouse5' };

/** Other side button, for mice that number them the other way round. */
export const FALLBACK_BINDING: Binding = { kind: 'mouse', code: 4, label: 'Mouse4' };

/**
 * Third fallback, for a mouse with no side buttons at all.
 *
 * L, one of the three letters (I, K, L) the stock keymap leaves free. V was
 * considered and rejected: it is League's default Caution Ping, which shows
 * nothing when pressed alone but arms the danger-ping cursor, so the next left
 * click while talking fires a ping instead of a move order.
 *
 * The code is resolved from the live uiohook table at use time, because this
 * module must not load the native addon just to hold a constant.
 */
export const KEYBOARD_FALLBACK: Binding | null = { kind: 'key', code: -1, label: 'L' };

/**
 * Keys that must never be bindable. The hook is passive, so the OS still
 * processes the press: binding a lock key means every sentence spoken flips the
 * user's chat to uppercase, or kills their numpad, or freezes scrolling.
 */
const REJECTED_KEY_NAMES: Record<string, string> = {
  CapsLock:
    'CapsLock still toggles caps while you talk — the hook is passive, so the key reaches Windows too. Pick something else.',
  NumLock: 'NumLock still toggles the numpad while you talk. Pick something else.',
  ScrollLock: 'ScrollLock still toggles scroll lock while you talk. Pick something else.',
};

let keyTable: Record<string, number> | null = null;
let reverseKeyTable: Map<number, string> | null = null;

function loadKeyTable(): Record<string, number> {
  if (keyTable) return keyTable;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { UiohookKey } = require('uiohook-napi') as { UiohookKey: Record<string, number> };
    keyTable = UiohookKey;
  } catch {
    keyTable = {};
  }
  return keyTable;
}

function reverse(): Map<number, string> {
  if (reverseKeyTable) return reverseKeyTable;
  const map = new Map<number, string>();
  for (const [name, code] of Object.entries(loadKeyTable())) {
    if (typeof code === 'number' && !map.has(code)) map.set(code, name);
  }
  reverseKeyTable = map;
  return map;
}

export function keyLabel(code: number): string {
  return reverse().get(code) ?? `Key ${code}`;
}

export function mouseLabel(button: number): string {
  return MOUSE_LABELS[button] ?? `Mouse${button}`;
}

/** Resolves KEYBOARD_FALLBACK's placeholder code against the live key table. */
export function keyboardFallback(): Binding | null {
  if (!KEYBOARD_FALLBACK) return null;
  const code = loadKeyTable()[KEYBOARD_FALLBACK.label];
  return typeof code === 'number' ? { ...KEYBOARD_FALLBACK, code } : null;
}

export function bindingLabel(binding: Binding): string {
  return binding.kind === 'mouse' ? mouseLabel(binding.code) : keyLabel(binding.code);
}

export function sameBinding(a: Binding, b: Binding): boolean {
  return a.kind === b.kind && a.code === b.code;
}

/**
 * League of Legends stock keybinds, read off a current client. The hook is
 * passive, so the game still receives every press — binding push-to-talk to one
 * of these means both actions fire on every press.
 *
 * Keys are uiohook key NAMES (as produced by keyLabel) or mouse labels.
 * Modifier-combination binds (Shift+Q quick cast, Ctrl+Q level up, Alt+Q self
 * cast, Ctrl+1 emotes, Shift+MB2 attack-move) are not listed individually,
 * because a single-key binding cannot collide with them — but Shift, Ctrl and
 * Alt themselves are listed, since holding one to talk silently converts every
 * ability press into a quick cast, level up or self cast.
 *
 * "high" = the press does something immediately and disruptively. "medium" =
 * opens or toggles a panel, moves the camera, or arms something.
 *
 * The stock keymap leaves I, K and L unbound; those are the safe letters.
 * League's own Push-to-Talk (PushToTalk) is unbound by default, so there is no
 * collision with League Voice.
 *
 * TODO (Milestone 4): the LCU exposes the player's real input settings. Once
 * LCU access exists, read the actual binds from there and use them for this
 * warning, falling back to this table only when League is not running. A
 * warning against the user's own keymap is worth far more than one against
 * defaults they may have changed.
 */
const LEAGUE_DEFAULTS: Record<string, { action: string; severity: 'high' | 'medium' }> = {
  // Abilities and summoner spells
  Q: { action: 'Ability 1', severity: 'high' },
  W: { action: 'Ability 2', severity: 'high' },
  E: { action: 'Ability 3', severity: 'high' },
  R: { action: 'Ultimate', severity: 'high' },
  D: { action: 'Summoner Spell 1', severity: 'high' },
  F: { action: 'Summoner Spell 2', severity: 'high' },

  // Items. Note the stock layout: trinket is 4, and item slots 4-6 are 5, 6, 7.
  '1': { action: 'Item Slot 1', severity: 'high' },
  '2': { action: 'Item Slot 2', severity: 'high' },
  '3': { action: 'Item Slot 3', severity: 'high' },
  '4': { action: 'Activate Trinket', severity: 'high' },
  '5': { action: 'Item Slot 4', severity: 'high' },
  '6': { action: 'Item Slot 5', severity: 'high' },
  '7': { action: 'Item Slot 6', severity: 'high' },

  // Movement and orders
  A: { action: 'Attack Move', severity: 'high' },
  X: { action: 'Attack Move', severity: 'high' },
  S: { action: 'Stop', severity: 'high' },
  J: { action: 'Hold Position', severity: 'high' },
  B: { action: 'Recall', severity: 'high' },
  Backquote: { action: 'Target Champions Only', severity: 'medium' },

  // Pings and expressions
  G: { action: 'Alert Ping', severity: 'high' },
  V: { action: 'Caution Ping', severity: 'high' },
  H: { action: 'Enemy Vision Ping', severity: 'high' },
  T: { action: 'Emote Wheel', severity: 'medium' },
  U: { action: 'Fist Bump', severity: 'medium' },

  // Camera
  Space: { action: 'Center Camera on Champion', severity: 'high' },
  Y: { action: 'Toggle Camera Lock', severity: 'medium' },
  F1: { action: 'Select Self', severity: 'medium' },
  F2: { action: 'Select Ally 1', severity: 'medium' },
  F3: { action: 'Select Ally 2', severity: 'medium' },
  F4: { action: 'Select Ally 3', severity: 'medium' },
  F5: { action: 'Select Ally 4', severity: 'medium' },
  ArrowUp: { action: 'Scroll Camera Up', severity: 'medium' },
  ArrowDown: { action: 'Scroll Camera Down', severity: 'medium' },
  ArrowLeft: { action: 'Scroll Camera Left', severity: 'medium' },
  ArrowRight: { action: 'Scroll Camera Right', severity: 'medium' },

  // Menus, chat and HUD
  Enter: { action: 'Open Chat', severity: 'high' },
  Tab: { action: 'Show Scoreboard (hold)', severity: 'high' },
  Escape: { action: 'System Menu', severity: 'high' },
  P: { action: 'Open Shop', severity: 'high' },
  O: { action: 'Show Scoreboard', severity: 'medium' },
  C: { action: 'Show Advanced Player Stats', severity: 'medium' },
  Z: { action: 'Chat History', severity: 'medium' },
  N: { action: 'Toggle Death Recap Showcase', severity: 'medium' },
  M: { action: 'Show League Voice Panel', severity: 'medium' },
  F9: { action: 'Toggle Mouse Screen Lock', severity: 'medium' },
  F12: { action: 'Screenshot', severity: 'medium' },

  // Modifiers: holding one to talk rewrites every other key press.
  Shift: { action: 'Quick Cast modifier', severity: 'high' },
  ShiftRight: { action: 'Quick Cast modifier', severity: 'high' },
  Ctrl: { action: 'Level Up / emote modifier', severity: 'high' },
  CtrlRight: { action: 'Level Up / emote modifier', severity: 'high' },
  Alt: { action: 'Self Cast / quick ping modifier', severity: 'high' },
  AltRight: { action: 'Self Cast / quick ping modifier', severity: 'high' },

  // Mouse. These are not rebindable in League.
  Mouse1: { action: 'Select', severity: 'high' },
  Mouse2: { action: 'Move / Attack', severity: 'high' },
  Mouse3: { action: 'Drag Scroll', severity: 'high' },
};

/**
 * The player's real binds, when we have them. Set from the LCU (or input.ini)
 * in Milestone 4; null means League has never been readable this session and
 * LEAGUE_DEFAULTS is all we have.
 */
let liveBinds: Record<string, BindConflict> | null = null;
let liveBindSource: string | null = null;

export function setLiveBinds(table: Record<string, BindConflict>, source: string): void {
  liveBinds = table;
  liveBindSource = source;
}

export function clearLiveBinds(): void {
  liveBinds = null;
  liveBindSource = null;
}

/** 'live' once real binds are loaded, 'defaults' while falling back. */
export function bindSource(): { kind: 'live' | 'defaults'; detail: string | null } {
  return liveBinds
    ? { kind: 'live', detail: liveBindSource }
    : { kind: 'defaults', detail: null };
}

export function checkConflict(binding: Binding): BindConflict | null {
  const label = bindingLabel(binding);
  // The player's own keymap wins. Warning against stock defaults is wrong for
  // anyone who has rebound anything, and rebinding is common.
  if (liveBinds) return liveBinds[label] ?? null;
  const hit = LEAGUE_DEFAULTS[label];
  return hit ? { label, leagueAction: hit.action, severity: hit.severity } : null;
}

export function rejectionReason(binding: Binding): string | null {
  if (binding.kind === 'mouse') return null;
  return REJECTED_KEY_NAMES[keyLabel(binding.code)] ?? null;
}

/** Single call the UI uses before accepting a binding. */
export function checkBinding(binding: Binding): BindCheck {
  const rejected = rejectionReason(binding);
  return {
    rejected,
    conflict: rejected ? null : checkConflict(binding),
    source: bindSource(),
  };
}

