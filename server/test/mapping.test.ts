import test from 'node:test';
import assert from 'node:assert/strict';
import { MappingStore } from '../src/mapping';
import { createRandomRoom, deriveLobbyRoom, deriveRoomName, roomKind } from '../src/room';

const LOBBY = deriveLobbyRoom('c1a2b3d4@champ-select.eu1.pvp.net');
const ROSTER = deriveRoomName(['Faker#KR1', 'Caps#EUW']);
const OTHER_ROSTER = deriveRoomName(['Someone#EUW', 'Else#EUW']);

test('a mapping is readable from either side', () => {
  const store = new MappingStore();
  assert.equal(store.put(LOBBY, ROSTER).ok, true);
  assert.deepEqual(store.get(LOBBY), { lobbyRoom: LOBBY, rosterRoom: ROSTER });
  assert.deepEqual(store.get(ROSTER), { lobbyRoom: LOBBY, rosterRoom: ROSTER });
});

test('first write wins — a later different mapping is refused', () => {
  const store = new MappingStore();
  assert.equal((store.put(LOBBY, ROSTER) as { created: boolean }).created, true);

  const hijack = store.put(LOBBY, OTHER_ROSTER);
  assert.equal(hijack.ok, false, 'an established lobby must not be repointed');
  assert.equal((hijack as { status: number }).status, 409);
  assert.deepEqual(store.get(LOBBY), { lobbyRoom: LOBBY, rosterRoom: ROSTER });
});

test('a roster room cannot be claimed by a second lobby either', () => {
  const store = new MappingStore();
  store.put(LOBBY, ROSTER);
  const other = deriveLobbyRoom('deadbeef@champ-select.eu1.pvp.net');
  assert.equal(store.put(other, ROSTER).ok, false);
});

test('an identical repeat write is an idempotent no-op, not a conflict', () => {
  // Several allies reach game start at once and all publish the same truth.
  const store = new MappingStore();
  assert.equal((store.put(LOBBY, ROSTER) as { created: boolean }).created, true);
  const again = store.put(LOBBY, ROSTER);
  assert.equal(again.ok, true);
  assert.equal((again as { created: boolean }).created, false);
});

test('repeat writes do not extend the lifetime', async () => {
  const store = new MappingStore(40);
  store.put(LOBBY, ROSTER);
  await new Promise((r) => setTimeout(r, 25));
  store.put(LOBBY, ROSTER);
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(store.get(LOBBY), null, 'the TTL runs from the first write');
});

test('mappings expire and stop accumulating', async () => {
  const store = new MappingStore(30);
  store.put(LOBBY, ROSTER);
  assert.equal(store.size(), 1);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(store.get(LOBBY), null);
  assert.equal(store.size(), 0);
});

test('the room kinds must be the right way round', () => {
  const store = new MappingStore();
  assert.equal(store.put(ROSTER, LOBBY).ok, false, 'arguments swapped');
  assert.equal(store.put(LOBBY, createRandomRoom()).ok, false, 'a random room is not a roster room');
  assert.equal(store.put(createRandomRoom(), ROSTER).ok, false, 'a random room is not a lobby');
});

test('room kinds are readable from the name', () => {
  assert.equal(roomKind(LOBBY), 'lobby');
  assert.equal(roomKind(ROSTER), 'roster');
  assert.equal(roomKind(createRandomRoom()), 'random');
  assert.equal(roomKind('6FDDFD99DC94'), null, 'the old unprefixed format is not accepted');
});

test('random rooms are unguessable and never repeat', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 500; i++) seen.add(createRandomRoom());
  assert.equal(seen.size, 500);
  // 20 base32 characters is 100 bits.
  assert.equal([...seen][0].length, 21);
});
