import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import type { LivePlayer, LiveGame } from '../../shared/types';

/**
 * League's Live Client Data API.
 *
 * It listens on 127.0.0.1:2999 over HTTPS with a certificate signed by Riot's
 * own root, which is not in the OS trust store, so a normal request fails
 * verification.
 *
 * The fix is scoped to this one host. There is no global TLS relaxation
 * anywhere: NODE_TLS_REJECT_UNAUTHORIZED is never touched, and the agent below
 * is used exclusively for the single hard-coded URL. Two levels:
 *
 *   - If certs/riotgames.pem is present next to the app, it is used as the CA
 *     and the certificate is fully verified against it. Only the hostname check
 *     is replaced, because the certificate is issued for a Riot domain while we
 *     connect to a loopback literal.
 *   - Without that file, the chain cannot be verified, so instead the peer
 *     certificate is inspected and the connection is dropped unless it is issued
 *     by Riot. That is weaker than a real chain check, but the endpoint is on
 *     loopback and the alternative - trusting anything - is worse.
 *
 * Drop Riot's published root PEM at certs/riotgames.pem to get the strong path.
 */

const HOST = '127.0.0.1';
const PORT = 2999;
const PATHNAME = '/liveclientdata/allgamedata';

/** Poll cadence while a game is running. */
const ACTIVE_INTERVAL_MS = 5_000;
/** Idle backoff: connection refused just means League is not in a game. */
const IDLE_INTERVALS_MS = [5_000, 10_000, 20_000, 30_000];

const NOT_RUNNING = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'ECONNABORTED',
  'EPIPE',
]);

function loadRiotCa(): Buffer | null {
  for (const base of [path.join(__dirname, '..', '..', '..'), process.resourcesPath ?? '']) {
    if (!base) continue;
    const candidate = path.join(base, 'certs', 'riotgames.pem');
    try {
      if (fs.existsSync(candidate)) return fs.readFileSync(candidate);
    } catch {
      /* fall through to the next candidate */
    }
  }
  return null;
}

const riotCa = loadRiotCa();

const agent = new https.Agent({
  // Verified against Riot's root when we have it; see the note above otherwise.
  rejectUnauthorized: Boolean(riotCa),
  ca: riotCa ?? undefined,
  // The certificate names a Riot domain, we dial a loopback literal. Skipping
  // only the name check is not the same as skipping verification.
  checkServerIdentity: () => undefined,
  keepAlive: false,
});

export interface LiveClientEvents {
  game: (game: LiveGame) => void;
  idle: () => void;
  log: (message: string) => void;
}

interface RawPlayer {
  riotId?: string;
  riotIdGameName?: string;
  riotIdTagLine?: string;
  summonerName?: string;
  championName?: string;
  team?: string;
  position?: string;
}

interface RawPayload {
  activePlayer?: { riotId?: string; summonerName?: string };
  allPlayers?: RawPlayer[];
  gameData?: { gameTime?: number; gameMode?: string };
}

/** The API has changed field names across patches; accept the known spellings. */
function riotIdOf(player: RawPlayer): string {
  if (player.riotId) return player.riotId;
  if (player.riotIdGameName && player.riotIdTagLine) {
    return `${player.riotIdGameName}#${player.riotIdTagLine}`;
  }
  return player.summonerName ?? '';
}

export function parseAllGameData(raw: unknown): LiveGame | null {
  const data = raw as RawPayload;
  const players = data?.allPlayers;
  if (!Array.isArray(players) || players.length === 0) return null;

  const activeId = data.activePlayer?.riotId ?? data.activePlayer?.summonerName ?? '';
  if (!activeId) return null;

  const normalized: LivePlayer[] = players.map((p) => ({
    riotId: riotIdOf(p),
    championName: p.championName ?? '',
    team: p.team ?? '',
    position: p.position ?? '',
  }));

  const me = normalized.find((p) => p.riotId.toLowerCase() === activeId.toLowerCase());
  if (!me || !me.team) return null;

  return {
    activePlayerRiotId: me.riotId,
    team: me.team,
    allies: normalized.filter((p) => p.team === me.team),
    gameTime: data.gameData?.gameTime ?? 0,
  };
}

function fetchAllGameData(): Promise<LiveGame | null> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { host: HOST, port: PORT, path: PATHNAME, method: 'GET', agent, timeout: 4_000 },
      (res) => {
        if (!riotCa) {
          const cert = (res.socket as import('tls').TLSSocket).getPeerCertificate?.();
          const issuer = `${cert?.issuer?.O ?? ''} ${cert?.issuer?.CN ?? ''}`;
          if (!/riot/i.test(issuer)) {
            res.destroy();
            reject(new Error(`unexpected certificate issuer on ${HOST}:${PORT}: ${issuer.trim()}`));
            return;
          }
        }
        if (res.statusCode !== 200) {
          res.resume();
          resolve(null); // e.g. 404 in the lobby
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
          if (body.length > 2_000_000) {
            res.destroy();
            reject(new Error('live client payload too large'));
          }
        });
        res.on('end', () => {
          try {
            resolve(parseAllGameData(JSON.parse(body)));
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('live client timeout')));
    req.on('error', reject);
    req.end();
  });
}

export class LiveClientPoller extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private idleStep = 0;
  private inGame = false;
  /** Only log a repeating condition once, so the log file stays readable. */
  private lastNotice = '';

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.emit(
      'log',
      riotCa
        ? 'live client poller started (verifying against bundled Riot CA)'
        : 'live client poller started (no certs/riotgames.pem; issuer-checking instead)'
    );
    void this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  isInGame(): boolean {
    return this.inGame;
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), ms);
  }

  private notice(message: string): void {
    if (message === this.lastNotice) return;
    this.lastNotice = message;
    this.emit('log', message);
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    try {
      const game = await fetchAllGameData();
      if (game) {
        this.idleStep = 0;
        if (!this.inGame) {
          this.inGame = true;
          this.notice(`game detected: ${game.allies.length} allies on ${game.team}`);
        }
        this.emit('game', game);
        this.schedule(ACTIVE_INTERVAL_MS);
        return;
      }
      this.goIdle('league is running but not in a game');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code ?? '';
      if (NOT_RUNNING.has(code)) {
        // Not an error. League is closed, or the game has not started.
        this.goIdle('not in game');
      } else {
        this.notice(`live client error: ${err instanceof Error ? err.message : String(err)}`);
        this.goIdle('live client unreadable');
      }
    }
  }

  private goIdle(reason: string): void {
    if (this.inGame) {
      this.inGame = false;
      this.notice(`game ended (${reason})`);
    } else {
      this.notice(reason);
    }
    this.emit('idle');
    const wait = IDLE_INTERVALS_MS[Math.min(this.idleStep, IDLE_INTERVALS_MS.length - 1)];
    this.idleStep += 1;
    this.schedule(wait);
  }
}

export const liveClient = new LiveClientPoller();
