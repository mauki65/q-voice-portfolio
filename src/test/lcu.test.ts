import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBindTable,
  normalizeLeagueKey,
  parseInputIni,
  parseLcuInputSettings,
} from '../main/lcu/binds';
import { installPathFromProductSettings, parseLockfile, parseProcessCommandLine } from '../main/lcu/lockfile';
import { deriveLobbyRoom, deriveRoomName } from '../main/game/room';

// ---- credentials -----------------------------------------------------------

test('a lockfile is parsed into port and password', () => {
  const creds = parseLockfile('LeagueClient:22532:52847:PBnFPZ9vT2yQ:https\n');
  assert.deepEqual(creds, { port: 52847, password: 'PBnFPZ9vT2yQ' });
});

test('a truncated or empty lockfile yields null rather than a bad port', () => {
  assert.equal(parseLockfile(''), null);
  assert.equal(parseLockfile('LeagueClient:22532'), null);
  assert.equal(parseLockfile('LeagueClient:22532:notaport:pw:https'), null);
});

test('the install path is read out of Riot product settings', () => {
  const yaml = [
    'product_install_full_path: "D:\\\\Games\\\\Riot Games\\\\League of Legends"',
    'product_install_root: "D:\\\\Games\\\\Riot Games"',
  ].join('\n');
  assert.equal(installPathFromProductSettings(yaml), 'D:\\Games\\Riot Games\\League of Legends');
});

test('credentials can be recovered from the client command line', () => {
  const cmd =
    '"C:\\Riot Games\\League of Legends\\LeagueClientUx.exe" --riotclient-app-port=63177 ' +
    '--app-port=52847 --remoting-auth-token=PBnFPZ9vT2yQ --no-rads';
  assert.deepEqual(parseProcessCommandLine(cmd), { port: 52847, password: 'PBnFPZ9vT2yQ' });
  assert.equal(parseProcessCommandLine('LeagueClientUx.exe --no-rads'), null);
});

// ---- key mapping -----------------------------------------------------------

test('League key tokens map onto uiohook labels', () => {
  assert.equal(normalizeLeagueKey('[q]'), 'Q');
  assert.equal(normalizeLeagueKey('[Space]'), 'Space');
  assert.equal(normalizeLeagueKey('[Button 4]'), 'Mouse4');
  assert.equal(normalizeLeagueKey('[F5]'), 'F5');
  assert.equal(normalizeLeagueKey('[4]'), '4');
});

test('modifier combos and unbound entries are skipped, not guessed', () => {
  assert.equal(normalizeLeagueKey('[Shift][q]'), null, 'a single-key bind cannot collide with a combo');
  assert.equal(normalizeLeagueKey(''), null);
  assert.equal(normalizeLeagueKey('[SomeFutureKey]'), null, 'unknown tokens are dropped');
});

test('input.ini becomes a conflict table keyed by real key', () => {
  const ini = [
    '[GameEvents]',
    'evtCastSpell1=[a]',
    'evtCastSpell2=[s]',
    'evtPlayerAttackMove=[q],[x]',
    'evtCastSpell3=[Shift][e]',
    '[HUDEvents]',
    'evtOpenShop=[p]',
    '; a comment',
    'notAnEvent=[z]',
  ].join('\n');

  const table = parseInputIni(ini);
  // This player has rebound Q to attack-move and A to their first ability.
  assert.equal(table.A.leagueAction, 'Ability 1');
  assert.equal(table.Q.leagueAction, 'Attack Move');
  assert.equal(table.X.leagueAction, 'Attack Move', 'both bindings of one event count');
  assert.equal(table.P.leagueAction, 'Open Shop');
  assert.equal(table.E, undefined, 'a modifier combo does not occupy the plain key');
  assert.equal(table.Z, undefined, 'non-evt lines are ignored');
});

test('a rebound keymap frees keys the stock table would have flagged', () => {
  // The point of reading real binds: this player moved everything off WASD-side
  // keys, so W is free for push-to-talk even though it is a stock ability key.
  const table = parseInputIni(['evtCastSpell1=[y]', 'evtCastSpell2=[u]'].join('\n'));
  assert.equal(table.W, undefined);
  assert.equal(table.Y.leagueAction, 'Ability 1');
});

test('the LCU payload is walked for evt leaves at any depth', () => {
  const payload = {
    GameEvents: { evtCastSpell1: '[q]' },
    nested: { deeper: { HUDEvents: { evtOpenShop: '[p]' } } },
    unrelated: 42,
  };
  const table = parseLcuInputSettings(payload);
  assert.equal(table.Q.leagueAction, 'Ability 1');
  assert.equal(table.P.leagueAction, 'Open Shop');
});

test('an unrecognised LCU shape yields an empty table so the caller falls back', () => {
  assert.deepEqual(parseLcuInputSettings({ something: { else: true } }), {});
  assert.deepEqual(parseLcuInputSettings(null), {});
});

test('unknown events are ignored rather than reported as unnamed conflicts', () => {
  const table = buildBindTable([['SomeNewEventRiotAdded', '[k]']]);
  assert.deepEqual(table, {});
});

// ---- lobby room ------------------------------------------------------------

test('the lobby room is stable for one chat id and differs between lobbies', () => {
  const a = deriveLobbyRoom('c1a2b3d4@champ-select.eu1.pvp.net');
  assert.equal(a, deriveLobbyRoom('c1a2b3d4@champ-select.eu1.pvp.net'));
  assert.notEqual(a, deriveLobbyRoom('deadbeef@champ-select.eu1.pvp.net'));
  assert.match(a, /^L[0-9A-F]{12}$/);
});


