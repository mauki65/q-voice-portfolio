import { createHash, randomBytes } from 'node:crypto';

/**
 * Room names come in two kinds, and the kind is readable from the name itself
 * so the token server can route on it without trusting the caller to declare it.
 *
 *   R<12 hex>    ROSTER, derived from the ally roster's Riot IDs.
 *   L<12 hex>    LOBBY,  derived from the champ select chat id.
 *   X<20 base32> RANDOM, generated, web-originated.
 *
 * DERIVED vs RANDOM is a security distinction, not a cosmetic one.
 *
 * Derived rooms exist for exactly one reason: two app clients must independently
 * arrive at the same room with no coordination. That determinism is what makes
 * a roster room publicly computable — any live game's roster is on op.gg and
 * the Spectator API, and this contract is public — so a roster room proves
 * nothing about who is asking, and the token server MUST verify membership
 * before issuing a token for one.
 *
 * Random rooms have no such requirement. A browser user creates a room and
 * shares the link; possession of the link is the access control. So the id is
 * simply unguessable, and the token server does no Riot lookup for it at all.
 * That is what lets the web client ship with no Riot API key.
 *
 * Lobby rooms sit in between and are documented at deriveLobbyRoom().
 *
 * ---------------------------------------------------------------------------
 * THE ROSTER DERIVATION CONTRACT. Every step is pinned, because two clients on
 * different versions would land in different rooms and never hear each other.
 * The web client must implement exactly this, and the token server re-derives
 * it independently.
 *
 *   1. Each ally's FULL Riot ID including the tagline, e.g. "Faker#KR1". All
 *      five allies including the local player. Nothing else — not champion, not
 *      position, not game time; those differ between clients or change mid-game.
 *   2. Unicode-normalise to NFC.
 *   3. Trim leading and trailing whitespace.
 *   4. Lowercase with toLowerCase() — the locale-INVARIANT one.
 *      toLocaleLowerCase is forbidden: a Turkish-locale client maps "I" to a
 *      dotless i and derives a different room.
 *   5. Sort ascending by Unicode code point. NOT localeCompare (locale-
 *      dependent) and NOT a plain < comparison, which orders UTF-16 code units
 *      and misplaces astral characters against U+E000-U+FFFF.
 *   6. Join with U+001F (UNIT SEPARATOR) — a control character, so it cannot
 *      occur inside a Riot ID and cannot be used to force a collision.
 *   7. Prefix the namespace: "roster" + U+001F + <joined>.
 *   8. SHA-256 over the UTF-8 bytes, first 12 hex characters, uppercased.
 *   9. Prefix "R".
 *
 * Region is deliberately NOT part of this. The Live Client Data API does not
 * expose it, so a client that has not yet learned its region would derive a
 * different name for the same game and sit alone. The roster hash already
 * identifies the game uniquely; region is display metadata only.
 * ---------------------------------------------------------------------------
 */

export const ROOM_SEPARATOR = '\u001f';
export const HASH_LENGTH = 12;
export const RANDOM_LENGTH = 20;

export const ROSTER_NAMESPACE = 'roster';
export const LOBBY_NAMESPACE = 'lobby';

export type RoomKind = 'roster' | 'lobby' | 'random';

/** Crockford-style: no I, L, O or U, so a shared link cannot be misread. */
const BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const PATTERNS: Record<RoomKind, RegExp> = {
  roster: /^R[0-9A-F]{12}$/,
  lobby: /^L[0-9A-F]{12}$/,
  random: new RegExp(`^X[${BASE32}]{${RANDOM_LENGTH}}$`),
};

/** Null for anything that is not a well-formed room name. */
export function roomKind(name: string): RoomKind | null {
  for (const [kind, pattern] of Object.entries(PATTERNS) as [RoomKind, RegExp][]) {
    if (pattern.test(name)) return kind;
  }
  return null;
}

/** True for rooms whose name is computable by anyone, and so must be verified. */
export function requiresVerification(kind: RoomKind): boolean {
  return kind === 'roster';
}

/** Ascending comparison by Unicode code point. */
export function compareCodepoints(a: string, b: string): number {
  const ca = Array.from(a);
  const cb = Array.from(b);
  const n = Math.min(ca.length, cb.length);
  for (let i = 0; i < n; i++) {
    const pa = ca[i].codePointAt(0) as number;
    const pb = cb[i].codePointAt(0) as number;
    if (pa !== pb) return pa < pb ? -1 : 1;
  }
  return ca.length - cb.length;
}

export function normalizeRiotId(riotId: string): string {
  return riotId.normalize('NFC').trim().toLowerCase();
}

/** The exact string that gets hashed. Exported so the web client can be diffed against it. */
export function rosterKey(riotIds: readonly string[]): string {
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

function truncatedHash(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex').slice(0, HASH_LENGTH).toUpperCase();
}

export function deriveRoomName(riotIds: readonly string[]): string {
  return `R${truncatedHash(rosterKey(riotIds))}`;
}

/**
 * Room name for a champ select lobby.
 *
 * The in-game room is derived from the ally roster, and ranked Solo Queue HIDES
 * teammates' names during champ select — so at the moment the link has to be
 * posted, the roster room cannot be computed. The one identifier all five
 * allies provably share is the team chat's multi-user chat id, which the LCU
 * hands every client identically.
 *
 * Unlike a roster room this is NOT publicly computable: the chat id appears
 * nowhere outside the five clients in that lobby. Its security properties are
 * closer to a random room's than to a roster room's, which is why the token
 * server treats it accordingly — see the routing note in the server.
 */
export function deriveLobbyRoom(lobbyId: string): string {
  const key = LOBBY_NAMESPACE + ROOM_SEPARATOR + lobbyId.normalize('NFC').trim().toLowerCase();
  return `L${truncatedHash(key)}`;
}

/**
 * A web-originated room. 100 bits of entropy, which is unguessable by any
 * practical measure, and involves no Riot API at all — the whole point being
 * that the web client can ship before a production key exists.
 *
 * 256 is an exact multiple of 32, so byte % 32 is already uniform and needs no
 * rejection sampling. If the alphabet ever stops being a power of two, this
 * becomes biased and must be rewritten.
 */
export function createRandomRoom(): string {
  let out = '';
  for (const byte of randomBytes(RANDOM_LENGTH)) out += BASE32[byte % 32];
  return `X${out}`;
}
