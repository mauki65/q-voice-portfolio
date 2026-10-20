import { regionalRouteFor, type Platform } from './config';

/**
 * The two Riot endpoints this server needs.
 *
 *   Account-V1   Riot ID  -> PUUID          (regional route: europe/americas/asia/sea)
 *   Spectator-V5 PUUID    -> live game      (platform route: euw1/na1/kr/...)
 *
 * Both are cached. Riot's production rate limits are per-key and shared across
 * every user of this server, so an uncached implementation would be rate-limited
 * off the internet the moment more than a handful of games are running. PUUIDs
 * are stable, so those are cached for a day; a live game is cached for 30s,
 * which is well inside the length of a game and short enough that a player who
 * dodges or remakes is not stuck with a stale answer for long.
 */

export interface SpectatorParticipant {
  puuid: string;
  teamId: number;
  riotId?: string;
}

export interface SpectatorGame {
  gameId: number;
  platformId: string;
  participants: SpectatorParticipant[];
}

export class RiotApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

/** Small TTL cache with a hard entry cap, so a flood cannot exhaust memory. */
class TtlCache<T> {
  private entries = new Map<string, { value: T; expires: number }>();

  constructor(
    private ttlMs: number,
    private max = 5_000
  ) {}

  get(key: string): T | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (hit.expires < Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: T): void {
    if (this.entries.size >= this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expires: Date.now() + this.ttlMs });
  }
}

export interface RiotClient {
  puuidForRiotId(riotId: string, platform: Platform): Promise<string | null>;
  activeGameForPuuid(puuid: string, platform: Platform): Promise<SpectatorGame | null>;
}

export function splitRiotId(riotId: string): { gameName: string; tagLine: string } | null {
  const hash = riotId.lastIndexOf('#');
  if (hash <= 0 || hash === riotId.length - 1) return null;
  return { gameName: riotId.slice(0, hash), tagLine: riotId.slice(hash + 1) };
}

export function createRiotClient(apiKey: string, fetchImpl: typeof fetch = fetch): RiotClient {
  const puuidCache = new TtlCache<string | null>(24 * 60 * 60 * 1000);
  const gameCache = new TtlCache<SpectatorGame | null>(30 * 1000);

  async function call(url: string): Promise<Response> {
    const res = await fetchImpl(url, {
      headers: { 'X-Riot-Token': apiKey },
      // Riot is normally fast; a hung request must not hold a client's join.
      signal: AbortSignal.timeout(5_000),
    });
    if (res.status === 429) {
      throw new RiotApiError('rate limited by Riot', 429);
    }
    if (res.status >= 500) {
      throw new RiotApiError(`Riot API unavailable (${res.status})`, 503);
    }
    return res;
  }

  return {
    async puuidForRiotId(riotId, platform) {
      const key = `${platform}:${riotId.toLowerCase()}`;
      const cached = puuidCache.get(key);
      if (cached !== undefined) return cached;

      const parts = splitRiotId(riotId);
      if (!parts) return null;

      const route = regionalRouteFor(platform);
      const url =
        `https://${route}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/` +
        `${encodeURIComponent(parts.gameName)}/${encodeURIComponent(parts.tagLine)}`;

      const res = await call(url);
      if (res.status === 404) {
        puuidCache.set(key, null);
        return null;
      }
      if (!res.ok) throw new RiotApiError(`account lookup failed (${res.status})`, 502);

      const body = (await res.json()) as { puuid?: string };
      const puuid = body.puuid ?? null;
      puuidCache.set(key, puuid);
      return puuid;
    },

    async activeGameForPuuid(puuid, platform) {
      const key = `${platform}:${puuid}`;
      const cached = gameCache.get(key);
      if (cached !== undefined) return cached;

      const url =
        `https://${platform}.api.riotgames.com/lol/spectator/v5/active-games/by-summoner/` +
        encodeURIComponent(puuid);

      const res = await call(url);
      if (res.status === 404) {
        // Not in a game. Normal, not an error.
        gameCache.set(key, null);
        return null;
      }
      if (!res.ok) throw new RiotApiError(`spectator lookup failed (${res.status})`, 502);

      const body = (await res.json()) as SpectatorGame;
      gameCache.set(key, body);
      return body;
    },
  };
}
