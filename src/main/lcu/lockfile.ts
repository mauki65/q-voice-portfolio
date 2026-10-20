import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Finding the LCU's port and password.
 *
 * The client writes a lockfile into its install directory on startup and
 * deletes it on exit, so its presence is also the "is League running" signal.
 * Format, colon separated:
 *
 *     LeagueClient:<pid>:<port>:<password>:https
 *
 * The install directory is not fixed, so this tries, in order:
 *   1. a path the user set explicitly in settings
 *   2. Riot's own product settings file in ProgramData, which records the real
 *      install path and is written by the installer
 *   3. the usual default locations
 *   4. the running LeagueClientUx command line, which carries --app-port and
 *      --remoting-auth-token directly. This is last because it spawns
 *      PowerShell, but it is the only one that works for an unusual install
 *      whose lockfile we cannot locate.
 */

export interface LcuCredentials {
  port: number;
  password: string;
  /** Where it came from, for the diagnostics log. */
  source: string;
}

const PRODUCT_SETTINGS = path.join(
  process.env.PROGRAMDATA ?? 'C:\\ProgramData',
  'Riot Games',
  'Metadata',
  'league_of_legends.live',
  'league_of_legends.live.product_settings.yaml'
);

const DEFAULT_INSTALLS = [
  'C:\\Riot Games\\League of Legends',
  'D:\\Riot Games\\League of Legends',
  'C:\\Program Files\\Riot Games\\League of Legends',
  'C:\\Program Files (x86)\\Riot Games\\League of Legends',
];

export function parseLockfile(contents: string): Omit<LcuCredentials, 'source'> | null {
  const parts = contents.trim().split(':');
  if (parts.length < 5) return null;
  const port = Number(parts[2]);
  const password = parts[3];
  if (!Number.isInteger(port) || port <= 0 || !password) return null;
  return { port, password };
}

/**
 * Reads the install path Riot's installer recorded. Deliberately not a YAML
 * parser: one known key, one line. Double-quoted YAML escapes backslashes, so a
 * Windows path arrives as C:\\Riot Games\\... and has to be unescaped —
 * otherwise the path never resolves and the lockfile is never found.
 */
export function installPathFromProductSettings(yaml: string): string | null {
  const quoted = /product_install_full_path:\s*"((?:[^"\\]|\\.)*)"/.exec(yaml);
  if (quoted) return quoted[1].replace(/\\(.)/g, '$1').trim();
  const bare = /product_install_full_path:\s*([^\n\r]+)/.exec(yaml);
  return bare ? bare[1].trim() : null;
}

function readLockfileAt(installDir: string, source: string): LcuCredentials | null {
  try {
    const file = path.join(installDir, 'lockfile');
    if (!fs.existsSync(file)) return null;
    const parsed = parseLockfile(fs.readFileSync(file, 'utf8'));
    return parsed ? { ...parsed, source } : null;
  } catch {
    // Locked or unreadable — treat as absent and try the next candidate.
    return null;
  }
}

export function candidateInstallPaths(configured?: string): string[] {
  const paths: string[] = [];
  if (configured) paths.push(configured);
  try {
    if (fs.existsSync(PRODUCT_SETTINGS)) {
      const fromSettings = installPathFromProductSettings(fs.readFileSync(PRODUCT_SETTINGS, 'utf8'));
      if (fromSettings) paths.push(fromSettings);
    }
  } catch {
    /* fall through to the defaults */
  }
  paths.push(...DEFAULT_INSTALLS);
  return [...new Set(paths)];
}

export function parseProcessCommandLine(commandLine: string): Omit<LcuCredentials, 'source'> | null {
  const port = /--app-port=(\d+)/.exec(commandLine);
  const token = /--remoting-auth-token=([\w-]+)/.exec(commandLine);
  if (!port || !token) return null;
  return { port: Number(port[1]), password: token[1] };
}

async function fromProcessList(): Promise<LcuCredentials | null> {
  if (process.platform !== 'win32') return null;
  try {
    const { stdout } = await run(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "(Get-CimInstance Win32_Process -Filter \"name='LeagueClientUx.exe'\").CommandLine",
      ],
      { timeout: 8_000, windowsHide: true }
    );
    const parsed = parseProcessCommandLine(stdout);
    return parsed ? { ...parsed, source: 'LeagueClientUx command line' } : null;
  } catch {
    return null;
  }
}

/** Null means League is not running (or its credentials are unreachable). */
export async function findCredentials(configuredPath?: string): Promise<LcuCredentials | null> {
  for (const dir of candidateInstallPaths(configuredPath)) {
    const found = readLockfileAt(dir, `lockfile in ${dir}`);
    if (found) return found;
  }
  return fromProcessList();
}

/** The install directory whose lockfile we used, for reading Config/input.ini. */
export function resolveInstallDir(configuredPath?: string): string | null {
  for (const dir of candidateInstallPaths(configuredPath)) {
    try {
      if (fs.existsSync(path.join(dir, 'Config'))) return dir;
    } catch {
      /* next */
    }
  }
  return null;
}
