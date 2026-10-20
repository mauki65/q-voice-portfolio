import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { isNotRunning, loopbackRequest } from '../net/loopback';
import { findCredentials, resolveInstallDir, type LcuCredentials } from './lockfile';
import { parseInputIni, parseLcuInputSettings, type BindTable } from './binds';

/**
 * League Client Update (LCU) API.
 *
 * Everything here degrades to "League is not running": no lockfile, a refused
 * connection and a 404 are all normal states, not errors. The client is polled
 * rather than websocket-subscribed because polling one small endpoint every few
 * seconds is simpler to reason about than a reconnecting socket, and the phase
 * is the only thing that has to be timely.
 */

export type GameflowPhase =
  | 'None'
  | 'Lobby'
  | 'Matchmaking'
  | 'ReadyCheck'
  | 'ChampSelect'
  | 'GameStart'
  | 'InProgress'
  | 'Reconnect'
  | 'WaitingForStats'
  | 'PreEndOfGame'
  | 'EndOfGame'
  | 'TerminatedInError';

export interface ChampSelectSession {
  /** Identical for all five allies, and the only shared per-lobby id available. */
  lobbyId: string;
  /** The chat conversation to post into, when one exists yet. */
  conversationId: string | null;
}

export interface LcuIdentity {
  riotId: string;
  puuid: string;
}

const CONNECTED_INTERVAL_MS = 3_000;
const IDLE_INTERVALS_MS = [5_000, 10_000, 20_000, 30_000];

export class LcuClient extends EventEmitter {
  private credentials: LcuCredentials | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private idleStep = 0;
  private phase: GameflowPhase = 'None';
  private lastNotice = '';
  private configuredPath: string | undefined;

  setLeaguePath(value: string | undefined): void {
    this.configuredPath = value || undefined;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.emit('log', 'lcu watcher started');
    void this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  isConnected(): boolean {
    return this.credentials !== null;
  }

  currentPhase(): GameflowPhase {
    return this.phase;
  }

  private notice(message: string): void {
    if (message === this.lastNotice) return;
    this.lastNotice = message;
    this.emit('log', message);
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), ms);
  }

  private authHeader(): Record<string, string> {
    const creds = this.credentials;
    if (!creds) throw new Error('not connected to the LCU');
    return { Authorization: `Basic ${Buffer.from(`riot:${creds.password}`).toString('base64')}` };
  }

  /** null when League is not running or the endpoint is absent on this patch. */
  async get<T>(pathname: string): Promise<T | null> {
    if (!this.credentials) return null;
    const res = await loopbackRequest({
      port: this.credentials.port,
      path: pathname,
      headers: this.authHeader(),
    });
    if (res.status === 404) return null;
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`LCU ${pathname} returned ${res.status}`);
    }
    return JSON.parse(res.body) as T;
  }

  async post(pathname: string, body: unknown): Promise<number> {
    if (!this.credentials) throw new Error('not connected to the LCU');
    const res = await loopbackRequest({
      port: this.credentials.port,
      path: pathname,
      method: 'POST',
      headers: this.authHeader(),
      body: JSON.stringify(body),
    });
    return res.status;
  }

  // ---- polled state ---------------------------------------------------------

  private async tick(): Promise<void> {
    if (this.stopped) return;
    try {
      if (!this.credentials) {
        this.credentials = await findCredentials(this.configuredPath);
        if (!this.credentials) {
          this.notice('league client not running');
          this.goIdle();
          return;
        }
        this.emit('log', `lcu connected via ${this.credentials.source}`);
        this.emit('connected');
      }

      const phase = ((await this.get<string>('/lol-gameflow/v1/gameflow-phase')) ??
        'None') as GameflowPhase;
      if (phase !== this.phase) {
        this.emit('log', `gameflow phase ${this.phase} -> ${phase}`);
        this.phase = phase;
        this.emit('phase', phase);
      }
      this.idleStep = 0;
      this.schedule(CONNECTED_INTERVAL_MS);
    } catch (err) {
      if (isNotRunning(err)) {
        // The client closed between the lockfile read and the request.
        this.disconnected('league client closed');
      } else {
        this.notice(`lcu error: ${err instanceof Error ? err.message : String(err)}`);
        this.disconnected('lcu unreadable');
      }
      this.goIdle();
    }
  }

  private disconnected(reason: string): void {
    if (this.credentials) {
      this.credentials = null;
      this.phase = 'None';
      this.notice(reason);
      this.emit('disconnected');
      this.emit('phase', this.phase);
    }
  }

  private goIdle(): void {
    const wait = IDLE_INTERVALS_MS[Math.min(this.idleStep, IDLE_INTERVALS_MS.length - 1)];
    this.idleStep += 1;
    this.schedule(wait);
  }

  // ---- the things Milestone 4 needs -----------------------------------------

  /**
   * Platform id, e.g. "EUW1". The Live Client Data API does not expose the
   * region; this is where it comes from. Display and token-server routing only
   * — it is deliberately not part of the room name.
   */
  async region(): Promise<string | null> {
    try {
      const platform = await this.get<string>(
        '/lol-platform-config/v1/namespaces/LoginDataPacket/platformId'
      );
      if (typeof platform === 'string' && platform) return platform.toUpperCase();
    } catch {
      /* fall through */
    }
    try {
      const locale = await this.get<{ region?: string }>('/riotclient/region-locale');
      return locale?.region?.toUpperCase() ?? null;
    } catch {
      return null;
    }
  }

  /** The local player's Riot ID — the identity the token server verifies. */
  async identity(): Promise<LcuIdentity | null> {
    try {
      const me = await this.get<{ gameName?: string; tagLine?: string; puuid?: string }>(
        '/lol-summoner/v1/current-summoner'
      );
      if (!me?.gameName || !me.tagLine || !me.puuid) return null;
      return { riotId: `${me.gameName}#${me.tagLine}`, puuid: me.puuid };
    } catch {
      return null;
    }
  }

  async champSelectSession(): Promise<ChampSelectSession | null> {
    try {
      const session = await this.get<{
        chatDetails?: { multiUserChatId?: string; mucJwtDto?: { channelClaim?: string } };
      }>('/lol-champ-select/v1/session');
      const lobbyId =
        session?.chatDetails?.multiUserChatId ?? session?.chatDetails?.mucJwtDto?.channelClaim ?? '';
      if (!lobbyId) return null;
      return { lobbyId, conversationId: await this.champSelectConversationId() };
    } catch {
      return null;
    }
  }

  private async champSelectConversationId(): Promise<string | null> {
    try {
      const conversations = await this.get<{ id: string; type: string }[]>(
        '/lol-chat/v1/conversations'
      );
      return conversations?.find((c) => c.type === 'championSelect')?.id ?? null;
    } catch {
      return null;
    }
  }

  /** Returns the HTTP status so the caller can decide whether it counted as posted. */
  async postToChampSelectChat(conversationId: string, message: string): Promise<number> {
    return this.post(`/lol-chat/v1/conversations/${encodeURIComponent(conversationId)}/messages`, {
      body: message,
      type: 'chat',
    });
  }

  /**
   * The player's real keybinds. LCU first, then input.ini (which works with
   * League closed), then null so the caller falls back to the stock table.
   */
  async keybinds(): Promise<{ table: BindTable; source: string } | null> {
    if (this.credentials) {
      for (const endpoint of [
        '/lol-game-settings/v1/input-settings',
        '/lol-game-settings/v1/game-settings',
      ]) {
        try {
          const payload = await this.get<unknown>(endpoint);
          if (payload) {
            const table = parseLcuInputSettings(payload);
            if (Object.keys(table).length > 0) {
              return { table, source: `LCU ${endpoint}` };
            }
          }
        } catch {
          /* try the next endpoint */
        }
      }
    }

    const installDir = resolveInstallDir(this.configuredPath);
    if (installDir) {
      const ini = path.join(installDir, 'Config', 'input.ini');
      try {
        if (fs.existsSync(ini)) {
          const table = parseInputIni(fs.readFileSync(ini, 'utf8'));
          if (Object.keys(table).length > 0) return { table, source: ini };
        }
      } catch {
        /* fall through to null */
      }
    }
    return null;
  }
}

export const lcu = new LcuClient();
