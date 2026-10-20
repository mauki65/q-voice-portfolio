import express from 'express';
import path from 'node:path';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import { isPlatform, loadConfig, type Config } from './config';
import { MappingStore } from './mapping';
import { createRandomRoom, roomKind, type RoomKind } from './room';
import { createRiotClient, type RiotClient } from './riot';
import { RoomPresence, verifyMembership } from './verify';

/**
 * Q-Voice token server.
 *
 *   GET  /                                      -> 302 to a fresh random room
 *   POST /room                                  -> { roomName }        (no Riot)
 *   POST /token   { roomName, identity, platform? } -> { token, wsUrl, members }
 *   POST /mapping { lobbyRoom, rosterRoom, identity, platform }
 *   GET  /mapping/:room                         -> { lobbyRoom, rosterRoom }
 *
 * ROUTING BY ROOM KIND. The kind is read out of the room name itself, so a
 * caller cannot declare a cheaper kind to skip a check.
 *
 *   roster  Publicly computable — any live roster is on op.gg and the Spectator
 *           API, and the derivation contract is public. Verified, always.
 *
 *   random  Web-originated. Possession of the link is the access control, the
 *           id is unguessable, and no Riot call is made. This is what lets the
 *           web client ship with NO production Riot API key: nothing on the
 *           random path touches config.riotApiKey.
 *
 *   lobby   Derived, but NOT publicly computable — the champ select chat id it
 *           comes from exists only inside the five clients in that lobby, so it
 *           behaves like a secret rather than like a roster room. Verified
 *           against its mapped roster room once a mapping exists, and accepted
 *           on link possession before that.
 *
 * KNOWN LIMITATION — lobby rooms before a mapping exists.
 *
 * Between the link being posted in champ select and the first ally publishing a
 * lobby -> roster mapping (which cannot happen until the game actually starts),
 * a lobby room is protected by nothing but possession of the link. Anyone
 * holding it gets a token.
 *
 * This is deliberate, not an oversight. The Spectator API has no live game to
 * look up during champ select, so the alternative is refusing every token until
 * the game starts — which would remove champ select voice, the core of the
 * product. The exposure is bounded by the chat id not being derivable from
 * anything public: unlike a roster, it exists only inside the five clients in
 * that lobby.
 *
 * The case where it actually bites is STREAMING. A streamer whose champ select
 * is on screen publishes the link to their whole audience, and it stays valid
 * for the entire match — the mapping, once established, points the lobby room at
 * a roster room the streamer really is in, so verification does not lock those
 * viewers out either. Anyone who read the link off the stream can sit in the
 * team's voice room for the whole game.
 *
 * Mitigations, both already built and neither of them a fix:
 *   - the auto-post toggle (autoPostLinkEnabled). A streamer should turn it off;
 *     the link is still available in the app UI with a copy button, so they can
 *     share it deliberately instead of on camera.
 *   - the participant list, which is visible to everyone in the room. An
 *     unexpected name is seen rather than silent, which is the difference
 *     between an audible intruder and a quiet listener.
 *
 * A real fix needs the room to rotate, or per-recipient links, or Riot Sign-On.
 * None of those are built.
 */

const RATE_LIMIT = { windowMs: 60_000, max: 10 };

/**
 * How many people are already in a room.
 *
 * The seat cap has to live here, not in the browser: a room link is pasted into
 * chat and is therefore public, so nothing client-side can be trusted to count.
 * Injectable so the tests do not need a LiveKit server.
 *
 * A room that does not exist yet throws — that is the first person joining, and
 * it counts as zero rather than as an error.
 */
export type Occupancy = (roomName: string) => Promise<number>;

function livekitOccupancy(config: Config): Occupancy {
  const svc = new RoomServiceClient(
    config.livekitUrl.replace(/^ws/, 'http'),
    config.livekitApiKey,
    config.livekitApiSecret
  );
  return async (roomName) => {
    try {
      return (await svc.listParticipants(roomName)).length;
    } catch {
      return 0;
    }
  };
}

class RateLimiter {
  private hits = new Map<string, number[]>();

  allow(key: string): boolean {
    const now = Date.now();
    const recent = (this.hits.get(key) ?? []).filter((t) => t > now - RATE_LIMIT.windowMs);
    if (recent.length >= RATE_LIMIT.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }
}

export function createApp(
  config: Config,
  riot: RiotClient,
  occupancy: Occupancy = livekitOccupancy(config)
): express.Express {
  const app = express();
  app.use(express.json({ limit: '4kb' }));
  app.disable('x-powered-by');

  const presence = new RoomPresence();
  const mappings = new MappingStore();
  const limiter = new RateLimiter();

  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      verification: config.devBypassVerification
        ? 'BYPASSED'
        : config.riotApiKey
          ? 'enforced'
          : 'unavailable (no Riot key: random rooms only)',
    });
  });

  /** Web clients create rooms here. Deliberately involves no Riot API at all. */
  app.post('/room', (_req, res) => {
    res.json({ roomName: createRandomRoom() });
  });

  app.get('/mapping/:room', (req, res) => {
    const mapping = mappings.get(req.params.room);
    if (!mapping) {
      res.status(404).json({ error: 'no mapping for that room' });
      return;
    }
    res.json(mapping);
  });

  app.post('/mapping', async (req, res) => {
    const { lobbyRoom, rosterRoom, identity, platform } = (req.body ?? {}) as Record<string, unknown>;

    if (typeof lobbyRoom !== 'string' || typeof rosterRoom !== 'string') {
      res.status(400).json({ error: 'lobbyRoom and rosterRoom are required' });
      return;
    }
    if (typeof identity !== 'string' || !identity) {
      res.status(400).json({ error: 'identity is required' });
      return;
    }
    if (!limiter.allow(`map:${identity.toLowerCase()}`)) {
      res.status(429).json({ error: 'too many mapping writes' });
      return;
    }

    if (!config.devBypassVerification) {
      if (!config.riotApiKey) {
        res.status(503).json({ error: 'this deployment cannot verify League membership' });
        return;
      }
      if (typeof platform !== 'string' || !isPlatform(platform)) {
        res.status(400).json({ error: 'platform must be a League platform id, e.g. euw1' });
        return;
      }
      // The writer must be verified FOR THE ROSTER ROOM BEING MAPPED. Being
      // some verified caller is not enough: that would let anyone in any live
      // game repoint any lobby.
      const outcome = await verifyMembership(riot, { roomName: rosterRoom, identity, platform });
      if (!outcome.ok) {
        console.info('mapping refused for %s -> %s: %s', lobbyRoom, rosterRoom, outcome.reason);
        res.status(outcome.status).json({ error: outcome.reason });
        return;
      }
    } else {
      console.warn('!!! DEV BYPASS: accepting an unverified mapping %s -> %s !!!', lobbyRoom, rosterRoom);
    }

    const result = mappings.put(lobbyRoom, rosterRoom);
    if (!result.ok) {
      res.status(result.status).json({ error: result.reason });
      return;
    }
    console.info(
      'mapping %s %s -> %s',
      result.created ? 'established' : 'reconfirmed',
      lobbyRoom,
      rosterRoom
    );
    res.status(result.created ? 201 : 200).json(result.mapping);
  });

  app.post('/token', async (req, res) => {
    const { roomName, identity, platform, displayName } = (req.body ?? {}) as Record<string, unknown>;

    const kind: RoomKind | null = typeof roomName === 'string' ? roomKind(roomName) : null;
    if (!kind || typeof roomName !== 'string') {
      res.status(400).json({ error: 'roomName is not a valid room' });
      return;
    }
    if (typeof identity !== 'string' || identity.length < 1 || identity.length > 64) {
      res.status(400).json({ error: 'identity is required' });
      return;
    }
    if (!limiter.allow(identity.toLowerCase())) {
      res.status(429).json({ error: 'too many token requests' });
      return;
    }

    if (config.devBypassVerification) {
      console.warn(
        '!!! DEV BYPASS: issuing a token for room %s to "%s" with NO verification that they ' +
          'are in the game. This must never run in production. !!!',
        roomName,
        identity
      );
    } else {
      // Random rooms take no Riot path at all — this is the branch the web
      // client uses, and it must stay free of any production-key dependency.
      const roomToVerify =
        kind === 'roster' ? roomName : kind === 'lobby' ? mappings.get(roomName)?.rosterRoom : undefined;

      if (roomToVerify && !config.riotApiKey) {
        // No key: refuse the rooms that need verification. Never fall through
        // to issuing a token, which would silently turn the check off.
        res.status(503).json({
          error: 'this deployment cannot verify League membership; only web rooms are available',
        });
        return;
      }
      if (roomToVerify) {
        if (typeof platform !== 'string' || !isPlatform(platform)) {
          res.status(400).json({ error: 'platform must be a League platform id, e.g. euw1' });
          return;
        }
        const outcome = await verifyMembership(riot, {
          roomName: roomToVerify,
          identity,
          platform,
        });
        if (!outcome.ok) {
          console.info('token refused for %s in %s: %s', identity, roomName, outcome.reason);
          res.status(outcome.status).json({ error: outcome.reason });
          return;
        }
      }
    }

    if (config.maxSeats > 0 && (await occupancy(roomName)) >= config.maxSeats) {
      res.status(409).json({ error: 'This room is full.' });
      return;
    }

    // identity must be unique inside a room — LiveKit disconnects a duplicate,
    // so two guests who picked the same nickname would kick each other. The
    // browser therefore sends a stable random identity plus a separate display
    // name, and the app sends its Riot ID.
    const token = new AccessToken(config.livekitApiKey, config.livekitApiSecret, {
      identity,
      name: typeof displayName === 'string' ? displayName.slice(0, 32) : undefined,
      ttl: config.tokenTtlSeconds,
    });
    // Scoped to this one room, and to speaking and listening in it. No
    // roomCreate, no roomAdmin, no roomList: a leaked token opens one door.
    token.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canSubscribe: true,
      canPublishData: false,
      // Lets someone rename themselves without rejoining the room.
      canUpdateOwnMetadata: true,
    });

    presence.record(roomName, identity);

    res.json({
      token: await token.toJwt(),
      wsUrl: config.livekitUrl,
      members: presence.members(roomName),
    });
  });

  /**
   * Every visit to the root is a brand new room. That is the "one room per
   * team" rule: you open lolvoice at the start of champ select and you get a
   * fresh link to paste. Registered before the static middleware, which would
   * otherwise serve index.html here.
   *
   * There is no server state behind this — a room name only becomes real when
   * someone asks for a token — so a crawler hitting the root costs nothing.
   */
  app.get('/', (_req, res) => res.redirect(302, '/' + createRandomRoom()));

  // The web client is served from here, so there is one deployable and no CORS.
  app.use(express.static(path.join(__dirname, '..', '..', 'public'), { extensions: ['html'] }));
  app.get(/^\/[A-Z0-9]{13,21}$/, (_req, res) => {
    res.sendFile(path.join(__dirname, '..', '..', 'public', 'index.html'));
  });

  return app;
}

if (require.main === module) {
  const config = loadConfig();
  const riot = createRiotClient(config.riotApiKey ?? '');
  createApp(config, riot).listen(config.port, () => {
    console.info('q-voice token server on :%d', config.port);
    if (!config.riotApiKey) {
      console.info(
        'No RIOT_API_KEY: random (web) rooms work normally; roster and mapped lobby rooms ' +
          'are refused with 503. This is the web-first launch configuration.'
      );
    }
    if (config.devBypassVerification) {
      console.warn(
        'VERIFICATION IS BYPASSED. Any caller can obtain a token for any room. ' +
          'Development only — the server refuses to start this way with NODE_ENV=production.'
      );
    }
  });
}
