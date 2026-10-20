import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compareCodepoints,
  createRandomRoom,
  deriveLobbyRoom,
  deriveRoomName,
  normalizeRiotId,
  requiresVerification,
  roomKind,
  rosterKey,
} from '../main/game/room';

const ROSTER = ['Faker#KR1', 'Caps#EUW', 'Zven#NA1', 'Jankos#EUW', 'Rekkles#EUW'];

test('the same roster in two different orders yields one room name', () => {
  const shuffled = ['Rekkles#EUW', 'Faker#KR1', 'Jankos#EUW', 'Zven#NA1', 'Caps#EUW'];
  assert.notDeepEqual(ROSTER, shuffled, 'the two orders must actually differ');
  assert.equal(deriveRoomName(ROSTER), deriveRoomName(shuffled));
});

test('reversed order also yields the same name', () => {
  assert.equal(deriveRoomName(ROSTER), deriveRoomName([...ROSTER].reverse()));
});

test('case and surrounding whitespace do not change the name', () => {
  const messy = ['  faker#kr1 ', 'CAPS#euw', 'zven#NA1', '  JANKOS#EUW', 'rekkles#Euw  '];
  assert.equal(deriveRoomName(ROSTER), deriveRoomName(messy));
});

test('composed and decomposed unicode agree', () => {
  const composed = ['Bj\u00e9rgsen#NA1', 'Caps#EUW'];
  const decomposed = ['Bje\u0301rgsen#NA1', 'Caps#EUW'];
  assert.notEqual(composed[0], decomposed[0], 'inputs must differ before normalisation');
  assert.equal(deriveRoomName(composed), deriveRoomName(decomposed));
});

test('a different roster yields a different name', () => {
  const other = [...ROSTER.slice(0, 4), 'Someone#EUW'];
  assert.notEqual(deriveRoomName(ROSTER), deriveRoomName(other));
});

test('the tagline is part of the identity', () => {
  assert.notEqual(deriveRoomName(['Faker#KR1']), deriveRoomName(['Faker#KR2']));
});

/**
 * Golden vector. The token server's suite asserts the same string, because the
 * server re-derives the room name from the Spectator API and refuses the token
 * if it disagrees. If these two drift, every legitimate join is refused.
 */
test('golden vector matches the token server', () => {
  assert.equal(deriveRoomName(ROSTER), 'RE3B5CE843C35');
});

test('room name shape is stable', () => {
  assert.match(deriveRoomName(ROSTER), /^R[0-9A-F]{12}$/);
});

test('the kind of a room is readable from its name', () => {
  assert.equal(roomKind(deriveRoomName(ROSTER)), 'roster');
  assert.equal(roomKind(deriveLobbyRoom('c1a2@champ-select.pvp.net')), 'lobby');
  assert.equal(roomKind(createRandomRoom()), 'random');
  assert.equal(roomKind('E3B5CE843C35'), null, 'the old unprefixed format is gone');
  assert.equal(roomKind(''), null);
});

test('only publicly computable rooms require verification', () => {
  // This is the whole point of the split: a random room is unguessable, so
  // possession of the link is the access control and no Riot call is needed.
  assert.equal(requiresVerification('roster'), true);
  assert.equal(requiresVerification('random'), false);
  assert.equal(requiresVerification('lobby'), false);
});

test('a lobby room can never collide with a roster room', () => {
  const shared = 'faker#kr1';
  assert.notEqual(deriveLobbyRoom(shared), deriveRoomName([shared]));
  assert.notEqual(deriveLobbyRoom(shared).slice(1), deriveRoomName([shared]).slice(1));
});

test('random rooms carry 100 bits and do not repeat', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 1000; i++) seen.add(createRandomRoom());
  assert.equal(seen.size, 1000);
  assert.equal(createRandomRoom().length, 21);
});

test('the roster key is namespaced and joined with the unit separator', () => {
  assert.equal(rosterKey(['b#1', 'a#1']), 'roster\u001fa#1\u001fb#1');
});

test('code point ordering places astral characters after the BMP', () => {
  assert.ok(compareCodepoints('￰', '\u{1f600}') < 0);
  assert.ok('\u{1f600}' < '￰', 'a plain < really is wrong here, hence the custom compare');
});

test('normalisation is locale-invariant', () => {
  assert.equal(normalizeRiotId('II#TR1'), 'ii#tr1');
});
