import { request } from 'node:https';
import { request as httpRequest } from 'node:http';
import { URL } from 'node:url';

/**
 * The token server's mapping endpoints, from the app's side.
 *
 * A client that saw champ select holds a lobby room; a client that started
 * mid-game — the normal first-run experience — holds only a roster room. The
 * mapping is what stops those two groups sitting in different rooms, silently.
 *
 * Everything here fails soft: the server being unreachable must never stop the
 * app working, it just means the mapping is unknown and the caller says so.
 */

export interface RoomMapping {
  lobbyRoom: string;
  rosterRoom: string;
}

export type LookupResult =
  | { status: 'found'; mapping: RoomMapping }
  | { status: 'none' }
  | { status: 'unreachable'; reason: string };

async function call(
  baseUrl: string,
  pathname: string,
  method: 'GET' | 'POST',
  body?: unknown
): Promise<{ status: number; body: string }> {
  const url = new URL(pathname, baseUrl);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const send = url.protocol === 'http:' ? httpRequest : request;

  return new Promise((resolve, reject) => {
    const req = send(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'http:' ? 80 : 443),
        path: url.pathname + url.search,
        method,
        timeout: 6_000,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          text += chunk;
          if (text.length > 64_000) {
            res.destroy();
            reject(new Error('token server response too large'));
          }
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
      }
    );
    req.on('timeout', () => req.destroy(new Error('token server timed out')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export async function lookupMapping(baseUrl: string, room: string): Promise<LookupResult> {
  try {
    const res = await call(baseUrl, `/mapping/${encodeURIComponent(room)}`, 'GET');
    if (res.status === 404) return { status: 'none' };
    if (res.status !== 200) return { status: 'unreachable', reason: `HTTP ${res.status}` };
    return { status: 'found', mapping: JSON.parse(res.body) as RoomMapping };
  } catch (err) {
    return { status: 'unreachable', reason: err instanceof Error ? err.message : String(err) };
  }
}

export interface TokenGrant {
  ok: true;
  token: string;
  wsUrl: string;
  members: string[];
}

export type TokenResult = TokenGrant | { ok: false; reason: string };

export async function requestToken(
  baseUrl: string,
  body: { roomName: string; identity: string; platform?: string }
): Promise<TokenResult> {
  try {
    const res = await call(baseUrl, '/token', 'POST', body);
    if (res.status !== 200) {
      let reason = `HTTP ${res.status}`;
      try {
        reason = (JSON.parse(res.body) as { error?: string }).error ?? reason;
      } catch {
        /* keep the status */
      }
      return { ok: false, reason };
    }
    const parsed = JSON.parse(res.body) as { token: string; wsUrl: string; members?: string[] };
    return { ok: true, token: parsed.token, wsUrl: parsed.wsUrl, members: parsed.members ?? [] };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

export type PublishResult =
  | { status: 'established' }
  | { status: 'already' }
  /** Someone else's mapping is in place; first write wins, so we follow it. */
  | { status: 'conflict' }
  | { status: 'refused'; reason: string }
  | { status: 'unreachable'; reason: string };

export async function publishMapping(
  baseUrl: string,
  mapping: RoomMapping & { identity: string; platform: string }
): Promise<PublishResult> {
  try {
    const res = await call(baseUrl, '/mapping', 'POST', mapping);
    if (res.status === 201) return { status: 'established' };
    if (res.status === 200) return { status: 'already' };
    if (res.status === 409) return { status: 'conflict' };
    return { status: 'refused', reason: `HTTP ${res.status}: ${res.body.slice(0, 200)}` };
  } catch (err) {
    return { status: 'unreachable', reason: err instanceof Error ? err.message : String(err) };
  }
}
