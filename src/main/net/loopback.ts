import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import type { TLSSocket } from 'node:tls';

/**
 * Shared TLS handling for Riot's two loopback services: the Live Client Data
 * API on 2999 and the LCU on its lockfile port. Both present a certificate
 * signed by Riot's own root, which is not in the OS trust store.
 *
 * The relaxation is scoped to these hosts. NODE_TLS_REJECT_UNAUTHORIZED is
 * never touched, no app-level certificate handler is installed, and the agent
 * below is only ever used for 127.0.0.1 requests made through `loopbackRequest`,
 * which refuses any other host.
 *
 * Two levels, in order of preference:
 *   - certs/riotgames.pem present: the chain is verified against it. Only the
 *     hostname check is replaced, because the certificate names a Riot domain
 *     while we connect to a loopback literal.
 *   - no PEM: the chain cannot be verified, so the peer certificate's issuer is
 *     inspected and the connection dropped unless it is Riot's.
 */

const ALLOWED_HOST = '127.0.0.1';

function loadRiotCa(): Buffer | null {
  const bases = [path.join(__dirname, '..', '..', '..'), process.resourcesPath ?? ''];
  for (const base of bases) {
    if (!base) continue;
    const candidate = path.join(base, 'certs', 'riotgames.pem');
    try {
      if (fs.existsSync(candidate)) return fs.readFileSync(candidate);
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

export const riotCa = loadRiotCa();

export const riotLoopbackAgent = new https.Agent({
  rejectUnauthorized: Boolean(riotCa),
  ca: riotCa ?? undefined,
  checkServerIdentity: () => undefined,
  keepAlive: false,
});

export interface LoopbackOptions {
  port: number;
  path: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  /** Bytes after which the response is abandoned. */
  maxBytes?: number;
}

export interface LoopbackResponse {
  status: number;
  body: string;
}

export function loopbackRequest(options: LoopbackOptions): Promise<LoopbackResponse> {
  const {
    port,
    path: pathname,
    method = 'GET',
    headers = {},
    body,
    timeoutMs = 4_000,
    maxBytes = 2_000_000,
  } = options;

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: ALLOWED_HOST,
        port,
        path: pathname,
        method,
        agent: riotLoopbackAgent,
        timeout: timeoutMs,
        headers: body
          ? { ...headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
          : headers,
      },
      (res) => {
        if (!riotCa) {
          const cert = (res.socket as TLSSocket).getPeerCertificate?.();
          const issuer = `${cert?.issuer?.O ?? ''} ${cert?.issuer?.CN ?? ''}`;
          if (!/riot/i.test(issuer)) {
            res.destroy();
            reject(new Error(`unexpected certificate issuer on :${port}: ${issuer.trim()}`));
            return;
          }
        }
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          text += chunk;
          if (text.length > maxBytes) {
            res.destroy();
            reject(new Error(`response from :${port}${pathname} exceeded ${maxBytes} bytes`));
          }
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
      }
    );
    req.on('timeout', () => req.destroy(new Error(`timeout talking to :${port}${pathname}`)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/** Error codes that mean "the service is not running", which is not a failure. */
export const NOT_RUNNING_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'ECONNABORTED',
  'EPIPE',
]);

export function isNotRunning(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code ?? '';
  return NOT_RUNNING_CODES.has(code);
}
