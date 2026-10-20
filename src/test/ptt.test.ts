import test from 'node:test';
import type { Binding } from '../shared/types';
import assert from 'node:assert/strict';
import { PttService, RELEASE_TAIL_MS } from '../main/ptt/service';
import { checkBinding, checkConflict, DEFAULT_BINDING, FALLBACK_BINDING } from '../main/ptt/bindings';

/** Resolve a uiohook key name to its code, for conflict-table assertions. */
function keyCode(name: string): number {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { UiohookKey } = require('uiohook-napi') as { UiohookKey: Record<string, number> };
  return UiohookKey[name];
}

/** Literal so the state-machine tests do not need the native key table. */
const CAPS: Binding = { kind: 'key', code: 58, label: 'CapsLock' };

/** Drives the service without the native hook by invoking its input handlers. */
function harness() {
  const svc = new PttService();
  const states: boolean[] = [];
  svc.on('state', (t: boolean) => states.push(t));
  const raw = svc as unknown as {
    onKeyDown(code: number): void;
    onKeyUp(code: number): void;
    onMouseDown(button: number): void;
    onMouseUp(button: number): void;
  };
  return { svc, states, raw };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('a side-button press transmits, release stops after the tail', async () => {
  const { svc, states, raw } = harness();
  svc.setBinding(DEFAULT_BINDING);
  raw.onMouseDown(DEFAULT_BINDING.code);
  assert.equal(svc.isTransmitting(), true);
  raw.onMouseUp(DEFAULT_BINDING.code);
  assert.equal(svc.isTransmitting(), true, 'still open during the release tail');
  await sleep(RELEASE_TAIL_MS + 60);
  assert.equal(svc.isTransmitting(), false);
  assert.deepEqual(states, [true, false]);
  svc.stop();
});

test('key auto-repeat does not spam state changes', async () => {
  const { svc, states, raw } = harness();
  const caps = CAPS;
  svc.setBinding(caps);
  for (let i = 0; i < 25; i++) raw.onKeyDown(caps.code);
  raw.onKeyUp(caps.code);
  await sleep(RELEASE_TAIL_MS + 60);
  assert.deepEqual(states, [true, false], 'exactly one on and one off');
  svc.stop();
});

test('re-press inside the tail keeps the mic open continuously', async () => {
  const { svc, states, raw } = harness();
  svc.setBinding(DEFAULT_BINDING);
  raw.onMouseDown(DEFAULT_BINDING.code);
  raw.onMouseUp(DEFAULT_BINDING.code);
  await sleep(RELEASE_TAIL_MS / 2);
  raw.onMouseDown(DEFAULT_BINDING.code);
  await sleep(RELEASE_TAIL_MS + 60);
  assert.equal(svc.isTransmitting(), true);
  assert.deepEqual(states, [true], 'no flap');
  svc.stop();
});

test('unbound inputs are ignored', () => {
  const { svc, states, raw } = harness();
  svc.setBinding(DEFAULT_BINDING);
  raw.onMouseDown(FALLBACK_BINDING.code);
  raw.onKeyDown(58);
  assert.deepEqual(states, []);
  svc.stop();
});

test('disabling push-to-talk opens the mic', () => {
  const { svc, states } = harness();
  svc.setPttEnabled(false);
  assert.equal(svc.isTransmitting(), true);
  assert.deepEqual(states, [true]);
  svc.stop();
});

test('League default binds are flagged', () => {
  assert.equal(checkConflict(DEFAULT_BINDING), null, 'side buttons are free');
  assert.equal(checkConflict(FALLBACK_BINDING), null, 'the other side button is free');
  const space = checkConflict({ kind: 'key', code: 57, label: '' });
  assert.ok(space && /Center Camera/.test(space.leagueAction));
});

test('V is a conflict — it arms the Caution Ping cursor', () => {
  const v = checkConflict({ kind: 'key', code: keyCode('V'), label: '' });
  assert.ok(v, 'V must not be treated as free');
  assert.match(v.leagueAction, /Caution Ping/);
  assert.equal(v.severity, 'high');
});

test('the three unbound letters really are free', () => {
  for (const name of ['I', 'K', 'L']) {
    assert.equal(checkConflict({ kind: 'key', code: keyCode(name), label: '' }), null, name);
  }
});

test('digit 4 is the trinket, not item slot 4', () => {
  const four = checkConflict({ kind: 'key', code: keyCode('4'), label: '' });
  assert.ok(four);
  assert.match(four.leagueAction, /Trinket/);
});

test('numpad keys are not mistaken for the number row', () => {
  // League leaves the numpad alone; an earlier version mapped Numpad4 onto "4".
  assert.equal(checkConflict({ kind: 'key', code: keyCode('Numpad4'), label: '' }), null);
});

test('lock keys are refused outright', () => {
  const caps = checkBinding(CAPS);
  assert.ok(caps.rejected, 'CapsLock must be rejected, not merely warned about');
  assert.match(caps.rejected as string, /toggles caps/i);
  assert.equal(caps.conflict, null, 'a rejected bind needs no conflict detail');

  assert.equal(checkBinding(DEFAULT_BINDING).rejected, null);
  assert.equal(checkBinding(FALLBACK_BINDING).rejected, null);
});
