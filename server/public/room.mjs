/**
 * Room names, browser edition.
 *
 * This is the THIRD implementation of the derivation contract, alongside
 * src/main/game/room.ts in the desktop app and server/src/room.ts on the token
 * server. All three must agree exactly or clients land in different rooms and
 * never hear each other. test/web-room.test.mjs asserts the same golden vector
 * the other two suites assert; if it fails, do not ship.
 *
 * The steps are documented in full in src/main/game/room.ts. The only
 * difference here is that SHA-256 goes through Web Crypto, which is async, so
 * the derive functions return promises.
 *
 * No build step: this is a plain ES module loaded directly by the page and by
 * node --test.
 */

export const ROOM_SEPARATOR = '\u001f';
export const HASH_LENGTH = 12;
export const RANDOM_LENGTH = 20;
export const ROSTER_NAMESPACE = 'roster';
export const LOBBY_NAMESPACE = 'lobby';

const BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const PATTERNS = {
  roster: /^R[0-9A-F]{12}$/,
  lobby: /^L[0-9A-F]{12}$/,
  random: new RegExp(`^X[${BASE32}]{${RANDOM_LENGTH}}$`),
};

/** 'roster' | 'lobby' | 'random', or null if this is not a room name. */
export function roomKind(name) {
  for (const [kind, pattern] of Object.entries(PATTERNS)) {
    if (pattern.test(name)) return kind;
  }
  return null;
}

export function compareCodepoints(a, b) {
  const ca = Array.from(a);
  const cb = Array.from(b);
  const n = Math.min(ca.length, cb.length);
  for (let i = 0; i < n; i++) {
    const pa = ca[i].codePointAt(0);
    const pb = cb[i].codePointAt(0);
    if (pa !== pb) return pa < pb ? -1 : 1;
  }
  return ca.length - cb.length;
}

export function normalizeRiotId(riotId) {
  return riotId.normalize('NFC').trim().toLowerCase();
}

export function rosterKey(riotIds) {
  return (
    ROSTER_NAMESPACE +
    ROOM_SEPARATOR +
    riotIds
      .map(normalizeRiotId)
      .filter((id) => id.length > 0)
      .sort(compareCodepoints)
      .join(ROOM_SEPARATOR)
  );
}

async function truncatedHash(key) {
  const bytes = new TextEncoder().encode(key);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, HASH_LENGTH)
    .toUpperCase();
}

export async function deriveRoomName(riotIds) {
  return `R${await truncatedHash(rosterKey(riotIds))}`;
}

export async function deriveLobbyRoom(lobbyId) {
  const key = LOBBY_NAMESPACE + ROOM_SEPARATOR + lobbyId.normalize('NFC').trim().toLowerCase();
  return `L${await truncatedHash(key)}`;
}
