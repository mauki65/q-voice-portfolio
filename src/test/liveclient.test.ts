import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAllGameData } from '../main/game/liveclient';
import { deriveRoomName } from '../main/game/room';

const PAYLOAD = {
  activePlayer: { riotId: 'Mid Diff#EUW' },
  allPlayers: [
    { riotId: 'Top Lane#EUW', championName: 'Ornn', team: 'ORDER', position: 'TOP' },
    { riotId: 'Jungle#EUW', championName: 'Vi', team: 'ORDER', position: 'JUNGLE' },
    { riotId: 'Mid Diff#EUW', championName: 'Ahri', team: 'ORDER', position: 'MIDDLE' },
    { riotId: 'Bot One#EUW', championName: 'Jinx', team: 'ORDER', position: 'BOTTOM' },
    { riotId: 'Support#EUW', championName: 'Thresh', team: 'ORDER', position: 'UTILITY' },
    { riotId: 'Enemy A#EUW', championName: 'Garen', team: 'CHAOS', position: 'TOP' },
    { riotId: 'Enemy B#EUW', championName: 'Lee Sin', team: 'CHAOS', position: 'JUNGLE' },
  ],
  gameData: { gameTime: 412.7, gameMode: 'CLASSIC' },
};

test('only the ally team is extracted', () => {
  const game = parseAllGameData(PAYLOAD);
  assert.ok(game);
  assert.equal(game.team, 'ORDER');
  assert.equal(game.allies.length, 5);
  assert.ok(!game.allies.some((p) => p.team === 'CHAOS'));
  assert.equal(game.activePlayerRiotId, 'Mid Diff#EUW');
  assert.equal(game.gameTime, 412.7);
});

test('the enemy team cannot change the room name', () => {
  const swapped = {
    ...PAYLOAD,
    allPlayers: PAYLOAD.allPlayers.map((p) =>
      p.team === 'CHAOS' ? { ...p, riotId: `Other ${p.riotId}` } : p
    ),
  };
  const a = parseAllGameData(PAYLOAD);
  const b = parseAllGameData(swapped);
  assert.ok(a && b);
  assert.equal(
    deriveRoomName(a.allies.map((p) => p.riotId)),
    deriveRoomName(b.allies.map((p) => p.riotId))
  );
});

test('the split riotIdGameName / riotIdTagLine shape is accepted', () => {
  const split = {
    activePlayer: { riotId: 'Mid Diff#EUW' },
    allPlayers: [
      { riotIdGameName: 'Mid Diff', riotIdTagLine: 'EUW', championName: 'Ahri', team: 'ORDER' },
      { riotIdGameName: 'Support', riotIdTagLine: 'EUW', championName: 'Thresh', team: 'ORDER' },
    ],
    gameData: { gameTime: 1 },
  };
  const game = parseAllGameData(split);
  assert.ok(game);
  assert.deepEqual(
    game.allies.map((p) => p.riotId),
    ['Mid Diff#EUW', 'Support#EUW']
  );
});

test('two teammates derive the same room from their own perspectives', () => {
  const fromMid = parseAllGameData(PAYLOAD);
  const fromSupport = parseAllGameData({ ...PAYLOAD, activePlayer: { riotId: 'Support#EUW' } });
  assert.ok(fromMid && fromSupport);
  assert.equal(
    deriveRoomName(fromMid.allies.map((p) => p.riotId)),
    deriveRoomName(fromSupport.allies.map((p) => p.riotId))
  );
});

test('lobby-shaped and empty payloads yield null', () => {
  assert.equal(parseAllGameData({}), null);
  assert.equal(parseAllGameData({ allPlayers: [] }), null);
  assert.equal(parseAllGameData({ allPlayers: PAYLOAD.allPlayers }), null, 'no activePlayer');
  assert.equal(
    parseAllGameData({ activePlayer: { riotId: 'Nobody#EUW' }, allPlayers: PAYLOAD.allPlayers }),
    null,
    'active player not in the player list'
  );
});
