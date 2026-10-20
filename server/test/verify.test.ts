import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveRoomName } from '../src/room';
import { RoomPresence, verifyMembership } from '../src/verify';
import { loadConfig } from '../src/config';
import type { RiotClient, SpectatorGame } from '../src/riot';

const ALLIES = ['Faker#KR1', 'Caps#EUW', 'Zven#NA1', 'Jankos#EUW', 'Rekkles#EUW'];
const ENEMIES = ['Enemy1#EUW', 'Enemy2#EUW', 'Enemy3#EUW', 'Enemy4#EUW', 'Enemy5#EUW'];
const ROOM = deriveRoomName(ALLIES);

/**
 * The golden vector. The desktop app's suite asserts the same string. If these
 * two ever disagree, every legitimate token request is refused.
 */
test('room derivation matches the desktop client exactly', () => {
  assert.equal(ROOM, 'RE3B5CE843C35');
});

function game(): SpectatorGame {
  return {
    gameId: 1,
    platformId: 'EUW1',
    participants: [
      ...ALLIES.map((riotId, i) => ({ puuid: `ally-${i}`, teamId: 100, riotId })),
      ...ENEMIES.map((riotId, i) => ({ puuid: `enemy-${i}`, teamId: 200, riotId })),
    ],
  };
}

function client(overrides: Partial<RiotClient> = {}, live: SpectatorGame | null = game()): RiotClient {
  return {
    puuidForRiotId: async (riotId) => {
      const ally = ALLIES.indexOf(riotId);
      if (ally >= 0) return `ally-${ally}`;
      const enemy = ENEMIES.indexOf(riotId);
      if (enemy >= 0) return `enemy-${enemy}`;
      return null;
    },
    activeGameForPuuid: async () => live,
    ...overrides,
  };
}

test('a player in the game gets through', async () => {
  const out = await verifyMembership(client(), {
    roomName: ROOM,
    identity: 'Caps#EUW',
    platform: 'euw1',
  });
  assert.equal(out.ok, true);
});

test('every ally derives the same room from their own perspective', async () => {
  for (const identity of ALLIES) {
    const out = await verifyMembership(client(), { roomName: ROOM, identity, platform: 'euw1' });
    assert.equal(out.ok, true, identity);
  }
});

test('an outsider who computed the room name is refused', async () => {
  // This is the whole point: the room name is public, so knowing it proves nothing.
  const out = await verifyMembership(client(undefined, null), {
    roomName: ROOM,
    identity: 'Stranger#EUW',
    platform: 'euw1',
  });
  assert.equal(out.ok, false);
  assert.equal((out as { status: number }).status, 404);
});

test('a player in a DIFFERENT live game is refused', async () => {
  const elsewhere: SpectatorGame = {
    gameId: 2,
    platformId: 'EUW1',
    participants: [
      { puuid: 'other-0', teamId: 100, riotId: 'Someone#EUW' },
      { puuid: 'other-1', teamId: 100, riotId: 'SomeoneElse#EUW' },
    ],
  };
  const out = await verifyMembership(
    client({ puuidForRiotId: async () => 'other-0' }, elsewhere),
    { roomName: ROOM, identity: 'Someone#EUW', platform: 'euw1' }
  );
  assert.equal(out.ok, false);
  assert.match((out as { reason: string }).reason, /does not match/);
});

test('an enemy in the same game cannot join the ally room', async () => {
  const out = await verifyMembership(client(), {
    roomName: ROOM,
    identity: 'Enemy1#EUW',
    platform: 'euw1',
  });
  assert.equal(out.ok, false, 'the enemy team derives its own room, not this one');
});

test('a missing Riot ID on the roster fails closed, not open', async () => {
  const partial = game();
  partial.participants[0].riotId = undefined;
  const out = await verifyMembership(client(undefined, partial), {
    roomName: ROOM,
    identity: 'Caps#EUW',
    platform: 'euw1',
  });
  assert.equal(out.ok, false);
  assert.equal((out as { status: number }).status, 503);
});

test('a malformed room name is rejected before any Riot call', async () => {
  let called = false;
  const out = await verifyMembership(
    client({
      puuidForRiotId: async () => {
        called = true;
        return 'ally-0';
      },
    }),
    { roomName: 'not-a-room', identity: 'Caps#EUW', platform: 'euw1' }
  );
  assert.equal(out.ok, false);
  assert.equal(called, false);
});

test('the dev bypass cannot start in production', () => {
  const env = {
    NODE_ENV: 'production',
    QVOICE_DEV_BYPASS_VERIFICATION: 'true',
    RIOT_API_KEY: 'x',
    LIVEKIT_URL: 'wss://x',
    LIVEKIT_API_KEY: 'x',
    LIVEKIT_API_SECRET: 'x',
  } as NodeJS.ProcessEnv;
  assert.throws(() => loadConfig(env), /Refusing to start/);
});

test('the dev bypass is off unless explicitly set to true', () => {
  const base = {
    LIVEKIT_URL: 'wss://x',
    LIVEKIT_API_KEY: 'x',
    LIVEKIT_API_SECRET: 'x',
    RIOT_API_KEY: 'x',
  };
  assert.equal(loadConfig(base as NodeJS.ProcessEnv).devBypassVerification, false);
  assert.equal(
    loadConfig({ ...base, QVOICE_DEV_BYPASS_VERIFICATION: '1' } as NodeJS.ProcessEnv)
      .devBypassVerification,
    false,
    'only the exact string "true" enables it'
  );
});

test('the RSO seam skips the lookup without changing the membership check', async () => {
  // RSO is not assumed and may never be granted; this only proves the seam is
  // wired so adding it later is additive.
  let lookedUp = false;
  const riot = client({
    puuidForRiotId: async () => {
      lookedUp = true;
      return 'ally-1';
    },
  });

  const proven = await verifyMembership(riot, {
    roomName: ROOM,
    identity: 'Caps#EUW',
    platform: 'euw1',
    assertion: { kind: 'rso', puuid: 'ally-1' },
  });
  assert.equal(proven.ok, true);
  assert.equal(lookedUp, false, 'a proven puuid needs no Riot ID lookup');
  assert.deepEqual((proven as { assertion: unknown }).assertion, { kind: 'rso', puuid: 'ally-1' });

  const selfAsserted = await verifyMembership(riot, {
    roomName: ROOM,
    identity: 'Caps#EUW',
    platform: 'euw1',
  });
  assert.equal(selfAsserted.ok, true);
  assert.equal(lookedUp, true);
  assert.deepEqual((selfAsserted as { assertion: unknown }).assertion, { kind: 'self-asserted' });
});

test('an RSO-proven puuid that is not in the game is still refused', () => {
  return verifyMembership(client(), {
    roomName: ROOM,
    identity: 'Caps#EUW',
    platform: 'euw1',
    assertion: { kind: 'rso', puuid: 'enemy-0' },
  }).then((out) => {
    assert.equal(out.ok, false, 'proof of identity is not proof of membership');
  });
});

test('presence lists members and expires them', async () => {
  const presence = new RoomPresence(30);
  presence.record(ROOM, 'Caps#EUW');
  presence.record(ROOM, 'Faker#KR1');
  assert.deepEqual(presence.members(ROOM), ['Caps#EUW', 'Faker#KR1']);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(presence.members(ROOM), []);
});
