/** Types shared between main, preload and renderer. Type-only — no runtime code. */

export type BindingKind = 'key' | 'mouse';

export interface Binding {
  kind: BindingKind;
  /** uiohook keycode for kind==='key', mouse button number for kind==='mouse' */
  code: number;
  /** Human label shown in the UI, e.g. "Mouse4" or "CapsLock" */
  label: string;
}

export interface LogEntry {
  /** ISO timestamp */
  at: string;
  /** 'ptt' | 'app' | 'game' | 'ui' */
  scope: string;
  message: string;
}

export interface Settings {
  overlayEnabled: boolean;
  /** Explicit League install path, when the usual locations do not apply. */
  leaguePath: string;
  /** Base URL of the token server. */
  tokenServerUrl: string;
  /** Lobby whose link has already been posted; prevents a repost after a restart. */
  lastPostedLobbyId: string;
  /** Persisted overlay position; null until the user moves it. */
  overlayPosition: { x: number; y: number } | null;
  autoConnectEnabled: boolean;
  pttEnabled: boolean;
  pttBinding: Binding;
  autoPostLinkEnabled: boolean;
  inputDeviceId: string;
  noiseSuppressionEnabled: boolean;
  /** false until the user has confirmed a binding in the first-run picker */
  firstRunComplete: boolean;
}

export type SettingsKey = keyof Settings;

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface LivePlayer {
  /** Full Riot ID including tagline, e.g. "Faker#KR1" */
  riotId: string;
  championName: string;
  team: string;
  position: string;
}

export interface LiveGame {
  activePlayerRiotId: string;
  team: string;
  /** Ally team only, including the local player. */
  allies: LivePlayer[];
  gameTime: number;
}

export interface Participant {
  /** Riot ID, the identity the token server verifies. */
  identity: string;
  championName: string;
  position: string;
  /** true once this person is actually in the voice room (Milestone 5). */
  inVoice: boolean;
  speaking: boolean;
  isSelf: boolean;
}

export interface AppStatus {
  connection: ConnectionState;
  roomName: string | null;
  muted: boolean;
  /** false when the low-level input hook failed to start */
  hookRunning: boolean;
  hookError: string | null;
  /** true while the Live Client Data API reports an active game */
  inGame: boolean;
  /** set once auto-connect fires, or the user presses Join */
  joinRequested: boolean;
  /** seconds of game time, for display only */
  gameTime: number;
  /**
   * Everyone the room contains, always visible to everyone in it. Sourced from
   * the ally roster until Milestone 5, then from LiveKit so that anyone who
   * joined with a shared link shows up too.
   */
  participants: Participant[];
  /** Platform id from the LCU, e.g. "EUW1". Display and token routing only. */
  region: string | null;
  /** The local player's Riot ID, once the LCU has been read. */
  identity: string | null;
  /** true while the League client is reachable. */
  leagueClient: boolean;
  /** Current gameflow phase, or null when League is not running. */
  phase: string | null;
  /** true once the link has been posted for the current lobby. */
  linkPosted: boolean;
  /**
   * Set when the app started mid-game, could not find the team's room, and is
   * therefore alone in the roster room. Never left silent.
   */
  roomLookupFailed: boolean;
  /** Why the lookup failed, for the UI to explain. */
  roomLookupReason: string | null;
  /** League's window mode; 'fullscreen' means the overlay cannot draw. */
  windowMode: 'windowed' | 'borderless' | 'fullscreen' | 'unknown';
  /** true while the overlay window actually exists. */
  overlayOpen: boolean;
}

export interface BindConflict {
  label: string;
  /** What League binds this to by default */
  leagueAction: string;
  severity: 'high' | 'medium';
}

export interface BindCheck {
  /** Where the conflict information came from, so the UI can say so. */
  source: { kind: 'live' | 'defaults'; detail: string | null };
  /** Non-null when the binding cannot be used at all; the string is the reason. */
  rejected: string | null;
  /** Non-null when the binding is usable but collides with a League default. */
  conflict: BindConflict | null;
}

export interface QVoiceApi {
  settings: {
    getAll(): Promise<Settings>;
    set<K extends SettingsKey>(key: K, value: Settings[K]): Promise<Settings>;
    onChanged(cb: (settings: Settings) => void): () => void;
  };
  status: {
    get(): Promise<AppStatus>;
    setMuted(muted: boolean): Promise<AppStatus>;
    onChanged(cb: (status: AppStatus) => void): () => void;
  };
  ptt: {
    /** true = transmit, false = do not transmit */
    onState(cb: (transmitting: boolean) => void): () => void;
    /** Begin listening for the next key/mouse press to use as a binding. */
    beginCapture(): Promise<void>;
    cancelCapture(): Promise<void>;
    onCaptured(cb: (binding: Binding) => void): () => void;
    checkBinding(binding: Binding): Promise<BindCheck>;
  };
  game: {
    join(): Promise<AppStatus>;
  };
  diagnostics: {
    recent(): Promise<LogEntry[]>;
    onEntry(cb: (entry: LogEntry) => void): () => void;
    openFolder(): void;
  };
  window: {
    hideToTray(): void;
    quit(): void;
  };
  log(message: string): void;
}
