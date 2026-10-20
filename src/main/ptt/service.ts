import { EventEmitter } from 'node:events';
import type { Binding } from '../../shared/types';
import { bindingLabel, DEFAULT_BINDING, sameBinding } from './bindings';

/**
 * Passive global push-to-talk.
 *
 * Why not Electron globalShortcut: it is keydown-only (no keyup, so hold-to-talk
 * is inexpressible) and it registers the accelerator exclusively, swallowing the
 * press before League sees it.
 *
 * uiohook-napi wraps libuiohook, which on Windows installs a WH_KEYBOARD_LL /
 * WH_MOUSE_LL hook and *observes* without consuming. Events keep flowing to the
 * foreground window, so League still gets the key. That also means a binding on
 * a key League uses will fire both actions — see bindings.checkConflict.
 *
 * Anti-cheat: Vanguard is kernel-level, is required to launch League, and is
 * active in every queue including Solo Queue — it is running whenever this hook
 * matters. Push-to-talk was verified working with Vanguard live in a real game.
 * The reason a passive OS-level input hook is compatible is that it never
 * touches the game: no injection into the League process, no memory reads, no
 * handles to it, no simulated input. Keep it that way — anything that reaches
 * into the game process is both a policy violation and a ban risk for users.
 */

/** Keep the mic open this long after release so the last syllable is not clipped. */
export const RELEASE_TAIL_MS = 200;
/** Ignore input this long after capture starts, so the click that opened the picker is not captured. */
const CAPTURE_GRACE_MS = 250;

type HookModule = {
  uIOhook: {
    on(event: string, cb: (e: any) => void): void;
    removeAllListeners(event?: string): void;
    start(): void;
    stop(): void;
  };
};

export interface PttEvents {
  state: (transmitting: boolean) => void;
  captured: (binding: Binding) => void;
  hook: (running: boolean, error: string | null) => void;
}

export class PttService extends EventEmitter {
  private hook: HookModule['uIOhook'] | null = null;
  private running = false;
  private hookError: string | null = null;

  private binding: Binding = DEFAULT_BINDING;
  private pttEnabled = true;

  private held = false;
  private transmitting = false;
  private releaseTimer: NodeJS.Timeout | null = null;

  private capturing = false;
  private captureStartedAt = 0;

  // ---- lifecycle -----------------------------------------------------------

  start(): void {
    if (this.running) return;
    try {
      // Required lazily: a missing/mismatched .node must not take down the app.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require('uiohook-napi') as HookModule;
      this.hook = mod.uIOhook;
      this.hook.on('keydown', (e) => this.onKeyDown(Number(e.keycode)));
      this.hook.on('keyup', (e) => this.onKeyUp(Number(e.keycode)));
      this.hook.on('mousedown', (e) => this.onMouseDown(Number(e.button)));
      this.hook.on('mouseup', (e) => this.onMouseUp(Number(e.button)));
      this.hook.start();
      this.running = true;
      this.hookError = null;
      this.log(`hook started, binding=${bindingLabel(this.binding)} pttEnabled=${this.pttEnabled}`);
    } catch (err) {
      this.running = false;
      this.hookError = err instanceof Error ? err.message : String(err);
      this.log(`hook FAILED to start: ${this.hookError}`);
    }
    this.emit('hook', this.running, this.hookError);
    // Open mic mode does not need the hook at all.
    this.recompute();
  }

  stop(): void {
    if (this.releaseTimer) clearTimeout(this.releaseTimer);
    this.releaseTimer = null;
    if (this.hook && this.running) {
      try {
        this.hook.removeAllListeners();
        this.hook.stop();
      } catch {
        /* shutting down anyway */
      }
    }
    this.running = false;
    this.hook = null;
  }

  isRunning(): boolean {
    return this.running;
  }

  getError(): string | null {
    return this.hookError;
  }

  // ---- configuration -------------------------------------------------------

  setBinding(binding: Binding): void {
    if (sameBinding(this.binding, binding)) return;
    this.binding = binding;
    this.held = false;
    this.log(`binding set to ${bindingLabel(binding)}`);
    this.recompute();
  }

  setPttEnabled(enabled: boolean): void {
    if (this.pttEnabled === enabled) return;
    this.pttEnabled = enabled;
    this.held = false;
    this.log(enabled ? 'push-to-talk on' : 'push-to-talk off (open mic)');
    this.recompute();
  }

  // ---- keybind capture -----------------------------------------------------

  beginCapture(): void {
    this.capturing = true;
    this.captureStartedAt = Date.now();
    this.held = false;
    this.recompute();
    this.log('capturing next input for keybind…');
  }

  cancelCapture(): void {
    if (!this.capturing) return;
    this.capturing = false;
    this.log('keybind capture cancelled');
  }

  isCapturing(): boolean {
    return this.capturing;
  }

  private tryCapture(binding: Binding): boolean {
    if (!this.capturing) return false;
    if (Date.now() - this.captureStartedAt < CAPTURE_GRACE_MS) return true; // swallow, still capturing
    // Left click is how the user operates the picker; never capture it.
    if (binding.kind === 'mouse' && binding.code === 1) return true;
    this.capturing = false;
    this.log(`captured ${bindingLabel(binding)}`);
    this.emit('captured', binding);
    return true;
  }

  // ---- input handling ------------------------------------------------------

  private onKeyDown(code: number): void {
    // Observers (the overlay's drag modifier) see every key; the push-to-talk
    // state machine below is untouched by them.
    this.emit('rawKey', code, true);
    if (this.tryCapture({ kind: 'key', code, label: '' })) return;
    if (this.binding.kind !== 'key' || this.binding.code !== code) return;
    this.press();
  }

  private onKeyUp(code: number): void {
    this.emit('rawKey', code, false);
    if (this.capturing) return;
    if (this.binding.kind !== 'key' || this.binding.code !== code) return;
    this.release();
  }

  private onMouseDown(button: number): void {
    // Report side-button presence so the first-run picker can offer a fallback
    // when the user's mouse has none. There is no way to enumerate this passively.
    if (button === 4 || button === 5) this.emit('sideButton', button);
    if (this.tryCapture({ kind: 'mouse', code: button, label: '' })) return;
    if (this.binding.kind !== 'mouse' || this.binding.code !== button) return;
    this.press();
  }

  private onMouseUp(button: number): void {
    if (this.capturing) return;
    if (this.binding.kind !== 'mouse' || this.binding.code !== button) return;
    this.release();
  }

  /** Held-key auto-repeat sends keydown over and over; collapse it to one press. */
  private press(): void {
    if (this.held) return;
    this.held = true;
    if (this.releaseTimer) {
      clearTimeout(this.releaseTimer);
      this.releaseTimer = null;
    }
    this.recompute();
  }

  private release(): void {
    if (!this.held) return;
    this.held = false;
    if (this.releaseTimer) clearTimeout(this.releaseTimer);
    this.releaseTimer = setTimeout(() => {
      this.releaseTimer = null;
      this.recompute();
    }, RELEASE_TAIL_MS);
  }

  // ---- mic state -----------------------------------------------------------

  /** Desired transmit state given mode, hold state and the pending release tail. */
  private desired(): boolean {
    if (!this.pttEnabled) return true; // open mic
    if (this.capturing) return false; // do not transmit while rebinding
    return this.held || this.releaseTimer !== null;
  }

  private recompute(): void {
    const next = this.desired();
    if (next === this.transmitting) return;
    if (next) this.enableMic();
    else this.disableMic();
  }

  /** Public so this milestone is testable before LiveKit exists. */
  enableMic(): void {
    this.transmitting = true;
    this.log('MIC ON');
    this.emit('state', true);
  }

  disableMic(): void {
    this.transmitting = false;
    this.log('MIC OFF');
    this.emit('state', false);
  }

  isTransmitting(): boolean {
    return this.transmitting;
  }

  /** Emitted as well as printed, so the packaged build has a visible log. */
  private log(message: string): void {
    this.emit('log', message);
  }
}

export const ptt = new PttService();
