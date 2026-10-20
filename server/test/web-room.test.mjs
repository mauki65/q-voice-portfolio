import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compareCodepoints,
  deriveLobbyRoom,
  deriveRoomName,
  normalizeRiotId,
  roomKind,
  rosterKey,
} from '../public/room.mjs';

const ROSTER = ['Faker#KR1', 'Caps#EUW', 'Zven#NA1', 'Jankos#EUW', 'Rekkles#EUW'];

/**
 * The golden vector, asserted identically in the desktop suite
 * (src/test/room.test.ts) and the server suite (test/verify.test.ts). Three
 * implementations, one string. If this fails, the web client and the app are in
 * different rooms and nobody hears anybody.
 */
test('web derivation matches the desktop app and the token server', async () => {
  assert.equal(await deriveRoomName(ROSTER), 'RE3B5CE843C35');
});

test('order does not matter', async () => {
  const shuffled = ['Rekkles#EUW', 'Faker#KR1', 'Jankos#EUW', 'Zven#NA1', 'Caps#EUW'];
  assert.equal(await deriveRoomName(ROSTER), await deriveRoomName(shuffled));
});

test('case, whitespace and unicode form do not matter', async () => {
  const messy = ['  faker#kr1 ', 'CAPS#euw', 'zven#NA1', '  JANKOS#EUW', 'rekkles#Euw  '];
  assert.equal(await deriveRoomName(ROSTER), await deriveRoomName(messy));
  assert.equal(
    await deriveRoomName(['Bj\u00e9rgsen#NA1']),
    await deriveRoomName(['Bje\u0301rgsen#NA1'])
  );
});

test('the roster key is namespaced and unit-separated', () => {
  assert.equal(rosterKey(['b#1', 'a#1']), 'roster\u001fa#1\u001fb#1');
});

test('lowercasing is locale-invariant', () => {
  assert.equal(normalizeRiotId('II#TR1'), 'ii#tr1');
});

test('code point ordering matches the other implementations', () => {
  assert.ok(compareCodepoints('\uff70', '\u{1f600}') < 0);
});

test('room kinds are recognised', () => {
  assert.equal(roomKind('RE3B5CE843C35'), 'roster');
  assert.equal(roomKind('L19782FCE2DA2'), 'lobby');
  assert.equal(roomKind('X49X24STNEX8NFW2C8CT1'), 'random');
  assert.equal(roomKind('E3B5CE843C35'), null, 'the pre-prefix format is not a room');
  assert.equal(roomKind(''), null);
});

test('the lobby derivation agrees with the other implementations', async () => {
  assert.equal(await deriveLobbyRoom('c1a2b3d4@champ-select.eu1.pvp.net'), 'L19782FCE2DA2');
});
