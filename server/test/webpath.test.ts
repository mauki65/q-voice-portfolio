import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index';
import { createRandomRoom, deriveLobbyRoom, deriveRoomName, roomKind } from '../src/room';
import type { Config } from '../src/config';
import type { RiotClient } from '../src/riot';

/**
 * The web client must run against a deployment with NO production Riot key.
 * These tests prove it end to end rather than by inspection:
 *
 *   - config.riotApiKey is a getter that THROWS if anything reads it, so any
 *     accidental dependency fails the test rather than passing silently.
 *   - the RiotClient throws on every call, so any accidental Riot lookup fails
 *     the same way.
 *
 * If the random-room path ever grows a Riot dependency, this goes red.
 */

const LIVEKIT = {
  livekitUrl: 'wss://livekit.test',
  livekitApiKey: 'APItest',
  livekitApiSecret: 'abcdefghijklmnopqrstuvwxyz012345',
  devBypassVerification: false,
  tokenTtlSeconds: 600,
  maxSeats: 5,
  port: 0,
};

/** No LiveKit server in tests, so occupancy is injected. */
const empty = async () => 0;

function configWithExplodingKey(): Config {
  const config = { ...LIVEKIT } as Config;
  Object.defineProperty(config, 'riotApiKey', {
    get() {
      throw new Error('the web path read config.riotApiKey');
    },
    configurable: true,
  });
  return config;
}

/** A key-less deployment: reading the key is legal, it is simply absent. */
function keylessConfig(): Config {
  return { ...LIVEKIT, riotApiKey: null } as Config;
}

const explodingRiot: RiotClient = {
  puuidForRiotId: async () => {
    throw new Error('the web path called the Riot API');
  },
  activeGameForPuuid: async () => {
    throw new Error('the web path called the Riot API');
  },
};

async function withServer(
  config: Config,
  riot: RiotClient,
  run: (base: string) => Promise<void>,
  occupancy: (room: string) => Promise<number> = empty
): Promise<void> {
  const server = createApp(config, riot, occupancy).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

const post = (base: string, path: string, body?: unknown) =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

test('creating a web room reads no Riot key and makes no Riot call', async () => {
  await withServer(configWithExplodingKey(), explodingRiot, async (base) => {
    const res = await post(base, '/room');
    assert.equal(res.status, 200);
    const { roomName } = (await res.json()) as { roomName: string };
    assert.match(roomName, /^X[0-9A-HJKMNP-TV-Z]{20}$/);
  });
});

test('joining a web room reads no Riot key and makes no Riot call', async () => {
  await withServer(configWithExplodingKey(), explodingRiot, async (base) => {
    const res = await post(base, '/token', {
      roomName: createRandomRoom(),
      identity: 'guest-0123456789abcdef',
      displayName: 'Quiet Wolf',
    });
    const body = (await res.json()) as { token: string; wsUrl: string; error?: string };
    assert.equal(res.status, 200, body.error ?? 'expected a token');
    assert.ok(body.token.length > 20);
    assert.equal(body.wsUrl, LIVEKIT.livekitUrl);
  });
});

test('a lobby room with no mapping also needs no Riot call', async () => {
  // Documented behaviour: before a mapping exists, possession of the link is
  // the access control. See the routing header in src/index.ts.
  await withServer(configWithExplodingKey(), explodingRiot, async (base) => {
    const res = await post(base, '/token', {
      roomName: deriveLobbyRoom('c1a2@champ-select.pvp.net'),
      identity: 'guest-0123456789abcdef',
    });
    assert.equal(res.status, 200);
  });
});

test('without a key, a roster room is REFUSED — never granted', async () => {
  await withServer(keylessConfig(), explodingRiot, async (base) => {
    const res = await post(base, '/token', {
      roomName: deriveRoomName(['Faker#KR1', 'Caps#EUW']),
      identity: 'Caps#EUW',
      platform: 'euw1',
    });
    assert.equal(res.status, 503, 'the check must fail closed, not fall through');
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /cannot verify/i);
  });
});

test('without a key, publishing a mapping is refused too', async () => {
  await withServer(keylessConfig(), explodingRiot, async (base) => {
    const res = await post(base, '/mapping', {
      lobbyRoom: deriveLobbyRoom('c1a2@champ-select.pvp.net'),
      rosterRoom: deriveRoomName(['Faker#KR1', 'Caps#EUW']),
      identity: 'Caps#EUW',
      platform: 'euw1',
    });
    assert.equal(res.status, 503);
  });
});

test('health reports the key-less mode rather than claiming enforcement', async () => {
  await withServer(keylessConfig(), explodingRiot, async (base) => {
    const body = (await (await fetch(base + '/health')).json()) as { verification: string };
    assert.match(body.verification, /random rooms only/);
  });
});

test('the web page and its room module are served', async () => {
  await withServer(configWithExplodingKey(), explodingRiot, async (base) => {
    // The root hands out a fresh room rather than showing a landing page.
    const root = await fetch(base + '/', { redirect: 'manual' });
    assert.equal(root.status, 302);
    const target = root.headers.get('location') ?? '';
    assert.equal(roomKind(target.slice(1)), 'random');

    const page = await fetch(base + target);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /lolvoice/);

    const module = await fetch(base + '/room.mjs');
    assert.equal(module.status, 200);

    // A room URL must serve the page, not 404.
    const room = await fetch(base + '/' + createRandomRoom());
    assert.equal(room.status, 200);
  });
});

test('the seat cap is enforced on the server, not in the browser', async () => {
  // A room link is pasted into chat and is therefore public; nothing
  // client-side can be trusted to count seats.
  const full = async () => 5;
  await withServer(
    configWithExplodingKey(),
    explodingRiot,
    async (base) => {
      const res = await post(base, '/token', {
        roomName: createRandomRoom(),
        identity: 'guest-0123456789abcdef',
      });
      assert.equal(res.status, 409);
      assert.match(((await res.json()) as { error: string }).error, /full/i);
    },
    full
  );
});

test('a token grants renaming without rejoining', async () => {
  await withServer(configWithExplodingKey(), explodingRiot, async (base) => {
    const res = await post(base, '/token', {
      roomName: createRandomRoom(),
      identity: 'guest-0123456789abcdef',
      displayName: 'Quiet Wolf',
    });
    const { token } = (await res.json()) as { token: string };
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    assert.equal(claims.video.canUpdateOwnMetadata, true, 'setName() fails silently without this');
    assert.equal(claims.name, 'Quiet Wolf');
    assert.equal(claims.video.roomCreate, undefined, 'still no admin rights');
  });
});
