# Q-Voice

> **Status: discontinued (September 2026).** Built solo by [Felix Grohs](mailto:felix.grohs@gmail.com)
> in 2026 with AI coding assistants. I owned the product, the specifications, the
> architecture decisions and the testing, and shipped it in six sequential milestones:
> app shell and settings → global push-to-talk → live game detection → champ select
> integration → LiveKit voice → overlay. In live tests about **50% of invited
> teammates clicked the room link and joined**. I stopped before launch when Riot
> Games announced native in-game voice chat.
>
> This repository is published as a portfolio piece. Credentials and deployment
> configuration have been removed.

**What it does:** one-click voice rooms for strangers in a ranked match. The
desktop app detects the lobby, posts a room link once to team chat, and teammates
join from the browser with no account. App users get a passive global
push-to-talk hook, a click-through overlay showing who is speaking, and
auto-connect to the right room.

Voice for League of Legends Solo Queue. Two deployables in one repo:

- **the desktop app** (`src/`) — Electron, Windows only, NSIS installer
- **the token server + web client** (`server/`) — Express; `server/public/` is the
  browser client it serves

## Run

```
npm install              # DESKTOP APP - must be run on Windows, see below
npm run dev              # build and launch the app
npm test                 # PTT, room, LCU, overlay unit tests
npm run dist             # NSIS installer into release/
npm run verify:native    # AFTER dist - checks the .node actually shipped

cd server
npm install
npm run dev              # token server on :8080, serves the web client
npm test                 # server + web-client tests
```

`npm install` for the desktop app **must run on Windows**. Electron's postinstall
downloads a platform-specific binary, so installing from a Linux shell puts a
Linux Electron into `node_modules` and the app will not start. The server has no
native dependencies and installs anywhere.

Newer npm blocks install scripts by default and prints
`npm warn allow-scripts`. When that hits Electron, the package is installed but
its binary never is, every later `npm install` says "up to date", and the only
symptom is Electron failing to start. `postinstall` detects this and prints the
fix:

```
node node_modules/electron/install.js
```

Do **not** approve `uiohook-napi`'s install script - it is `node-gyp rebuild`,
which throws away a working prebuilt binary and demands an MSVC toolchain. See
the native-module note below.

`npm test` reports a file-level failure for `ptt.test.js` on Linux even when all
its subtests pass: libuiohook's X11 init makes the process exit non-zero there.
On Windows it exits clean.

## Configuration

Server, via env (see `server/.env.example`):

| Variable | Meaning |
| --- | --- |
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | required |
| `RIOT_API_KEY` | **optional**. Without it, web rooms work and League rooms are refused |
| `MAX_SEATS` | people per room, default 5, `0` disables |
| `PORT` | default 8080 |
| `QVOICE_DEV_BYPASS_VERIFICATION` | development only, see below |

App settings live in `%APPDATA%/Q-Voice/settings.json` and are all editable in
the UI. The token server URL is in the Diagnostics disclosure; point it at
`http://localhost:8080` to test against a local server.

## Room names

The kind is readable from the name, so the server routes on it without trusting
the caller:

| Prefix | Kind | Access control |
| --- | --- | --- |
| `R` + 12 hex | roster, derived from the ally Riot IDs | Spectator API verification, always |
| `L` + 12 hex | lobby, derived from the champ select chat id | its mapped roster room, else link possession |
| `X` + 20 base32 | random, web-originated | possession of the link, 100 bits |

The full derivation contract is at the top of `src/main/game/room.ts`. It is
implemented three times - desktop, server, browser - and all three suites assert
the golden vector `RE3B5CE843C35`. If they drift the tests go red instead of
players silently landing in different rooms.

**The random path touches no Riot API at all.** `server/test/webpath.test.ts`
proves it end to end with a config whose `riotApiKey` getter throws and a Riot
client that throws on every call. That is what lets the web client launch before
a production key exists.

### Known limitation: lobby rooms before a mapping

Between the link being posted in champ select and the first ally publishing a
lobby-to-roster mapping, a lobby room is protected only by possession of the
link. The Spectator API has no live game to look up during champ select, so the
alternative is refusing every token until the game starts, which would remove
champ select voice. A streamed champ select therefore exposes the link for the
whole match. Mitigations, neither a fix: turn off auto-post and share the link
deliberately, and the participant list makes an unexpected name visible. Full
reasoning in the routing header of `server/src/index.ts`.

## Decisions worth knowing

**electron-store is pinned to 8.2.0.** v9+ is ESM-only; keeping the main process
CommonJS avoids `"type": "module"`, ESM preload handling and a bundler.

**No forced native rebuild.** `uiohook-napi` ships N-API prebuilds, which are
ABI-stable across Node and Electron. `electron-rebuild -f` would discard a
working prebuild and demand an MSVC toolchain. `postinstall` verifies the binary
instead; `npm run rebuild:native` is the escape hatch.

**Not `globalShortcut`.** It is keydown-only and registers the key exclusively,
swallowing the press before League sees it. libuiohook observes without
consuming.

**Anti-cheat.** Vanguard is kernel-level, required to launch League, and active
in every queue including Solo Queue. Push-to-talk was verified working with it
live. The hook never touches the game: no injection, no memory reads, no
handles, no simulated input. Keep it that way.

**No lock keys as bindings.** CapsLock, NumLock and ScrollLock are refused - the
hook is passive, so the key still reaches Windows. Binding order is Mouse5, then
Mouse4, then `L`.

**Conflict warnings use the player's real keymap**, read from the LCU, then
`Config/input.ini`, then the stock table. The UI says which source it used.

**Riot Sign-On is not assumed.** `server/src/verify.ts` carries an
`IdentityAssertion` seam that is always `self-asserted` today. Nothing depends
on RSO being granted.

**The seat cap is server-side.** A room link is pasted into chat and is
therefore public, so the browser cannot be the thing that counts seats.

**`GET /` hands out a fresh room.** One room per team: open lolvoice at the
start of champ select and you get a link to paste.

## Layout

```
src/main/index.ts           app lifecycle, single-instance lock, permissions
src/main/ipc.ts             every IPC handler, app status, room reconciliation
src/main/logger.ts          ring buffer + rolling log file in userData
src/main/net/loopback.ts    host-scoped TLS for Riot's loopback services
src/main/ptt/               passive global push-to-talk, bind tables
src/main/game/              live client polling, room names, mapping client
src/main/lcu/               lockfile, LCU client, real keybinds
src/main/overlay/           transparent click-through overlay window
src/renderer/               app UI and overlay UI (no framework, no bundler)
server/src/                 token server: verification, mapping, routing
server/public/              the web client
```

## Diagnostics

There is no terminal once the packaged build is installed. Every PTT, game,
LCU and voice event goes to a 50-entry ring shown in the collapsed
**Diagnostics** disclosure and to `%APPDATA%/Q-Voice/logs/q-voice.log`
(1 MB, one rotation). "Open log folder" is inside the disclosure.
