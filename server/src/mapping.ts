import { roomKind } from './room';

/**
 * lobby room  <->  roster room.
 *
 * Why it exists: a champ select link carries a LOBBY room (Solo Queue hides
 * teammates' names, so the roster room cannot be computed yet). A client whose
 * app starts after champ select — which is the normal first-run experience —
 * can only compute the ROSTER room. Without a mapping those two groups sit in
 * different rooms and cannot hear each other, silently. That is the exact
 * failure mode this project refuses everywhere else.
 *
 * Three guards, all of them deliberate:
 *
 *   FIRST WRITE WINS. Once a lobby has a mapping it cannot be changed. A later
 *   write with different values is refused, not accepted. Last-write-wins would
 *   let anyone who can pass verification for *some* roster room repoint an
 *   established lobby at their own room and pull the team into it. An identical
 *   repeat write is accepted as a no-op so retries and several allies racing to
 *   publish all succeed.
 *
 *   TTL. Two hours, then the entry is gone. These are ephemeral by nature —
 *   a mapping outlives its game by definition, and nothing should accumulate.
 *
 *   VERIFIED WRITER. Enforced by the caller, which must have passed spectator
 *   verification FOR THE ROSTER ROOM BEING MAPPED — not merely be some verified
 *   caller. Without that specificity, anyone in any live game could publish a
 *   mapping for any lobby.
 *
 * Both directions are stored, because the lookup a mid-game client needs runs
 * roster -> lobby, while the one a link needs runs lobby -> roster.
 */

export const MAPPING_TTL_MS = 2 * 60 * 60 * 1000;

export interface RoomMapping {
  lobbyRoom: string;
  rosterRoom: string;
}

export type MappingResult =
  | { ok: true; mapping: RoomMapping; created: boolean }
  | { ok: false; status: number; reason: string };

interface Entry extends RoomMapping {
  expires: number;
}

export class MappingStore {
  private byLobby = new Map<string, Entry>();
  private byRoster = new Map<string, Entry>();

  constructor(private ttlMs = MAPPING_TTL_MS) {}

  private sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.byLobby) if (entry.expires <= now) this.byLobby.delete(key);
    for (const [key, entry] of this.byRoster) if (entry.expires <= now) this.byRoster.delete(key);
  }

  private live(map: Map<string, Entry>, key: string): Entry | null {
    const entry = map.get(key);
    if (!entry) return null;
    if (entry.expires <= Date.now()) {
      map.delete(key);
      return null;
    }
    return entry;
  }

  /** Caller MUST have verified the writer against `rosterRoom` first. */
  put(lobbyRoom: string, rosterRoom: string): MappingResult {
    if (roomKind(lobbyRoom) !== 'lobby') {
      return { ok: false, status: 400, reason: 'lobbyRoom is not a lobby room' };
    }
    if (roomKind(rosterRoom) !== 'roster') {
      return { ok: false, status: 400, reason: 'rosterRoom is not a roster room' };
    }
    this.sweep();

    const existingLobby = this.live(this.byLobby, lobbyRoom);
    const existingRoster = this.live(this.byRoster, rosterRoom);
    const existing = existingLobby ?? existingRoster;

    if (existing) {
      const identical = existing.lobbyRoom === lobbyRoom && existing.rosterRoom === rosterRoom;
      if (!identical) {
        return { ok: false, status: 409, reason: 'a different mapping already exists' };
      }
      // Idempotent: several allies publishing the same truth all succeed. The
      // TTL is deliberately NOT extended, so a mapping cannot be kept alive
      // indefinitely by repeated writes.
      return { ok: true, mapping: { lobbyRoom, rosterRoom }, created: false };
    }

    const entry: Entry = { lobbyRoom, rosterRoom, expires: Date.now() + this.ttlMs };
    this.byLobby.set(lobbyRoom, entry);
    this.byRoster.set(rosterRoom, entry);
    return { ok: true, mapping: { lobbyRoom, rosterRoom }, created: true };
  }

  /** Looks up by either side. */
  get(room: string): RoomMapping | null {
    const entry = this.live(this.byLobby, room) ?? this.live(this.byRoster, room);
    return entry ? { lobbyRoom: entry.lobbyRoom, rosterRoom: entry.rosterRoom } : null;
  }

  size(): number {
    this.sweep();
    return this.byLobby.size;
  }
}
