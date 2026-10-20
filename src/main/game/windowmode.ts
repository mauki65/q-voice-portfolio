import fs from 'node:fs';
import path from 'node:path';
import { resolveInstallDir } from '../lcu/lockfile';

/**
 * League's window mode, which decides whether an overlay can be drawn at all.
 *
 * A transparent always-on-top window composites over a Windowed or Borderless
 * game. It CANNOT appear over exclusive fullscreen, where the game owns the
 * display surface outright. Rather than drawing nothing and leaving the user to
 * wonder, the app detects the mode and says so.
 *
 * Two sources, both of which work with League closed:
 *   - the LCU game settings, when the client is up
 *   - <install>/Config/game.cfg, which is what the client writes
 *
 * game.cfg is a plain INI with `WindowMode=<n>` under [General].
 *
 * NOTE ON THE MAPPING: 0 = Windowed, 1 = Borderless, 2 = Fullscreen. This is
 * the ordering the client has used for years, but it is not documented by Riot
 * and could change. It is deliberately fail-open: an unrecognised value yields
 * `unknown`, and `unknown` never triggers the warning, because telling a
 * Borderless user their overlay will not work is worse than staying quiet.
 */

export type WindowMode = 'windowed' | 'borderless' | 'fullscreen' | 'unknown';

const BY_VALUE: Record<string, WindowMode> = {
  '0': 'windowed',
  '1': 'borderless',
  '2': 'fullscreen',
};

export function parseGameCfg(contents: string): WindowMode {
  for (const line of contents.split(/\r?\n/)) {
    const match = /^\s*WindowMode\s*=\s*(\d+)/i.exec(line);
    if (match) return BY_VALUE[match[1]] ?? 'unknown';
  }
  return 'unknown';
}

/** The LCU shape has moved around; accept a numeric or string WindowMode leaf. */
export function parseLcuGameSettings(payload: unknown): WindowMode {
  let found: WindowMode = 'unknown';

  const walk = (node: unknown, depth: number): void => {
    if (found !== 'unknown' || depth > 6 || node === null || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'WindowMode' && (typeof value === 'number' || typeof value === 'string')) {
        found = BY_VALUE[String(value)] ?? 'unknown';
        if (found !== 'unknown') return;
      } else if (typeof value === 'object') {
        walk(value, depth + 1);
      }
    }
  };

  walk(payload, 0);
  return found;
}

export function readWindowModeFromDisk(configuredPath?: string): WindowMode {
  const installDir = resolveInstallDir(configuredPath);
  if (!installDir) return 'unknown';
  const cfg = path.join(installDir, 'Config', 'game.cfg');
  try {
    if (fs.existsSync(cfg)) return parseGameCfg(fs.readFileSync(cfg, 'utf8'));
  } catch {
    /* unreadable — stay unknown rather than guessing */
  }
  return 'unknown';
}

/** Only exclusive fullscreen actually blocks the overlay. */
export function overlayCanRender(mode: WindowMode): boolean {
  return mode !== 'fullscreen';
}
