import { deriveRoomName, roomKind } from './room';
import type { Platform } from './config';
import { RiotApiError, type RiotClient } from './riot';

/**
 * Room membership check.
 *
 * A room name is derivable from public data: any live game's roster is on
 * op.gg, Porofessor and the Spectator API, and the hashing contract is public
 * so the web client can mirror it. Knowing the room name therefore proves
 * nothing, and the room name must not be the access control. This is.
 *
 * The rule: the claimed identity must currently be in a live game whose ALLY
 * roster derives exactly the claimed room name.
 *
 * WHAT THIS DOES NOT DO — read this before treating it as authentication.
 * It proves the claimed identity is in the game. It does NOT prove the
 * requester IS that identity. Riot IDs are public, so an outsider who wants in
 * can still claim a real teammate's Riot ID.
 *
 * There is no server-side trick that closes this. A "one claim per identity"
 * rule does not: the impersonator resolves to the same PUUID as the real
 * player, so the server cannot tell a second claim from the real player
 * reconnecting, and enforcing it would lock out legitimate reconnects while
 * stopping nobody. What would close it is Riot Sign-On.
 *
 * RSO IS NOT ASSUMED. It is granted separately from a production API key and
 * may never be approved, so nothing in this build depends on it. What exists
 * instead is a seam: every request carries an IdentityAssertion, today always
 * `self-asserted`. If RSO is ever granted, the app trades its authorization
 * code here, this function receives `{ kind: 'rso', puuid }`, and the PUUID
 * lookup below is skipped in favour of the proven one — the membership check
 * itself does not change. Nothing else in the codebase needs to know.
 *
 * Until then the mitigation is visibility, not prevention: RoomPresence below
 * feeds a participant list that everyone in the room can see, so an unexpected
 * name is noticed rather than silent. That is a real reduction in the useful
 * attack (quiet listening) and no defence at all against a determined one.
 */

export type VerifyOutcome =
  | { ok: true; puuid: string; allies: string[]; assertion: IdentityAssertion }
  | { ok: false; status: number; reason: string };

/**
 * How much the server believes the caller is who they say they are.
 *
 * This is the RSO seam. Only 'self-asserted' is produced today; the shape is
 * here so that adding RSO later is an additive change rather than a rewrite,
 * and so that anything reading a VerifyOutcome has to acknowledge which kind it
 * got rather than silently assuming proof.
 */
export type IdentityAssertion =
  | { kind: 'self-asserted' }
  | { kind: 'rso'; puuid: string };

export const SELF_ASSERTED: IdentityAssertion = { kind: 'self-asserted' };

export interface VerifyRequest {
  roomName: string;
  identity: string;
  platform: Platform;
  /** Defaults to self-asserted; see IdentityAssertion. */
  assertion?: IdentityAssertion;
}


export async function verifyMembership(
  riot: RiotClient,
  { roomName, identity, platform, assertion = SELF_ASSERTED }: VerifyRequest
): Promise<VerifyOutcome> {
  if (roomKind(roomName) !== 'roster') {
    // Only roster rooms are verifiable this way: they are the only kind the
    // Spectator API can independently reproduce.
    return { ok: false, status: 400, reason: 'not a verifiable room name' };
  }

  let puuid: string | null;
  let game;
  try {
    // With RSO the PUUID arrives proven and this lookup is skipped. Everything
    // after this point is identical either way.
    puuid = assertion.kind === 'rso' ? assertion.puuid : await riot.puuidForRiotId(identity, platform);
    if (!puuid) return { ok: false, status: 404, reason: 'no Riot account for that identity' };
    game = await riot.activeGameForPuuid(puuid, platform);
  } catch (err) {
    if (err instanceof RiotApiError) return { ok: false, status: err.status, reason: err.message };
    throw err;
  }

  if (!game) return { ok: false, status: 403, reason: 'identity is not in a live game' };

  const me = game.participants.find((p) => p.puuid === puuid);
  if (!me) return { ok: false, status: 403, reason: 'identity is not a participant in that game' };

  const allies = game.participants.filter((p) => p.teamId === me.teamId);
  const riotIds = allies.map((p) => p.riotId ?? '');
  if (riotIds.some((id) => id === '')) {
    // Deriving from a partial roster would produce a different hash than the
    // client's and reject a legitimate player. Fail loudly instead of guessing.
    return { ok: false, status: 503, reason: 'spectator roster is missing Riot IDs' };
  }

  const expected = deriveRoomName(riotIds);
  if (expected !== roomName) {
    return { ok: false, status: 403, reason: 'room name does not match the caller’s live game' };
  }

  return { ok: true, puuid, allies: riotIds, assertion };
}

/**
 * Who is currently in each room, for the participant list.
 *
 * PRESENCE, NOT ACCESS CONTROL. Entries are self-reported identities that
 * passed verifyMembership; see the note above for why this cannot be used to
 * refuse a second claim of the same name. Entries expire on their own so a
 * crashed client disappears from the list instead of lingering all game.
 */
export class RoomPresence {
  private rooms = new Map<string, Map<string, number>>();

  constructor(private ttlMs = 5 * 60 * 1000) {}

  record(roomName: string, identity: string): void {
    const room = this.rooms.get(roomName) ?? new Map<string, number>();
    room.set(identity, Date.now() + this.ttlMs);
    this.rooms.set(roomName, room);
  }

  members(roomName: string): string[] {
    const now = Date.now();
    const room = this.rooms.get(roomName);
    if (!room) return [];
    for (const [identity, expires] of room) {
      if (expires <= now) room.delete(identity);
    }
    if (room.size === 0) this.rooms.delete(roomName);
    return [...room.keys()].sort();
  }
}
