/**
 * Configuration and the development bypass.
 *
 * The bypass exists so the app can be worked on without a production Riot key.
 * It hands a LiveKit token to anyone who asks, for any room, with no check that
 * the requester is in the game — which is exactly the hole the verification is
 * there to close. It MUST NEVER SHIP. Two guards:
 *
 *   1. The process refuses to start if the bypass is set while
 *      NODE_ENV=production. This is a hard failure, not a warning.
 *   2. Every bypassed request logs a loud line, so a misconfigured staging box
 *      is obvious in the logs within seconds rather than after an incident.
 *
 * Neither guard is a substitute for not setting the variable in production.
 */

export interface Config {
  port: number;
  /**
   * Null means this deployment cannot verify League membership at all. That is
   * a supported configuration, not a broken one: the web client only ever uses
   * random rooms, which need no Riot call, so the web product can launch before
   * a production key exists. Roster rooms and mapped lobby rooms are REFUSED in
   * that state — never granted. Refusing is the opposite of the dev bypass.
   */
  riotApiKey: string | null;
  livekitUrl: string;
  livekitApiKey: string;
  livekitApiSecret: string;
  devBypassVerification: boolean;
  /** How long an issued token may be used to CONNECT. Sessions outlive it. */
  tokenTtlSeconds: number;
  /**
   * Hard cap on people in one room, enforced server-side. A room link is pasted
   * into chat and is therefore public, so the client cannot be the thing that
   * counts seats. 0 disables the cap.
   */
  maxSeats: number;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value) return value;
  throw new Error(`missing required environment variable ${name}`);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const devBypassVerification = env.QVOICE_DEV_BYPASS_VERIFICATION === 'true';
  const isProduction = env.NODE_ENV === 'production';

  if (devBypassVerification && isProduction) {
    throw new Error(
      'QVOICE_DEV_BYPASS_VERIFICATION is set while NODE_ENV=production. ' +
        'The bypass issues tokens without checking that the requester is in the game. ' +
        'Refusing to start.'
    );
  }

  return {
    port: Number(env.PORT ?? 8080),
    riotApiKey: env.RIOT_API_KEY || null,
    livekitUrl: required(env, 'LIVEKIT_URL'),
    livekitApiKey: required(env, 'LIVEKIT_API_KEY'),
    livekitApiSecret: required(env, 'LIVEKIT_API_SECRET'),
    devBypassVerification,
    tokenTtlSeconds: 600,
    maxSeats: Number(env.MAX_SEATS ?? 5),
  };
}

/** Platform routing values accepted from clients. */
export const PLATFORMS = [
  'br1',
  'eun1',
  'euw1',
  'jp1',
  'kr',
  'la1',
  'la2',
  'me1',
  'na1',
  'oc1',
  'ru',
  'sg2',
  'tr1',
  'tw2',
  'vn2',
] as const;

export type Platform = (typeof PLATFORMS)[number];

/** Account-V1 lives on regional routes, not platform routes. */
const REGIONAL: Record<string, string> = {
  br1: 'americas',
  la1: 'americas',
  la2: 'americas',
  na1: 'americas',
  eun1: 'europe',
  euw1: 'europe',
  me1: 'europe',
  ru: 'europe',
  tr1: 'europe',
  jp1: 'asia',
  kr: 'asia',
  oc1: 'sea',
  sg2: 'sea',
  tw2: 'sea',
  vn2: 'sea',
};

export function isPlatform(value: string): value is Platform {
  return (PLATFORMS as readonly string[]).includes(value);
}

export function regionalRouteFor(platform: Platform): string {
  return REGIONAL[platform] ?? 'europe';
}
