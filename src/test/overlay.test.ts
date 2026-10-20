import test from 'node:test';
import assert from 'node:assert/strict';
import {
  overlayCanRender,
  parseGameCfg,
  parseLcuGameSettings,
} from '../main/game/windowmode';

test('game.cfg window modes are read', () => {
  const cfg = ['[General]', 'WindowMode=1', 'Colour=1'].join('\n');
  assert.equal(parseGameCfg(cfg), 'borderless');
  assert.equal(parseGameCfg('[General]\nWindowMode=0'), 'windowed');
  assert.equal(parseGameCfg('[General]\nWindowMode=2'), 'fullscreen');
});

test('an absent or unrecognised window mode is unknown, not a guess', () => {
  assert.equal(parseGameCfg('[General]\nColour=1'), 'unknown');
  assert.equal(parseGameCfg(''), 'unknown');
  assert.equal(parseGameCfg('[General]\nWindowMode=7'), 'unknown', 'if Riot adds a mode');
});

test('the LCU payload is walked for a WindowMode leaf', () => {
  assert.equal(parseLcuGameSettings({ General: { WindowMode: 2 } }), 'fullscreen');
  assert.equal(parseLcuGameSettings({ a: { b: { General: { WindowMode: '1' } } } }), 'borderless');
  assert.equal(parseLcuGameSettings({ nothing: true }), 'unknown');
  assert.equal(parseLcuGameSettings(null), 'unknown');
});

test('only exclusive fullscreen blocks the overlay', () => {
  assert.equal(overlayCanRender('borderless'), true);
  assert.equal(overlayCanRender('windowed'), true);
  assert.equal(overlayCanRender('fullscreen'), false);
});

test('an unknown mode does NOT block the overlay', () => {
  // Fail open: warning a Borderless player that their overlay will not work is
  // worse than staying quiet when we genuinely cannot tell.
  assert.equal(overlayCanRender('unknown'), true);
});
