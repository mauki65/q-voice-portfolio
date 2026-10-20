import type {
  AppStatus,
  ConnectionState,
  Binding,
  BindCheck,
  LogEntry,
  Participant,
  Settings,
  SettingsKey,
} from '../shared/types';

declare global {
  interface Window {
    qvoice: {
      settings: {
        getAll(): Promise<Settings>;
        set(key: SettingsKey, value: unknown): Promise<Settings>;
        onChanged(cb: (s: Settings) => void): () => void;
      };
      status: {
        get(): Promise<AppStatus>;
        setMuted(muted: boolean): Promise<AppStatus>;
        onChanged(cb: (s: AppStatus) => void): () => void;
      };
      ptt: {
        getState(): Promise<boolean>;
        onState(cb: (t: boolean) => void): () => void;
        beginCapture(): Promise<void>;
        cancelCapture(): Promise<void>;
        onCaptured(cb: (b: Binding) => void): () => void;
        onSideButton(cb: (button: number) => void): () => void;
        checkBinding(b: Binding): Promise<BindCheck>;
      };
      game: { join(): Promise<AppStatus> };
      voice: {
        token(roomName: string): Promise<TokenResult>;
        setConnection(state: ConnectionState, detail?: string): Promise<AppStatus>;
        manualRoom(link: string): Promise<{ ok: boolean; reason?: string; roomName?: string }>;
      };
      overlay: { refreshWindowMode(): Promise<AppStatus> };
      diagnostics: {
        recent(): Promise<LogEntry[]>;
        onEntry(cb: (e: LogEntry) => void): () => void;
        openFolder(): void;
      };
      window: { hideToTray(): void; quit(): void };
      log(message: string): void;
    };
  }
}

/** Same host as the web client, so a link copied here opens the browser room. */
const ROOM_BASE = 'https://lolvoice.gg/';

type TokenResult = { ok: true; token: string; wsUrl: string; members: string[] } | { ok: false; reason: string };

/**
 * livekit-client is loaded as a UMD global from a file copied next to this one:
 * the renderer has no bundler and the page's CSP is script-src 'self'. The
 * `import type` below is erased at compile time, so this stays a type-only
 * dependency at runtime while still being fully typed here.
 */
declare const LivekitClient: typeof import('livekit-client');

const api = window.qvoice;
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const show = (el: HTMLElement, visible: boolean): void => {
  el.classList.toggle('hidden', !visible);
};

let settings: Settings;
let status: AppStatus;
let transmitting = false;

/**
 * The renderer keeps no log of its own; everything goes to the main process,
 * which owns the ring buffer and the rolling file, and comes back through
 * log:entry. That way the Diagnostics list and the log file can never disagree.
 */
function log(message: string): void {
  api.log(message);
}

const DIAG_LINES = 50;
const diagEntries: LogEntry[] = [];

function renderDiag(): void {
  const el = $('diagLog');
  el.textContent = diagEntries
    .map((e) => `${e.at.slice(11, 19)}  ${e.scope.padEnd(4)}  ${e.message}`)
    .join('\n');
  el.scrollTop = el.scrollHeight; // newest last, keep it in view
}

function pushDiag(entry: LogEntry): void {
  diagEntries.push(entry);
  while (diagEntries.length > DIAG_LINES) diagEntries.shift();
  if ($<HTMLDetailsElement>('diag').open) renderDiag();
}

// ------------------------------------------------------------ audio chain ---

/**
 * Voice.
 *
 * One local audio track, created through LiveKit whether or not a room is
 * connected, so the level meter and push-to-talk stay testable offline and the
 * publish path has nothing special about it.
 *
 * Push-to-talk drives mute/unmute rather than track.enabled: mute is signalled
 * to the other participants, so their UI can show that you are not transmitting
 * instead of guessing from silence.
 */
let room: import('livekit-client').Room | null = null;
let localTrack: import('livekit-client').LocalAudioTrack | null = null;
let audioCtx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let meterRaf = 0;
let micError: string | null = null;
let connecting = false;
/** identity -> live voice state, overlaid onto the roster from the main process. */
let voiceState = new Map<string, { inVoice: boolean; speaking: boolean }>();

function audioConstraints(): MediaTrackConstraints {
  return {
    deviceId:
      settings.inputDeviceId && settings.inputDeviceId !== 'default'
        ? { exact: settings.inputDeviceId }
        : undefined,
    noiseSuppression: settings.noiseSuppressionEnabled,
    echoCancellation: settings.noiseSuppressionEnabled,
    autoGainControl: true,
  };
}

/** Should the microphone be transmitting right now? */
function shouldTransmit(): boolean {
  if (status.muted) return false;
  return settings.pttEnabled ? transmitting : true; // open mic stays live
}

function applyTrackState(): void {
  if (!localTrack) return;
  const send = shouldTransmit();
  // LiveKit's mute is async; the calls are idempotent so overlapping ones settle.
  void (send ? localTrack.unmute() : localTrack.mute());
}

function describeMicError(err: unknown): string {
  const name = (err as { name?: string })?.name ?? '';
  if (name === 'NotAllowedError') return 'Microphone access is blocked for Q-Voice.';
  if (name === 'NotFoundError') return 'No microphone found.';
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    // The common one: League Voice, Discord or OBS holding the device exclusively.
    return 'Another application is using the microphone. Close it, or pick a different device.';
  }
  if (name === 'OverconstrainedError') return 'That microphone is no longer available.';
  return err instanceof Error ? err.message : String(err);
}

async function ensureLocalTrack(): Promise<void> {
  try {
    if (localTrack) {
      // Applies a device change or a noise-suppression toggle to the live track,
      // including one already published to a room.
      await localTrack.restartTrack(audioConstraints());
    } else {
      localTrack = await LivekitClient.createLocalAudioTrack(audioConstraints());
      await localTrack.mute(); // never transmit before applyTrackState decides
    }
    micError = null;
    show($('grantBtn'), false);
    applyTrackState();
    startMeter();
    await populateDevices();
    log(`mic ready (device=${settings.inputDeviceId}, noiseSuppression=${settings.noiseSuppressionEnabled})`);
  } catch (err) {
    micError = describeMicError(err);
    stopMeter();
    show($('grantBtn'), true);
    await populateDevices(); // never leave the picker empty; switching may fix it
    log(`mic unavailable: ${micError}`);
  }
  renderMic();
}

function stopMeter(): void {
  if (meterRaf) cancelAnimationFrame(meterRaf);
  meterRaf = 0;
  analyser = null;
  $<HTMLDivElement>('meterFill').style.width = '0';
}

function startMeter(): void {
  stopMeter();
  const source = localTrack?.mediaStreamTrack;
  if (!source) return;
  audioCtx = audioCtx ?? new AudioContext();
  void audioCtx.resume();
  const node = audioCtx.createMediaStreamSource(new MediaStream([source]));
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  node.connect(analyser);
  const buf = new Uint8Array(analyser.frequencyBinCount);
  const fill = $<HTMLDivElement>('meterFill');

  const tick = (): void => {
    if (!analyser) return;
    analyser.getByteTimeDomainData(buf);
    let peak = 0;
    for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
    const sending = localTrack ? !localTrack.isMuted : false;
    fill.style.width = `${sending ? Math.min(100, (peak / 90) * 100) : 0}%`;
    meterRaf = requestAnimationFrame(tick);
  };
  tick();
}

async function populateDevices(): Promise<void> {
  const select = $<HTMLSelectElement>('deviceSelect');
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter(
    (d) => d.kind === 'audioinput'
  );
  select.innerHTML = '';
  const def = document.createElement('option');
  def.value = 'default';
  def.textContent = 'System default';
  select.append(def);
  for (const device of devices) {
    if (device.deviceId === 'default') continue;
    const option = document.createElement('option');
    option.value = device.deviceId;
    option.textContent = device.label || `Microphone ${select.length}`;
    select.append(option);
  }
  const known = devices.some((d) => d.deviceId === settings.inputDeviceId);
  if (!known && settings.inputDeviceId !== 'default') {
    // The chosen device was unplugged. Fall back rather than failing forever.
    log(`input device ${settings.inputDeviceId} is gone; falling back to the system default`);
    await set('inputDeviceId', 'default');
  }
  select.value = known ? settings.inputDeviceId : 'default';
}

// ---- room ------------------------------------------------------------------

function refreshVoiceState(): void {
  voiceState = new Map();
  if (room) {
    const speaking = new Set(room.activeSpeakers.map((p) => p.identity));
    for (const p of [room.localParticipant, ...room.remoteParticipants.values()]) {
      voiceState.set(p.identity, { inVoice: true, speaking: speaking.has(p.identity) });
    }
  }
  renderPeople();
}

async function connectVoice(): Promise<void> {
  if (room || connecting || !status.roomName || !status.joinRequested) return;
  connecting = true;
  await api.voice.setConnection('connecting');

  const grant = await api.voice.token(status.roomName);
  if (!grant.ok) {
    connecting = false;
    await api.voice.setConnection('error', `token refused: ${grant.reason}`);
    return;
  }

  const next = new LivekitClient.Room({ adaptiveStream: false, dynacast: false });
  const { RoomEvent } = LivekitClient;

  next.on(RoomEvent.TrackSubscribed, (track) => {
    if (track.kind === 'audio') $('audioSink').appendChild(track.attach());
  });
  next.on(RoomEvent.TrackUnsubscribed, (track) => track.detach().forEach((el) => el.remove()));
  next.on(RoomEvent.ActiveSpeakersChanged, refreshVoiceState);
  next.on(RoomEvent.ParticipantConnected, refreshVoiceState);
  next.on(RoomEvent.ParticipantDisconnected, refreshVoiceState);
  next.on(RoomEvent.Reconnecting, () => void api.voice.setConnection('connecting', 'reconnecting'));
  next.on(RoomEvent.Reconnected, () => {
    void api.voice.setConnection('connected', 'reconnected');
    // The published track survives a reconnect, but the mute state is worth
    // reasserting: a keyup during the outage would otherwise be lost.
    applyTrackState();
    refreshVoiceState();
  });
  next.on(RoomEvent.Disconnected, () => {
    room = null;
    voiceState = new Map();
    void api.voice.setConnection('disconnected', 'left the room');
    renderPeople();
  });
  next.on(RoomEvent.MediaDevicesError, (err) => log(`livekit device error: ${describeMicError(err)}`));

  try {
    await next.connect(grant.wsUrl, grant.token);
    await next.startAudio();
    await ensureLocalTrack();
    if (localTrack) {
      // Create-and-mute before publish. Publishing first and muting a moment
      // later races the server's acknowledgement and the first unmute is
      // dropped, which looks exactly like a broken microphone.
      await next.localParticipant.publishTrack(localTrack, {
        source: LivekitClient.Track.Source.Microphone,
        dtx: true,
        red: true,
      });
      applyTrackState();
    }
    room = next;
    await api.voice.setConnection('connected', `joined ${status.roomName}`);
    refreshVoiceState();
  } catch (err) {
    await next.disconnect().catch(() => undefined);
    await api.voice.setConnection('error', `could not join: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    connecting = false;
  }
}

async function disconnectVoice(): Promise<void> {
  const current = room;
  room = null;
  voiceState = new Map();
  if (current) await current.disconnect().catch(() => undefined);
}

/** Called whenever the room or the join intent changes. */
function reconcileVoice(): void {
  const wanted = status.joinRequested && status.roomName;
  if (!wanted) {
    if (room) void disconnectVoice();
    return;
  }
  if (room && room.name !== status.roomName) {
    // The room moved under us (mapping resolved, or a manual link).
    void disconnectVoice().then(connectVoice);
    return;
  }
  if (!room) void connectVoice();
}

// -------------------------------------------------------------- rendering ---

function roomUrl(): string | null {
  return status.roomName ? ROOM_BASE + status.roomName : null;
}

function renderRoom(): void {
  const url = roomUrl();
  const link = $('roomLink');
  link.textContent = url ?? 'No room yet — joins when a game starts';
  link.classList.toggle('empty', !url);
  $<HTMLButtonElement>('copyBtn').disabled = !url;
  // Auto-connect off: the game is detected but nothing happens until Join.
  show($('joinBtn'), Boolean(status.inGame && status.roomName && !status.joinRequested));

  // Starting mid-game with no mapping means we would be alone in the roster
  // room. Never let that be silent — say it, and offer the manual path.
  const stranded = status.roomLookupFailed;
  if (stranded) {
    $('lookupWarn').textContent =
      `Couldn't find your team's voice room — ${status.roomLookupReason ?? 'unknown reason'}. ` +
      `You're in a room of your own. Ask a teammate for their link and paste it below.`;
  }
  show($('lookupWarn'), stranded);
  show($('manualJoin'), stranded);

  // The overlay cannot composite over exclusive fullscreen. Say so rather than
  // drawing nothing and leaving the user to wonder.
  const overlayBlocked = settings.overlayEnabled && status.windowMode === 'fullscreen';
  if (overlayBlocked) {
    $('overlayWarn').textContent =
      'The overlay cannot draw over exclusive fullscreen. Set League to Borderless in ' +
      'Settings → Video, then press Re-check.';
  }
  show($('overlayWarn'), overlayBlocked);
  show($('overlayRecheck'), overlayBlocked);
}

const POSITION_SHORT: Record<string, string> = {
  TOP: 'TOP',
  JUNGLE: 'JGL',
  MIDDLE: 'MID',
  BOTTOM: 'BOT',
  UTILITY: 'SUP',
};

/**
 * Who is in the room, always visible. A room's membership must never be hidden
 * from the people in it — an unexpected name is the only signal a player gets
 * that someone joined who should not have.
 */
function renderPeople(): void {
  const list = $<HTMLUListElement>('people');
  list.innerHTML = '';

  if (status.participants.length === 0 && voiceState.size === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.innerHTML = '<span class="dot"></span><span class="who">Nobody yet</span>';
    list.append(li);
    return;
  }

  const roster = new Set(status.participants.map((p) => p.identity));
  // Anyone in the voice room who is not on the ally roster — a browser guest,
  // or a name nobody expected — must still be visible. Hiding them is the
  // failure this list exists to prevent.
  const extras: Participant[] = [...voiceState.keys()]
    .filter((identity) => !roster.has(identity))
    .map((identity) => ({
      identity,
      championName: '',
      position: '',
      inVoice: true,
      speaking: false,
      isSelf: false,
    }));

  for (const base of [...status.participants, ...extras]) {
    const live = voiceState.get(base.identity);
    const person: Participant = {
      ...base,
      inVoice: live?.inVoice ?? false,
      speaking: live?.speaking ?? false,
    };
    const li = document.createElement('li');
    li.className = person.inVoice ? '' : 'pending';

    const dot = document.createElement('span');
    dot.className = person.speaking ? 'dot talking' : person.inVoice ? 'dot live' : 'dot';

    const who = document.createElement('span');
    who.className = 'who';
    // textContent, never innerHTML: these names come off the network.
    who.textContent = person.identity + (person.isSelf ? ' · you' : '');
    who.title = person.identity;

    const role = document.createElement('span');
    role.className = 'role';
    role.textContent = POSITION_SHORT[person.position] ?? '';

    li.append(dot, who, role);
    list.append(li);
  }
}

function renderStatus(): void {
  const state = $('state');
  const dot = $('stateDot');
  const where = status.region ? `${status.region} · ` : '';
  $('stateText').textContent = status.inGame
    ? `${where}in game · ${status.roomName ?? '—'}`
    : status.phase === 'ChampSelect'
      ? `${where}champ select${status.linkPosted ? ' · link posted' : ''}`
      : status.roomName
        ? `${where}${status.connection} · ${status.roomName}`
        : `${where}${status.connection}`;
  state.classList.toggle('error', status.connection === 'error' || !status.hookRunning);
  dot.classList.toggle('talking', status.connection === 'connected');
  dot.classList.toggle('live', status.connection === 'connecting' || status.inGame);

  const warn = $('hookWarn');
  if (!status.hookRunning) {
    warn.textContent = `Global hotkey hook is not running${
      status.hookError ? `: ${status.hookError}` : ''
    }. Push-to-talk will not work while League has focus.`;
  }
  // renderMic owns this element while a microphone error is showing.
  if (!status.hookRunning) show(warn, true);
  else if (!micError) show(warn, false);

  const mute = $<HTMLButtonElement>('muteBtn');
  mute.textContent = status.muted ? 'Unmute' : 'Mute';
  renderRoom();
  renderPeople();
  applyTrackState();
}

function renderMic(): void {
  const open = !settings.pttEnabled;
  const live = !status.muted && (open || transmitting);
  $('micDot').classList.toggle('talking', live);
  if (micError) {
    $('micDot').classList.remove('talking');
    $('micState').textContent = 'Mic unavailable';
    $('hookWarn').textContent = micError;
    show($('hookWarn'), true);
    return;
  }
  $('micState').textContent = status.muted
    ? 'Muted'
    : open
      ? 'Mic is open'
      : transmitting
        ? 'Talking'
        : 'Mic off';
}

async function renderMode(): Promise<void> {
  const ptt = settings.pttEnabled;
  $('modeOpen').classList.toggle('gold', !ptt);
  $('modePtt').classList.toggle('gold', ptt);

  // Open Mic hides the bind entirely rather than greying it out.
  show($('bindRow'), ptt);
  $('bindLabel').textContent = settings.pttBinding.label;

  const check = ptt ? await api.ptt.checkBinding(settings.pttBinding) : null;
  const conflict = check?.conflict ?? null;
  const el = $('conflictWarn');
  if (conflict) {
    // Say whose keymap this is. "Your bind" and "the default bind" are very
    // different claims to a player who has rebound their keys.
    const whose = check?.source.kind === 'live' ? 'your bind for' : "League's default for";
    el.textContent = `${conflict.label} is ${whose} “${conflict.leagueAction}”. Both fire — the hook is passive.`;
    el.classList.toggle('severe', conflict.severity === 'high');
  }
  show(el, Boolean(conflict));
  renderMic();
}

const SWITCHES: SettingsKey[] = [
  'autoConnectEnabled',
  'autoPostLinkEnabled',
  'overlayEnabled',
  'noiseSuppressionEnabled',
];

function renderSwitches(): void {
  for (const key of SWITCHES) $<HTMLInputElement>(key).checked = Boolean(settings[key]);
  const server = $<HTMLInputElement>('tokenServerUrl');
  // Do not fight the user while they are typing in it.
  if (document.activeElement !== server) server.value = settings.tokenServerUrl;
  $<HTMLSelectElement>('deviceSelect').value = settings.inputDeviceId || 'default';
}

// ----------------------------------------------------------- bind capture ---

let pending: Binding | null = null;
let sideButtonSeen = false;
let sideHintTimer = 0;

function openPicker(firstRun: boolean): void {
  pending = null;
  sideButtonSeen = false;
  show($('modal'), true);
  $('modalTitle').textContent = firstRun ? 'Choose your talk key' : 'Change your talk key';
  $('capture').textContent = 'Waiting for input…';
  $('capture').classList.remove('captured');
  show($('captureConflict'), false);
  $<HTMLButtonElement>('confirmBind').disabled = true;
  $('sideHint').textContent = 'Checking for mouse side buttons…';
  void api.ptt.beginCapture();

  clearTimeout(sideHintTimer);
  sideHintTimer = window.setTimeout(() => {
    $('sideHint').textContent = sideButtonSeen
      ? 'Side buttons detected on your mouse.'
      : 'No side buttons seen yet — press any key you do not use in game.';
  }, 5000);
}

function closePicker(): void {
  clearTimeout(sideHintTimer);
  show($('modal'), false);
  void api.ptt.cancelCapture();
}

async function setPending(binding: Binding): Promise<void> {
  const check = await api.ptt.checkBinding(binding);
  const { rejected, conflict } = check;
  const el = $('captureConflict');

  if (rejected) {
    // Refused outright — the pad shows what was pressed but Confirm stays off.
    pending = null;
    $('capture').textContent = binding.label;
    $('capture').classList.remove('captured');
    $<HTMLButtonElement>('confirmBind').disabled = true;
    el.textContent = rejected;
    el.classList.add('severe');
    show(el, true);
    void api.ptt.beginCapture(); // keep listening for a usable one
    return;
  }

  pending = binding;
  $('capture').textContent = binding.label;
  $('capture').classList.add('captured');
  $<HTMLButtonElement>('confirmBind').disabled = false;
  if (conflict) {
    const whose = check.source.kind === 'live' ? 'You use' : 'League uses';
    el.textContent = `Careful: ${whose} ${conflict.label} for “${conflict.leagueAction}”. Both will fire.`;
    el.classList.toggle('severe', conflict.severity === 'high');
  }
  show(el, Boolean(conflict));
}

// ------------------------------------------------------------------ wiring --

async function set<K extends SettingsKey>(key: K, value: Settings[K]): Promise<void> {
  settings = await api.settings.set(key, value);
  log(`setting ${key} = ${JSON.stringify(value)}`);
}

async function copyLink(): Promise<void> {
  const url = roomUrl();
  if (!url) return;
  const btn = $<HTMLButtonElement>('copyBtn');
  try {
    await navigator.clipboard.writeText(url);
    btn.textContent = 'Copied';
  } catch {
    btn.textContent = 'Copy failed';
  }
  setTimeout(() => {
    btn.textContent = 'Copy link';
  }, 1600);
}

function wire(): void {
  for (const key of SWITCHES) {
    $<HTMLInputElement>(key).addEventListener('change', async (e) => {
      await set(key, (e.target as HTMLInputElement).checked as never);
      if (key === 'noiseSuppressionEnabled') await ensureLocalTrack();
    });
  }

  $('copyBtn').addEventListener('click', () => void copyLink());
  $('joinBtn').addEventListener('click', async () => {
    status = await api.game.join();
    renderStatus();
  });

  $('overlayRecheck').addEventListener('click', async () => {
    status = await api.overlay.refreshWindowMode();
    renderStatus();
  });

  $<HTMLInputElement>('tokenServerUrl').addEventListener('change', async (e) => {
    const value = (e.target as HTMLInputElement).value.trim().replace(/\/+$/, '');
    await set('tokenServerUrl', value);
    // Rejoin against the new server rather than staying on a stale connection.
    reconcileVoice();
  });

  $('openLogs').addEventListener('click', () => api.diagnostics.openFolder());
  $<HTMLDetailsElement>('diag').addEventListener('toggle', () => {
    if (!$<HTMLDetailsElement>('diag').open) return;
    renderDiag();
    // The disclosure sits at the bottom of a scrolling column; bring it up.
    $('diag').scrollIntoView({ block: 'end' });
  });
  api.diagnostics.onEntry(pushDiag);

  $('modeOpen').addEventListener('click', async () => {
    if (!settings.pttEnabled) return;
    await set('pttEnabled', false);
    await renderMode();
  });
  $('modePtt').addEventListener('click', async () => {
    if (settings.pttEnabled) return;
    await set('pttEnabled', true);
    await renderMode();
  });
  $('changeBind').addEventListener('click', () => openPicker(false));

  $<HTMLSelectElement>('deviceSelect').addEventListener('change', async (e) => {
    await set('inputDeviceId', (e.target as HTMLSelectElement).value);
    await ensureLocalTrack();
  });
  $('grantBtn').addEventListener('click', () => void ensureLocalTrack());

  $('muteBtn').addEventListener('click', async () => {
    status = await api.status.setMuted(!status.muted);
    renderStatus();
    renderMic();
  });

  $('cancelBind').addEventListener('click', closePicker);
  $('confirmBind').addEventListener('click', async () => {
    if (!pending) return;
    // code -1 is the CapsLock sentinel; main resolves the real keycode.
    await set('pttBinding', pending);
    if (!settings.firstRunComplete) await set('firstRunComplete', true);
    closePicker();
    await renderMode();
  });

  $('hideBtn').addEventListener('click', () => api.window.hideToTray());
  $('quitBtn').addEventListener('click', () => api.window.quit());

  api.settings.onChanged((next) => {
    settings = next;
    renderSwitches();
    void renderMode();
  });
  api.status.onChanged((next) => {
    const before = { room: status.roomName, join: status.joinRequested };
    status = next;
    renderStatus();
    renderMic();
    if (before.room !== next.roomName || before.join !== next.joinRequested) reconcileVoice();
  });
  api.ptt.onState((next) => {
    transmitting = next;
    applyTrackState();
    renderMic();
  });

  $('manualGo').addEventListener('click', async () => {
    const input = $<HTMLInputElement>('manualLink');
    const result = await api.voice.manualRoom(input.value);
    if (result.ok) {
      input.value = '';
    } else {
      $('lookupWarn').textContent = result.reason ?? 'that link was not understood';
    }
  });
  api.ptt.onCaptured((binding) => void setPending(binding));
  api.ptt.onSideButton(() => {
    sideButtonSeen = true;
  });

  navigator.mediaDevices.addEventListener('devicechange', () => void populateDevices());
}

async function main(): Promise<void> {
  settings = await api.settings.getAll();
  status = await api.status.get();
  transmitting = await api.ptt.getState();
  diagEntries.push(...(await api.diagnostics.recent()).slice(-DIAG_LINES));
  wire();
  renderSwitches();
  renderStatus();
  await renderMode();
  await ensureLocalTrack();
  log('renderer ready');
  if (!settings.firstRunComplete) openPicker(true);
}

void main();
