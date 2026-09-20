// src/boots/airplay.ts — the AirPlay 1 boot (M6). Boots are core: they
// app.outputs.register their outputs and this one drives the native RAOP
// helper (helper/raop/melofon-raop — OwnTone's raop.c, see VENDORING.md)
// for every registered AirPlay output. Deno decodes the engine's current
// track to PCM via app.media (44100/16-bit/stereo, the RAOP default); the
// helper owns RTSP + RTP + ALAC + pacing. IPC is the helper's stdin:
// length-prefixed frames, 'J' JSON commands (start/volume/flush/teardown/
// pin) and 'P' raw PCM; the helper reports state as JSON lines on stdout.
//
// Notify-driven (hats never touch this): reconcile on every player/outputs/
// volume event. Selected + engine play ⇒ helper start + PCM flows. Pause ⇒
// flush (the helper drops its read-ahead; resume re-decodes from the
// engine's progress). Stop / deselect / unregister ⇒ teardown + the helper
// exits on stdin EOF. A track change or a position jump flushes first
// because the helper reads a whole track ahead — the stale read-ahead must
// go (this is the one place we are not gapless).
//
// The transport is injectable: tests fake it and assert on the frame stream
// without a helper binary or an AirPlay device.
import type { Media } from '../media.ts';
import type { Notify } from '../notify.ts';
import type { Outputs } from '../player.ts';
import type { Playback } from '../playback.ts';

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
  /** Helper binary path; default helper/raop/melofon-raop next to the repo. */
  helperPath?: string;
  /** Injectable for tests; default spawns the helper with piped stdio. */
  spawn?: (helperPath: string, onEvent: HelperEventFn) => AirplayTransport;
}

const DEFAULT_HELPER_PATH = decodeURIComponent(
  new URL('../../helper/raop/melofon-raop', import.meta.url).pathname,
);
const RAOP_PORT_DEFAULT = 7000;
/** Engine progress must move more than this (ms) mid-play to count as a
 * seek; below it, event-latency jitter would cause flush hiccups. */
const SEEK_JUMP_MS = 1500;

function defaultSpawn(
  helperPath: string,
  onEvent: HelperEventFn,
): AirplayTransport {
  const proc = new Deno.Command(helperPath, {
    stdin: 'piped',
    stdout: 'piped',
    stderr: 'inherit', // helper logs (DPRINTF) go to our stderr
  }).spawn();
  const writer = proc.stdin.getWriter();
  const encode = new TextEncoder();

  // stdout: one JSON event per line.
  void (async () => {
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of proc.stdout) {
      buf += decoder.decode(chunk, { stream: true });
      let idx = buf.indexOf('\n');
      while (idx >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        idx = buf.indexOf('\n');
        try {
          const ev = JSON.parse(line) as { event?: string; value?: string };
          if (typeof ev.event === 'string') onEvent(ev.event, ev.value);
        } catch {
          // Not JSON — helper noise; ignore.
        }
      }
    }
  })().catch(() => {}); // stdout ends with the process

  // One write per frame (header+payload combined) so concurrent send/pcm
  // callers can never interleave on the wire.
  const frame = (type: number, payload: Uint8Array) => {
    const out = new Uint8Array(5 + payload.length);
    new DataView(out.buffer).setUint32(0, payload.length); // BE length
    out[4] = type;
    out.set(payload, 5);
    return writer.write(out);
  };

  return {
    send: (cmd) => frame(0x4a, encode.encode(JSON.stringify(cmd))), // 'J'
    pcm: (chunk) => frame(0x50, chunk), // 'P'
    close: async () => {
      await writer.close().catch(() => {});
      const status = await Promise.race([
        proc.status.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 3000)),
      ]);
      if (!status) {
        try {
          proc.kill();
        } catch { /* already gone */ }
        await proc.status.catch(() => {});
      }
    },
  };
}

interface Runtime {
  transport: AirplayTransport | null;
  /** Queue-entry id the helper is (or was last) streaming. */
  entryId: number | null;
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
}

export function createAirplayBoot(deps: AirplayBootDeps): {
  close(): Promise<void>;
} {
  const { outputs, playback, media, notify } = deps;
  const helperPath = deps.helperPath ?? DEFAULT_HELPER_PATH;
  const spawn = deps.spawn ?? defaultSpawn;
  const runtimes = new Map<string, Runtime>();
  let closed = false;

  const runtimeFor = (id: string): Runtime => {
    let rt = runtimes.get(id);
    if (rt === undefined) {
      rt = {
        transport: null,
        entryId: null,
        lastProgressMs: 0,
        lastEventAt: performance.now(),
        lastState: 'stop',
        lastVolume: -1,
        pumpGen: 0,
        paused: false,
        warned: false,
      };
      runtimes.set(id, rt);
    }
    return rt;
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
      for await (const chunk of stream) {
        if (rt.pumpGen !== gen || rt.transport === null || closed) return;
        try {
          await rt.transport.pcm(chunk);
        } catch {
          return; // the helper went away mid-track
        }
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

    for (const output of outputs.list()) {
      if (output.type !== 'AirPlay' || output.host === undefined) continue;
      known.add(output.id);
      const rt = runtimeFor(output.id);

      // Stop / deselect: teardown and drop the runtime.
      if (!output.selected || view.state === 'stop' || view.current === null) {
        if (rt.transport !== null) stopRuntime(output.id, rt);
        rt.lastState = view.state;
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
        continue;
      }

      // Playing to a selected output.
      const entry = view.current;
      if (rt.transport === null) {
        try {
          rt.transport = spawn(
            helperPath,
            (event, value) => onHelperEvent(output.id, event, value),
          );
        } catch (err) {
          if (!rt.warned) {
            rt.warned = true;
            console.warn(
              `[melofon] airplay: cannot start helper ${helperPath} ` +
                `(make -C helper/raop): ${err}`,
            );
          }
          continue;
        }
        rt.paused = false;
        rt.entryId = null;
        rt.lastVolume = output.volume;
        void rt.transport.send({
          cmd: 'start',
          host: output.host,
          port: output.port ?? RAOP_PORT_DEFAULT,
          name: output.name,
          volume: output.volume,
        }).catch(() => {});
        // Pump right away: the helper buffers PCM during the RTSP handshake.
        pump(rt, entry.id, entry.song.path, view.itemProgressMs);
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

      // Volume follows the output row; the start command carried the first.
      if (rt.transport !== null && output.volume !== rt.lastVolume) {
        rt.lastVolume = output.volume;
        void rt.transport.send({ cmd: 'volume', volume: output.volume })
          .catch(() => {});
      }

      rt.lastState = 'play';
      rt.lastProgressMs = view.itemProgressMs;
      rt.lastEventAt = now;
    }

    // Unregistered outputs: teardown whatever runtime is left.
    for (const [id, rt] of [...runtimes]) {
      if (!known.has(id)) stopRuntime(id, rt);
    }
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
