import { app, shell } from 'electron';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import type { LogEntry } from '../shared/types';

/**
 * Once the packaged build is installed there is no terminal, so this is the only
 * way to see whether the hook is firing. Everything worth diagnosing goes both
 * to an in-memory ring (shown in the Diagnostics disclosure) and to a rolling
 * file in userData.
 */

const MAX_BYTES = 1_000_000; // 1 MB, then one rotation
const RING_SIZE = 50;

class Logger extends EventEmitter {
  private ring: LogEntry[] = [];
  private dir: string | null = null;
  private file: string | null = null;
  private bytes = 0;
  private ready = false;

  /** Must run after app 'ready' — userData is not resolvable before that. */
  init(): void {
    if (this.ready) return;
    try {
      this.dir = path.join(app.getPath('userData'), 'logs');
      fs.mkdirSync(this.dir, { recursive: true });
      this.file = path.join(this.dir, 'q-voice.log');
      this.bytes = fs.existsSync(this.file) ? fs.statSync(this.file).size : 0;
      this.ready = true;
      this.append('app', `log file: ${this.file}`);
    } catch (err) {
      // Logging must never take the app down.
      console.error('[logger] could not open log file:', err);
    }
  }

  append(scope: string, message: string): void {
    const entry: LogEntry = { at: new Date().toISOString(), scope, message };
    this.ring.push(entry);
    if (this.ring.length > RING_SIZE) this.ring.shift();

    console.log(`[${scope} ${entry.at.slice(11, 23)}] ${message}`);
    this.emit('entry', entry);
    this.write(`${entry.at} [${scope}] ${message}\n`);
  }

  private write(line: string): void {
    if (!this.ready || !this.file) return;
    try {
      if (this.bytes + line.length > MAX_BYTES) {
        fs.renameSync(this.file, `${this.file}.1`); // single rotation, old .1 replaced
        this.bytes = 0;
      }
      fs.appendFileSync(this.file, line);
      this.bytes += Buffer.byteLength(line);
    } catch {
      this.ready = false; // stop trying; the ring buffer still works
    }
  }

  recent(): LogEntry[] {
    return [...this.ring];
  }

  logDir(): string | null {
    return this.dir;
  }

  async openFolder(): Promise<void> {
    if (this.dir) await shell.openPath(this.dir);
  }
}

export const logger = new Logger();
