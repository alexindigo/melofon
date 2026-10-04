// src/boots/airplay.ts — the AirPlay 1 boot (M6). Boots are core: they
// app.outputs.register their outputs and this one drives OwnTone's RAOP
// in-process (helper/raop/libmelofon_raop.so via Deno FFI — see
// raop-ffi.ts) for every registered AirPlay output. Deno decodes the
// engine's current track to PCM via app.media (44100/16-bit/stereo, the
// RAOP contract); the library owns RTSP + RTP + ALAC + pacing on its own
// background thread. Commands are start/volume/flush/teardown/pin; state
// events come back polled (starting/connected/streaming/stopped/failed/
// password).
//
// Notify-driven (hats never touch this): reconcile on every player/outputs/
// volume event. Selected + engine play ⇒ session start; PCM flows only once
// the helper reports connected — OwnTone arms its playback timer when the
// device connects, so the first PCM is the track start (or the engine
// position), never handshake-time filler. Stop / deselect / unregister ⇒
// teardown + free.
//
// Discontinuities (plan atv3-session-recycle): a track change or a position
// jump must shed the native read-ahead (≈2 s of buffered PCM), which is the
// one place we are not gapless. Unaffected models FLUSH the session, as
// before. For the known affected model AppleTV3,1 — whose firmware wedges
// after repeated FLUSHes (restart-transparency report §3–4) — every
// would-be FLUSH instead RETIRES the session: pause tears down and stays
// down (a later play edge reconnects), and a track/seek retires with one
// authorized replacement that re-reads current engine/output state after
// the close barrier and decodes only after its own connected event. A
// planned recycle is not a playback failure: no core pause/play or
// deselect/reselect is manufactured for it. Reconnection is audible as a
// transition gap.
//
// The transport is injectable: tests fake it and assert on the command
// stream without the library or an AirPlay device.
import type { Media } from '../media.ts';
import type { Notify } from '../notify.ts';
import type { Output, Outputs } from '../player.ts';
import type { Playback } from '../playback.ts';
import type { State } from '../state.ts';
import { createFfiSpawn } from './raop-ffi.ts';

/** Stable output id for an AirPlay device: FNV-1a 64-bit of the host,
 * decimal — all digits so the OwnTone wire id regex /^\d+$/ accepts it. */
export function airplayOutputId(host: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(host)) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  }
  return hash.toString(10);
}

export interface AirplayTransport {
  /** One command; resolves when the native library has ACCEPTED it onto
   * its command queue — not when the device acknowledges it (neither a
   * close nor a native stopped proves remote TEARDOWN acknowledgment).
   * Rejects when the transport is closed or the native enqueue failed. */
  send(cmd: Record<string, unknown>): Promise<void>;
  /** One raw PCM frame (s16le/44100/stereo interleaved). Resolves once the
   * native read-ahead (≈2 s cap) accepted the bytes; parks in backpressure
   * when full. A FLUSH/TEARDOWN/close abandons the remaining bytes. */
  pcm(chunk: Uint8Array): Promise<void>;
  /** Tear down (if needed) and free the native handle. Resolves only when
   * native cleanup is proven; rejects when it is not — the handle is then
   * leaked by design, never a use-after-free. Memoized, including
   * rejection. */
  close(): Promise<void>;
}

export type HelperEventFn = (event: string, value?: string) => void;

export interface AirplayBootDeps {
  outputs: Outputs;
  playback: Playback;
  media: Media;
  notify: Notify;
  /** Injectable for tests; the default is the FFI transport (raop-ffi.ts). */
  spawn?: (onEvent: HelperEventFn) => AirplayTransport;
  /** Config for `airplay.retry` (no config means retries are on). */
  state?: State;
  /** Injectable backoff table (ms) — overrides the `airplay.retry` config. */
  retryBackoffMs?: number[];
}

const RAOP_PORT_DEFAULT = 7000;
export const AIRPLAY_RETRY_KEY = 'airplay.retry';
/** Default failure-retry backoff (s): capped at 60 — a recovering session
 * may not wait longer than a minute or the music surprises when it returns.
 * `airplay.retry`: 'off', or a comma list of seconds (each clamped to 60). */
const RETRY_BACKOFF_MS = [0, 2, 5, 10, 20, 30, 60];

/** Parse the `airplay.retry` config: null means use `raw`'s list, 'off'
 * disables retries. Exported for tests. Values clamped to 60 s each. */
export function parseRetryBackoff(raw: string | null): number[] | null {
  if (raw !== null && raw.trim().toLowerCase() === 'off') return null;
  if (raw === null || raw.trim() === '') return [...RETRY_BACKOFF_MS];
  return raw.split(',').map((token) =>
    Math.min(60, Math.max(0, Number(token.trim()) || 0))
  );
}
/** After a helper failure: retry selections on this schedule. The session
 * binds to the device, never to an address — every attempt re-reads
/** OwnTone outputs.c rel_to_vol: output.volume is relative to master. */
function sessionVolume(outputVolume: number, masterVolume: number): number {
  if (outputVolume >= 100) return masterVolume;
  return Math.round(outputVolume * masterVolume / 100);
}
/** Engine progress must move more than this (ms) mid-play to count as a
 * seek; below it, event-latency jitter would cause flush hiccups. */
const SEEK_JUMP_MS = 1500;
/** The affected model (mDNS `am`) whose would-be FLUSHes become session
 * recycles (plan atv3-session-recycle). An exact identity match — never a
 * hostname, IP, output name, or the broad appletv devtype. */
const RECYCLE_MODEL = 'AppleTV3,1';
/** Diagnostics (plan airplay-silence): pump first-chunk + generator-end
 * lines, off unless MELOFON_RAOP_DEBUG=1|true. */
const RAOP_DEBUG = ['1', 'true'].includes(
  Deno.env.get('MELOFON_RAOP_DEBUG') ?? '',
);

type PlayerView = ReturnType<Playback['playerView']>;

interface Runtime {
  transport: AirplayTransport | null;
  /** Boot-local session generation: every transport allocation bumps it.
   * A helper event is handled only while its captured generation is still
   * the runtime's current one and the runtime is still the registered one —
   * retirement bumps it synchronously BEFORE the teardown enqueue, so
   * callbacks arriving during retirement are already stale. */
  sessionGen: number;
  /** Queue-entry id the helper is (or was last) streaming. */
  entryId: number | null;
  /** The helper reported connected — the pump may start (OwnTone's shape:
   * the playback timer arms at CONNECTED, never during the handshake). */
  helperConnected: boolean;
  /** Engine progress snapshot for seek detection. */
  lastProgressMs: number;
  lastEventAt: number;
  lastState: 'play' | 'pause' | 'stop';
  /** Last volume pushed to the helper (the start command carries it too). */
  lastVolume: number;
  /** Incremented to cancel the in-flight pump. */
  pumpGen: number;
  paused: boolean;
  warned: boolean;
  /** Logged the once-per-session "waiting for connected" line. */
  waitingLogged: boolean;
  /** Logged the once-per-outage "no hub decision, session stays down" line. */
  noSpawnLogged: boolean;
}

export function createAirplayBoot(deps: AirplayBootDeps): {
  close(): Promise<void>;
} {
  const { outputs, playback, media, notify } = deps;
  const spawn = deps.spawn ?? createFfiSpawn();
  // One identifiable code-path marker at boot init (plan §3.5): a log grep
  // proves which discontinuity policy this process runs.
  console.log(
    `[melofon] airplay: policy=atv3-recycle-v1 model=${RECYCLE_MODEL} ` +
      'discontinuity=reconnect',
  );
  /** Backoff table in ms — the injection wins for tests, then the
   * `airplay.retry` config (no config = retries on), cached live. */
  let backoff: number[] | null = deps.retryBackoffMs ?? [
    ...RETRY_BACKOFF_MS,
  ];
  const retryStateUnsubscribe = deps.retryBackoffMs !== undefined ||
      deps.state === undefined
    ? undefined
    : deps.state!.onChange((key, value) => {
      if (key !== AIRPLAY_RETRY_KEY) return;
      backoff = parseRetryBackoff(value);
    });
  if (deps.retryBackoffMs === undefined && deps.state !== undefined) {
    void deps.state!.get(AIRPLAY_RETRY_KEY).then((value) => {
      backoff = parseRetryBackoff(value);
    });
  }
  const runtimes = new Map<string, Runtime>();
  /** Per-output session generation counter — monotonically increasing per
   * output across runtime recreations, so the generation-tagged lifecycle
   * logs actually distinguish sessions (plan §3.5). Ownership still rides
   * the runtime's captured generation. */
  const sessionGens = new Map<string, number>();
  /** Failure-retry bookkeeping, per output id — survives runtime teardown. */
  const retries = new Map<
    string,
    { attempts: number; timer?: ReturnType<typeof setTimeout> }
  >();
  /** Hub-and-spoke: sessions move only on a hub decision for that output —
   * the player went to play, this output became selected, or its retry
   * timer fired. A catalog event (another device registering) never starts
   * or stops a session. */
  const spawnAllow = new Set<string>();
  /** Per-output retirement in flight, tracked OUTSIDE the live runtime map
   * so removing a runtime cannot lose the close obligation. Resolves true
   * on proven native cleanup, false on failure. The barrier: no new
   * transport for the output until it settles, by any path — stop,
   * deselect, reselect, failure retry, or planned replacement. */
  const retiring = new Map<string, Promise<boolean>>();
  /** Outputs whose retirement FAILED (native cleanup unproven): blocked
   * until a separately user-authorized process restart. Play, reselect,
   * discovery and retry events never clear it — a failed retirement is
   * loud, never optimistic. */
  const blocked = new Map<string, string>();
  /** Outputs authorized to spawn once their retirement barrier releases:
   * the original discontinuity (track/seek) authorizes one replacement; a
   * valid play/select/retry decision during the close is remembered here
   * and never bypasses the retirement. */
  const pendingSpawn = new Set<string>();
  /** Pumps held for the shared-feed handoff: while any retirement is in
   * flight, new pumps — including a peer's first valid connected — wait
   * for the batch, then re-read CURRENT engine state (no obsolete
   * entry/position snapshot survives). */
  const heldPumps = new Map<string, Runtime>();
  let prevPlayerState: 'play' | 'pause' | 'stop' = 'stop';
  const prevSelected = new Map<string, boolean>();
  let closed = false;

  const runtimeFor = (id: string): Runtime => {
    let rt = runtimes.get(id);
    if (rt === undefined) {
      rt = {
        transport: null,
        sessionGen: 0,
        entryId: null,
        helperConnected: false,
        lastProgressMs: 0,
        lastEventAt: performance.now(),
        lastState: 'stop',
        lastVolume: -1,
        pumpGen: 0,
        paused: false,
        warned: false,
        waitingLogged: false,
        noSpawnLogged: false,
      };
      runtimes.set(id, rt);
    }
    return rt;
  };

  /** OwnTone pb_suspend: when a failure leaves no live session, the player
   * pauses rather than lie about progress. Cleared on any 'connected'. */
  let failurePaused = false;
  const anyLiveSessions = (): boolean =>
    [...runtimes.values()].some((rt) => rt.helperConnected);

  const cancelRetry = (id: string) => {
    const r = retries.get(id);
    if (r?.timer !== undefined && r.timer !== null) clearTimeout(r.timer);
    retries.delete(id);
    spawnAllow.delete(id);
  };

  const scheduleRetry = (id: string) => {
    if (closed) return;
    const table = backoff;
    if (table !== null) {
      let r = retries.get(id);
      if (r === undefined) {
        r = { attempts: 0 };
        retries.set(id, r);
      }
      if (r.attempts >= table.length) {
        retries.delete(id);
        const output = outputs.get(id);
        console.warn(
          `[melofon] airplay: output ${id} gave up after ${r.attempts} session retries`,
        );
        if (
          output?.selected === true && playback.playerView().state === 'play'
        ) {
          outputs.update(id, { selected: false }, {
            kind: 'internal',
            via: 'airplay-boot',
          });
        }
        return;
      }
      const wait = table[r.attempts];
      r.attempts++;
      console.warn(
        `[melofon] airplay: output ${id} retry ${r.attempts}/${table.length} ` +
          `in ${wait}ms`,
      );
      r.timer = setTimeout(() => {
        r.timer = undefined;
        // The hub's decision: this output's session comes back. Catalog
        // events for other devices never get here.
        spawnAllow.add(id);
        // OwnTone speaker_resurrect pb_resume: if the failure rested the
        // player, lift it, then let reconcile re-spawn against discovery's
        // current record (output.host re-read per attempt). A user pause in
        // this window can be lifted once — accepted edge, same as upstream.
        if (failurePaused) {
          playback.play({ kind: 'internal', via: 'airplay-boot' });
          failurePaused = false;
        }
        reconcile();
      }, wait);
    }
  };

  const pump = (
    rt: Runtime,
    entryId: number,
    path: string,
    startMs: number,
  ) => {
    const gen = ++rt.pumpGen;
    rt.entryId = entryId;
    void (async () => {
      const stream = await media.decodePcm(
        path,
        startMs > 0 ? { startMs } : undefined,
      );
      if (stream === null) {
        console.warn(`[melofon] airplay: no decodable audio in ${path}`);
        return;
      }
      let total = 0;
      for await (const chunk of stream) {
        if (rt.pumpGen !== gen || rt.transport === null || closed) return;
        if (RAOP_DEBUG && total === 0) {
          let peak = 0;
          const view = new DataView(
            chunk.buffer,
            chunk.byteOffset,
            chunk.byteLength,
          );
          for (let i = 0; i + 1 < chunk.length; i += 2) {
            const s = view.getInt16(i, true);
            const a = s < 0 ? -s : s;
            if (a > peak) peak = a;
          }
          console.warn(
            `[melofon] airplay debug: pump first chunk ${chunk.length}B ` +
              `peak=${peak} (${path})`,
          );
        }
        total += chunk.length;
        try {
          await rt.transport.pcm(chunk);
        } catch {
          return; // the helper went away mid-track
        }
      }
      if (RAOP_DEBUG) {
        console.warn(
          `[melofon] airplay debug: pump generator end, total ${total}B ` +
            `(${path})`,
        );
      }
    })().catch((err) => {
      console.warn(`[melofon] airplay: pump failed for ${path}: ${err}`);
    });
  };

  /** The one pump-start path (plan atv3-session-recycle §3.4): re-read the
   * CURRENT engine/output state — never a snapshot taken before a close —
   * and only when the runtime is still the registered, connected one. */
  const pumpCurrent = (id: string, rt: Runtime) => {
    if (closed || blocked.has(id)) return;
    if (runtimes.get(id) !== rt) return;
    if (rt.transport === null || !rt.helperConnected) return;
    const output = outputs.get(id);
    if (output?.selected !== true) return;
    const view = playback.playerView();
    if (view.state !== 'play' || view.current === null) return;
    pump(rt, view.current.id, view.current.song.path, view.itemProgressMs);
  };

  const drainHeldPumps = () => {
    const held = [...heldPumps];
    heldPumps.clear();
    for (const [id, rt] of held) pumpCurrent(id, rt);
  };

  /** Every pump start routes here: while any retirement is in flight the
   * pump joins the pending handoff instead of decoding early into the
   * accept-and-drop window of the shared feed. */
  const requestPump = (id: string, rt: Runtime) => {
    if (retiring.size === 0) {
      pumpCurrent(id, rt);
      return;
    }
    heldPumps.set(id, rt);
  };

  /** The retirement barrier released for this output: a planned
   * replacement (or a play edge that arrived during the close) spawns ONE
   * fresh session against the CURRENT records — address, port, model,
   * selection, effective volume, engine entry and position are re-read
   * here, and the decode still waits for the new session's own connected. */
  const onRetired = (id: string) => {
    if (closed || blocked.has(id)) return;
    if (!pendingSpawn.delete(id)) return;
    const output = outputs.get(id);
    if (output?.selected !== true || output.host === undefined) return;
    const view = playback.playerView();
    if (view.state !== 'play' || view.current === null) return;
    const rt = runtimeFor(id);
    spawnSession(output, rt, view, 'replacement');
  };

  /** Idempotent per-output retirement: cancel the pump, retire ownership
   * synchronously (callbacks arriving during the close are already stale),
   * detach the transport from the runtime, enqueue TEARDOWN, and await the
   * native close. True on proven cleanup; on failure the output is blocked
   * until a user-authorized restart — a failed retirement never authorizes
   * a replacement. */
  const retireRuntime = (
    id: string,
    rt: Runtime,
    reason: string,
  ): Promise<boolean> => {
    const pending = retiring.get(id);
    if (pending !== undefined) return pending;
    const gen = rt.sessionGen;
    rt.pumpGen++; // cancel the in-flight pump
    rt.sessionGen++; // ownership retires NOW — old callbacks are stale
    const transport = rt.transport;
    rt.transport = null;
    rt.entryId = null;
    rt.paused = false;
    rt.helperConnected = false;
    runtimes.delete(id);
    if (transport === null) return Promise.resolve(true);
    const output = outputs.get(id);
    console.log(
      `[melofon] airplay: output ${id} session gen ${gen} retire ` +
        `(reason=${reason} model=${output?.model ?? 'unknown'})`,
    );
    const startedAt = performance.now();
    const promise = (async () => {
      try {
        // A rejected teardown enqueue (native queue contract) still falls
        // through to close: the native free tears a live device down.
        await transport.send({ cmd: 'teardown' }).catch(() => {});
        await transport.close();
        console.log(
          `[melofon] airplay: output ${id} session gen ${gen} retired ` +
            `in ${Math.round(performance.now() - startedAt)}ms`,
        );
        return true;
      } catch (err) {
        console.error(
          `[melofon] airplay: output ${id} session gen ${gen} retirement ` +
            `FAILED: ${err} — output blocked until a user-authorized restart`,
        );
        blocked.set(id, `gen ${gen} retirement: ${err}`);
        return false;
      }
    })();
    retiring.set(id, promise);
    void promise.finally(() => {
      try {
        retiring.delete(id);
        if (retiring.size === 0) drainHeldPumps();
        onRetired(id);
      } catch (err) {
        console.warn('[melofon] airplay: post-retirement step failed:', err);
      }
    });
    return promise;
  };

  /** The helper (or the start enqueue itself) reported failure: tear the
   * runtime down through the same retirement barrier, pb_suspend when
   * nothing is live, then the bounded retry (unchanged policy). */
  const sessionFailed = (id: string, rt: Runtime, why: string) => {
    console.warn(`[melofon] airplay: output ${id} session failed (${why})`);
    void retireRuntime(id, rt, 'failed');
    // pb_suspend first: if nothing is live anywhere, pause the player —
    // honest surface while the retry tries (OwnTone's exact cleanup move).
    if (!anyLiveSessions()) {
      playback.pause({ kind: 'internal', via: 'airplay-boot' });
      failurePaused = true;
    }
    // Links flap and devices move — retry with backoff unless disabled via
    // `airplay.retry=off`; only persistent failure leaves this paused. A
    // blocked output (native cleanup failed) does not retry.
    if (!blocked.has(id)) scheduleRetry(id);
  };

  /** Allocate a fresh session: a new transport with its own generation,
   * the start command carrying the current record. The event callback
   * captures runtime + generation; the start-enqueue rejection routes
   * through the bounded failure-retry policy exactly once. */
  const spawnSession = (
    output: Output,
    rt: Runtime,
    view: PlayerView,
    how: string,
  ) => {
    const id = output.id;
    if (closed || blocked.has(id) || retiring.has(id)) return;
    if (view.current === null || output.host === undefined) return;
    const entry = view.current;
    const volume = sessionVolume(output.volume, view.volume);
    const gen = (sessionGens.get(id) ?? 0) + 1;
    sessionGens.set(id, gen);
    rt.sessionGen = gen;
    let transport: AirplayTransport;
    try {
      transport = spawn((event, value) =>
        onHelperEvent(id, rt, gen, event, value)
      );
    } catch (err) {
      if (!rt.warned) {
        rt.warned = true;
        console.warn(
          `[melofon] airplay: cannot start the RAOP session: ${err}`,
        );
      }
      return;
    }
    rt.transport = transport;
    rt.paused = false;
    rt.entryId = null;
    rt.helperConnected = false;
    rt.lastVolume = volume;
    // Fresh baselines: a later reconnect must not read as a seek.
    rt.lastState = 'play';
    rt.lastProgressMs = view.itemProgressMs;
    rt.lastEventAt = performance.now();
    console.log(
      `[melofon] airplay: output ${id} session gen ${gen} start ` +
        `(${how}) model=${output.model ?? 'unknown'}`,
    );
    transport.send({
      cmd: 'start',
      host: output.host,
      port: output.port ?? RAOP_PORT_DEFAULT,
      name: output.name,
      volume,
      // mDNS-derived session knobs (absent on manual registrations —
      // OwnTone-with-missing-TXT defaults: appletv, encrypt 0,
      // metadata 0, authsetup 0).
      ...(output.devtype !== undefined && { devtype: output.devtype }),
      ...(output.encrypt !== undefined && { encrypt: output.encrypt }),
      wanted_metadata: output.wantedMetadata ?? 0,
      authsetup: output.supportsAuthSetup === true ? 1 : 0,
      requires_auth: output.requiresAuth === true ? 1 : 0,
      ...(output.sampleRate !== undefined &&
        { sample_rate: output.sampleRate }),
      ...(output.bitsPerSample !== undefined &&
        { bits: output.bitsPerSample }),
      ...(output.channels !== undefined && { channels: output.channels }),
      // Item metadata — the helper sends it on the stream clock after
      // 88200 samples (OwnTone event_play_start), not as a pre-start seed.
      pos_ms: 0,
      len_ms: entry.song.durationMs ?? 0,
      title: entry.song.title ?? '',
      artist: entry.song.artistName ?? '',
    }).catch((err) => {
      // The start enqueue failed natively. Route through the failure-retry
      // policy once; the generation guard keeps stale callbacks from
      // duplicating it.
      if (closed) return;
      if (runtimes.get(id) !== rt || rt.sessionGen !== gen) return;
      sessionFailed(id, rt, `start enqueue: ${err}`);
    });
    // No pump here: the helper's connected event starts it.
  };

  const onHelperEvent = (
    id: string,
    rt: Runtime,
    gen: number,
    event: string,
    value?: string,
  ) => {
    // Ownership FIRST, before any handling — connected/failed/password
    // alike: the boot open, this runtime still the registered one, this
    // generation still owning the transport. A retired helper's events can
    // never affect its replacement or the output row.
    if (closed) return;
    if (
      runtimes.get(id) !== rt || rt.sessionGen !== gen ||
      rt.transport === null
    ) return;
    if (event === 'state' && value === 'password') {
      // The device wants a password or shows a PIN (raop's pin-start path).
      outputs.update(id, { needsAuthKey: true }, {
        kind: 'internal',
        via: 'airplay-boot',
      });
      console.warn(
        `[melofon] airplay: output ${id} needs a PIN (POST /_/outputs/${id}/pin)`,
      );
    } else if (event === 'state' && value === 'failed') {
      sessionFailed(id, rt, 'helper event');
    } else if (event === 'state' && value === 'connected') {
      // OwnTone arms the playback timer when the device reports CONNECTED:
      // the session is up, NOW the first PCM goes out — the track start (or
      // the engine position), never handshake-time filler the library would
      // have to dump.
      cancelRetry(id);
      failurePaused = false;
      rt.helperConnected = true;
      // Fresh seek baselines: time spent reconnecting is not a seek.
      const view = playback.playerView();
      rt.lastProgressMs = view.itemProgressMs;
      rt.lastEventAt = performance.now();
      if (view.state === 'play') rt.lastState = 'play';
      const output = outputs.get(id);
      if (
        rt.entryId === null &&
        view.state === 'play' && view.current !== null &&
        output?.selected === true
      ) {
        console.log(
          `[melofon] airplay: output ${id} session gen ${gen} connected`,
        );
        requestPump(id, rt);
      }
    }
  };

  const flush = (rt: Runtime) => {
    rt.pumpGen++; // stop feeding old audio
    void rt.transport?.send({ cmd: 'flush' }).catch(() => {});
  };

  const reconcile = () => {
    if (closed) return;
    const view = playback.playerView();
    const now = performance.now();
    const known = new Set<string>();
    // Hub decisions since the last reconcile: the player went to play…
    const playEdge = view.state === 'play' && prevPlayerState !== 'play';

    for (const output of outputs.list()) {
      if (output.type !== 'AirPlay' || output.host === undefined) continue;
      known.add(output.id);
      const id = output.id;
      const rt = runtimeFor(id);
      // …or this output became selected. Catalog events (a register from
      // discovery, another device's volume) produce neither.
      const selectEdge = output.selected &&
        prevSelected.get(output.id) !== true;
      const retryEdge = spawnAllow.delete(id);
      const maySpawn = playEdge || selectEdge || retryEdge;
      const affected = output.model === RECYCLE_MODEL;

      // A failed retirement blocks the output until a user-authorized
      // process restart — nothing below may resurrect it.
      if (blocked.has(id)) {
        prevSelected.set(id, output.selected);
        continue;
      }

      // Stop / deselect / no current: retire without replacement — through
      // the same barrier as everything else.
      if (!output.selected || view.state === 'stop' || view.current === null) {
        cancelRetry(id);
        pendingSpawn.delete(id);
        heldPumps.delete(id);
        if (rt.transport !== null) {
          void retireRuntime(
            id,
            rt,
            !output.selected ? 'deselect' : 'stop',
          );
        }
        rt.lastState = view.state;
        prevSelected.set(id, output.selected);
        continue;
      }

      // Pause: unaffected outputs flush once (helper drops read-ahead +
      // device buffer). The affected model retires instead — no FLUSH — and
      // stays down until a later play edge reconnects.
      if (view.state === 'pause') {
        if (affected) {
          pendingSpawn.delete(id); // pause authorizes no replacement
          heldPumps.delete(id);
          if (rt.transport !== null) void retireRuntime(id, rt, 'pause');
        } else if (rt.transport !== null && !rt.paused) {
          flush(rt);
          rt.paused = true;
        }
        rt.lastState = 'pause';
        rt.lastProgressMs = view.itemProgressMs;
        rt.lastEventAt = now;
        prevSelected.set(id, output.selected);
        continue;
      }

      // Playing to a selected output.
      const volume = sessionVolume(output.volume, view.volume);
      if (rt.transport === null) {
        if (retiring.has(id)) {
          // The barrier: no new transport until the close settles. A real
          // hub decision in this window is remembered, not dropped.
          if (maySpawn) pendingSpawn.add(id);
          prevSelected.set(id, output.selected);
          continue;
        }
        if (!maySpawn) {
          // The session is down and the hub has not asked for it back —
          // a catalog event brought us here, so the session stays down.
          if (!rt.noSpawnLogged) {
            rt.noSpawnLogged = true;
            console.warn(
              `[melofon] airplay: output ${id} session down, ` +
                'no hub decision to restart it',
            );
          }
          prevSelected.set(id, output.selected);
          continue;
        }
        rt.noSpawnLogged = false;
        spawnSession(
          output,
          rt,
          view,
          retryEdge ? 'retry' : selectEdge ? 'select' : 'play',
        );
      } else if (!rt.helperConnected) {
        // The RTSP handshake is still in flight. Do not fill a buffer the
        // library cannot pace out yet — if connected never arrives, nothing
        // was pumped and nothing needs dumping. Log once per session.
        if (!rt.waitingLogged) {
          rt.waitingLogged = true;
          console.warn(
            `[melofon] airplay: output ${id} waiting for the session ` +
              'to connect before PCM',
          );
        }
      } else if (rt.entryId !== view.current.id) {
        // Track change: the native read-ahead of the old track must go.
        if (affected) {
          // The discontinuity authorizes ONE replacement, after closure.
          pendingSpawn.add(id);
          void retireRuntime(id, rt, 'track');
        } else {
          flush(rt);
          rt.paused = false;
          requestPump(id, rt);
        }
      } else if (rt.paused) {
        // Resume (unaffected — the affected model retired on pause): the
        // pause flushed, so re-decode from the current position.
        rt.paused = false;
        requestPump(id, rt);
      } else if (
        rt.lastState === 'play' &&
        Math.abs(
            view.itemProgressMs -
              (rt.lastProgressMs + (now - rt.lastEventAt)),
          ) > SEEK_JUMP_MS
      ) {
        // Seek mid-play: same treatment as a track change.
        if (affected) {
          pendingSpawn.add(id);
          void retireRuntime(id, rt, 'seek');
        } else {
          flush(rt);
          requestPump(id, rt);
        }
      }

      if (rt.transport !== null && volume !== rt.lastVolume) {
        rt.lastVolume = volume;
        void rt.transport.send({ cmd: 'volume', volume })
          .catch(() => {});
      }

      rt.lastState = 'play';
      rt.lastProgressMs = view.itemProgressMs;
      rt.lastEventAt = now;
      prevSelected.set(id, output.selected);
    }

    // Unregistered outputs: retire whatever runtime is left.
    for (const [id, rt] of [...runtimes]) {
      if (!known.has(id)) {
        cancelRetry(id);
        pendingSpawn.delete(id);
        heldPumps.delete(id);
        void retireRuntime(id, rt, 'unregistered');
        prevSelected.delete(id);
      }
    }
    prevPlayerState = view.state;
  };

  // Pins are commands through app.outputs.update — deliver to the helper.
  outputs.onCommand((id, cmd) => {
    if (cmd.pin === undefined) return;
    const rt = runtimes.get(id);
    if (rt?.transport == null) {
      console.warn(
        `[melofon] airplay: pin for ${id} but the helper is not running ` +
          '(start playback to the selected output first)',
      );
      return;
    }
    void rt.transport.send({ cmd: 'pin', pin: cmd.pin }).catch(() => {});
  });

  // Only engine/selection/volume changes can move a helper.
  const unsubscribe = notify.subscribe((types) => {
    if (
      types.some((t) => t === 'player' || t === 'outputs' || t === 'volume')
    ) {
      reconcile();
    }
  });

  return {
    async close() {
      closed = true; // cancels all future replacement work
      retryStateUnsubscribe?.();
      for (const r of retries.values()) {
        if (r.timer !== undefined && r.timer !== null) clearTimeout(r.timer);
      }
      retries.clear();
      unsubscribe();
      pendingSpawn.clear();
      heldPumps.clear();
      // Await every detached retirement AND retire the live runtimes —
      // the close obligations are not lost.
      const pending: Promise<unknown>[] = [...retiring.values()];
      for (const [id, rt] of [...runtimes]) {
        pending.push(retireRuntime(id, rt, 'boot close'));
      }
      await Promise.all(pending);
    },
  };
}
