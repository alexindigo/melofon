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
// position), never handshake-time filler. Pause ⇒ flush (the library drops
// its read-ahead; resume re-decodes from the engine's progress). Stop /
// deselect / unregister ⇒ teardown + free. A track change or a position
// jump flushes first because the library reads a whole track ahead — the
// stale read-ahead must go (this is the one place we are not gapless).
//
// The transport is injectable: tests fake it and assert on the command
// stream without the library or an AirPlay device.
import type { Media } from '../media.ts';
import type { Notify } from '../notify.ts';
import type { Outputs } from '../player.ts';
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
  /** One JSON command frame; resolves when written. */
  send(cmd: Record<string, unknown>): Promise<void>;
  /** One raw PCM frame (s16le/44100/stereo interleaved). */
  pcm(chunk: Uint8Array): Promise<void>;
  /** Close stdin; the helper exits on EOF. */
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
/** Diagnostics (plan airplay-silence): pump first-chunk + generator-end
 * lines, off unless MELOFON_RAOP_DEBUG=1|true. */
const RAOP_DEBUG = ['1', 'true'].includes(
  Deno.env.get('MELOFON_RAOP_DEBUG') ?? '',
);

interface Runtime {
  transport: AirplayTransport | null;
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
    void deps.state.get(AIRPLAY_RETRY_KEY).then((value) => {
      backoff = parseRetryBackoff(value);
    });
  }
  const runtimes = new Map<string, Runtime>();
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
  let prevPlayerState: 'play' | 'pause' | 'stop' = 'stop';
  const prevSelected = new Map<string, boolean>();
  let closed = false;

  const runtimeFor = (id: string): Runtime => {
    let rt = runtimes.get(id);
    if (rt === undefined) {
      rt = {
        transport: null,
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
          outputs.update(id, { selected: false });
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

  const stopRuntime = (id: string, rt: Runtime) => {
    rt.pumpGen++; // cancel any pump
    const transport = rt.transport;
    rt.transport = null;
    rt.entryId = null;
    rt.paused = false;
    runtimes.delete(id);
    if (transport !== null) {
      void transport.send({ cmd: 'teardown' })
        .catch(() => {}) // the helper may already be gone
        .finally(() => transport.close().catch(() => {}));
    }
  };

  const onHelperEvent = (id: string, event: string, value?: string) => {
    if (closed) return;
    if (event === 'state' && value === 'password') {
      // The device wants a password or shows a PIN (raop's pin-start path).
      outputs.update(id, { needsAuthKey: true });
      console.warn(
        `[melofon] airplay: output ${id} needs a PIN (POST /_/outputs/${id}/pin)`,
      );
    } else if (event === 'state' && value === 'failed') {
      console.warn(`[melofon] airplay: output ${id} session failed`);
      const rt = runtimes.get(id);
      if (rt !== undefined) stopRuntime(id, rt);
      // pb_suspend first: if nothing is live anywhere, pause the player —
      // honest surface while the retry tries (OwnTone's exact cleanup move).
      if (!anyLiveSessions()) {
        playback.pause({ kind: 'internal', via: 'airplay-boot' });
        failurePaused = true;
      }
      // Links flap and devices move — retry with backoff unless disabled via
      // `airplay.retry=off`; only persistent failure leaves this paused.
      scheduleRetry(id);
    } else if (event === 'state' && value === 'connected') {
      // OwnTone arms the playback timer when the device reports CONNECTED:
      // the session is up, NOW the first PCM goes out — the track start (or
      // the engine position), never handshake-time filler the library would
      // have to dump.
      const rt = runtimes.get(id);
      if (rt === undefined) return;
      cancelRetry(id);
      failurePaused = false;
      rt.helperConnected = true;
      const view = playback.playerView();
      const output = outputs.get(id);
      if (
        rt.transport !== null && rt.entryId === null &&
        view.state === 'play' && view.current !== null &&
        output?.selected === true
      ) {
        pump(rt, view.current.id, view.current.song.path, view.itemProgressMs);
      }
    }
  };

  /** Decode the entry's track and stream PCM to the helper; cancelled by
   * bumping rt.pumpGen. startMs is the engine position (pause → resume,
   * seek, or selecting an output mid-track). */
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
      const rt = runtimeFor(output.id);
      // …or this output became selected. Catalog events (a register from
      // discovery, another device's volume) produce neither.
      const selectEdge = output.selected &&
        prevSelected.get(output.id) !== true;
      const retryEdge = spawnAllow.delete(output.id);
      const maySpawn = playEdge || selectEdge || retryEdge;

      // Stop / deselect: teardown and drop the runtime.
      if (!output.selected || view.state === 'stop' || view.current === null) {
        cancelRetry(output.id);
        if (rt.transport !== null) stopRuntime(output.id, rt);
        rt.lastState = view.state;
        prevSelected.set(output.id, output.selected);
        continue;
      }

      // Pause: flush once (helper drops read-ahead + device buffer).
      if (view.state === 'pause') {
        if (rt.transport !== null && !rt.paused) {
          flush(rt);
          rt.paused = true;
        }
        rt.lastState = 'pause';
        rt.lastProgressMs = view.itemProgressMs;
        rt.lastEventAt = now;
        prevSelected.set(output.id, output.selected);
        continue;
      }

      // Playing to a selected output.
      const entry = view.current;
      const volume = sessionVolume(output.volume, view.volume);
      if (rt.transport === null) {
        if (!maySpawn) {
          // The session is down and the hub has not asked for it back —
          // a catalog event brought us here, so the session stays down.
          if (!rt.noSpawnLogged) {
            rt.noSpawnLogged = true;
            console.warn(
              `[melofon] airplay: output ${output.id} session down, ` +
                'no hub decision to restart it',
            );
          }
          prevSelected.set(output.id, output.selected);
          continue;
        }
        rt.noSpawnLogged = false;
        if (RAOP_DEBUG) {
          console.warn(
            `[melofon] airplay: output ${output.id} session start ` +
              `(hub: ${retryEdge ? 'retry' : selectEdge ? 'select' : 'play'})`,
          );
        }
        try {
          rt.transport = spawn(
            (event, value) => onHelperEvent(output.id, event, value),
          );
        } catch (err) {
          if (!rt.warned) {
            rt.warned = true;
            console.warn(
              `[melofon] airplay: cannot start the RAOP session: ${err}`,
            );
          }
          continue;
        }
        rt.paused = false;
        rt.entryId = null;
        rt.lastVolume = volume;
        void rt.transport.send({
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
        }).catch(() => {});
        // No pump here: the helper's connected event starts it.
      } else if (!rt.helperConnected) {
        // The RTSP handshake is still in flight. Do not fill a buffer the
        // library cannot pace out yet — if connected never arrives, nothing
        // was pumped and nothing needs dumping. Log once per session.
        if (!rt.waitingLogged) {
          rt.waitingLogged = true;
          console.warn(
            `[melofon] airplay: output ${output.id} waiting for the session ` +
              'to connect before PCM',
          );
        }
      } else if (rt.entryId !== entry.id) {
        // Track change: the helper holds read-ahead of the old track.
        flush(rt);
        rt.paused = false;
        pump(rt, entry.id, entry.song.path, view.itemProgressMs);
      } else if (rt.paused) {
        // Resume: the pause flushed, so re-decode from the current position.
        rt.paused = false;
        pump(rt, entry.id, entry.song.path, view.itemProgressMs);
      } else if (
        rt.lastState === 'play' &&
        Math.abs(
            view.itemProgressMs -
              (rt.lastProgressMs + (now - rt.lastEventAt)),
          ) > SEEK_JUMP_MS
      ) {
        // Seek mid-play: same treatment as a track change.
        flush(rt);
        pump(rt, entry.id, entry.song.path, view.itemProgressMs);
      }

      if (rt.transport !== null && volume !== rt.lastVolume) {
        rt.lastVolume = volume;
        void rt.transport.send({ cmd: 'volume', volume })
          .catch(() => {});
      }

      rt.lastState = 'play';
      rt.lastProgressMs = view.itemProgressMs;
      rt.lastEventAt = now;
      prevSelected.set(output.id, output.selected);
    }

    // Unregistered outputs: teardown whatever runtime is left.
    for (const [id, rt] of [...runtimes]) {
      if (!known.has(id)) {
        cancelRetry(id);
        stopRuntime(id, rt);
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
      closed = true;
      retryStateUnsubscribe?.();
      for (const r of retries.values()) {
        if (r.timer !== undefined && r.timer !== null) clearTimeout(r.timer);
      }
      retries.clear();
      unsubscribe();
      const pending = [...runtimes.values()].map((rt) => {
        rt.pumpGen++;
        const transport = rt.transport;
        rt.transport = null;
        return transport === null ? Promise.resolve() : (async () => {
          await transport.send({ cmd: 'teardown' }).catch(() => {});
          await transport.close().catch(() => {});
        })();
      });
      runtimes.clear();
      await Promise.all(pending);
    },
  };
}
