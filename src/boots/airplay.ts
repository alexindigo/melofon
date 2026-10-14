// AirPlay lifecycle: engine/operator state survives temporary connections.
// One scheduler, per-output intent epochs, proven local-release barriers.
import type { Media } from '../media.ts';
import type { Notify } from '../notify.ts';
import type { CommandSource, Output, Outputs } from '../player.ts';
import type { Playback } from '../playback.ts';
import type { State } from '../state.ts';
import {
  CONNECTION_STRATEGIES,
  type ConnectionStrategy,
} from '../connection-strategy.ts';
import type { AirplayDevices } from './airplay-device.ts';
import type { AirplayTransport } from './airplay-profile.ts';
export { airplayOutputId } from './airplay-profile.ts';
export type { AirplayTransport, HelperEventFn } from './airplay-profile.ts';
export interface AirplayBootDeps {
  outputs: Outputs;
  playback: Playback;
  media: Media;
  notify: Notify;
  devices: AirplayDevices;
  state?: State;
  retryBackoffMs?: number[];
  retryTimer?: {
    set(callback: () => void, delayMs: number): { cancel(): void };
  };
}
export const AIRPLAY_RETRY_KEY = 'airplay.retry';
const DEFAULT_SECONDS = [0, 2, 5, 10, 20, 30, 60];
export function parseRetryBackoff(raw: string | null): number[] | null {
  if (raw?.trim().toLowerCase() === 'off') return null;
  const seconds = raw === null || raw.trim() === ''
    ? DEFAULT_SECONDS
    : raw.split(',').map((v) =>
      Math.min(60, Math.max(0, Number(v.trim()) || 0))
    );
  return seconds.map((v) => v * 1000);
}
const HOLD_MS = 10_000, SEEK_JUMP_MS = 1500;
const DEBUG = ['1', 'true'].includes(Deno.env.get('MELOFON_RAOP_DEBUG') ?? '');
type View = ReturnType<Playback['playerView']>;
interface Epoch {
  generation: number;
  attempts: number;
  timer?: { cancel(): void };
  failed: boolean;
  contentError: boolean;
}
interface Grant {
  epoch: number;
  kind: 'explicit' | 'planned' | 'retry';
}
interface Runtime {
  transport: AirplayTransport | null;
  session: number;
  pump: number;
  authorizedPump: number | null;
  connected: boolean;
  entry: number | null;
  strategy: ConnectionStrategy;
  host: string;
  port: number;
  progress: number;
  at: number;
  volume: number;
  held: boolean;
  deadline?: number;
  holdTimer?: ReturnType<typeof setTimeout>;
}

export function createAirplayBoot(
  deps: AirplayBootDeps,
): { close(): Promise<void> } {
  const { outputs, playback, media, notify } = deps;
  const devices = deps.devices;
  const retryTimer = deps.retryTimer ??
    {
      set(callback: () => void, delay: number) {
        const timer = setTimeout(callback, delay);
        return { cancel: () => clearTimeout(timer) };
      },
    };
  const ownedSource: CommandSource = { kind: 'internal', via: 'airplay-boot' };
  console.log(
    '[melofon] airplay: policy=connection-strategies-v1 default=melofon',
  );
  const runtimes = new Map<string, Runtime>();
  const epochs = new Map<string, Epoch>();
  const generations = new Map<string, number>();
  const grants = new Map<string, Grant>();
  const preparing = new Map<
    string,
    { controller: AbortController; grant: Grant; host: string; port?: number }
  >();
  const retiring = new Map<string, Promise<boolean>>();
  const blocked = new Set<string>();
  const pendingPumps = new Map<string, Runtime>();
  const forceRelease = new Set<string>();
  let closed = false, running = false, rerun = false, collecting = false;
  let needsHandoff = false;
  let intent: 'play' | 'pause' | 'stop' = playback.playerView().state;
  let intentEpoch = 0;
  let lease: { intent: number; outputs: Map<string, number> } | null = null;
  let seenPlayback = playback.lastCommand();
  let seenOutputs = outputs.lastCommand();
  const startupIds = playback.playerView().state === 'play'
    ? outputs.list().filter((o) => o.selected).map((o) => o.id)
    : [];
  let startup = true;
  let policyRevision = 0;
  let policyReady = deps.state === undefined ||
    deps.retryBackoffMs !== undefined;
  let backoff: number[] | null = deps.retryBackoffMs ?? parseRetryBackoff(null);

  const epoch = (id: string) => {
    let e = epochs.get(id);
    if (!e) {
      e = { generation: 0, attempts: 0, failed: false, contentError: false };
      epochs.set(id, e);
    }
    return e;
  };
  const cancelRetry = (id: string) => {
    const e = epoch(id);
    e.timer?.cancel();
    e.timer = undefined;
    if (grants.get(id)?.kind === 'retry') grants.delete(id);
    if (preparing.get(id)?.grant.kind === 'retry') {
      preparing.get(id)!.controller.abort();
    }
  };
  const revoke = (id: string) => {
    preparing.get(id)?.controller.abort();
    preparing.delete(id);
    cancelRetry(id);
    grants.delete(id);
    pendingPumps.delete(id);
    epoch(id).generation++;
    lease?.outputs.delete(id);
  };
  const grant = (id: string, kind: Grant['kind']) => {
    grants.set(id, { epoch: epoch(id).generation, kind });
  };
  const resetDemand = (id: string) => {
    const resumeAuthority = lease?.intent === intentEpoch && intent === 'play';
    revoke(id);
    const e = epoch(id);
    e.attempts = 0;
    e.failed = false;
    e.contentError = false;
    if (intent === 'play') grant(id, 'explicit');
    if (resumeAuthority && lease) lease.outputs.set(id, e.generation);
  };
  const consumeCommands = () => {
    const p = playback.lastCommand();
    const o = outputs.lastCommand();
    // Mark BOTH seen before any mutation can synchronously reenter notify.
    const newP = p !== seenPlayback, newO = o !== seenOutputs;
    seenPlayback = p;
    seenOutputs = o;
    if (newP && p) {
      if (p.queueCleared) {
        for (const id of runtimes.keys()) forceRelease.add(id);
      }
      if (p.source !== ownedSource && p.intent !== 'none') {
        intent = p.intent;
        intentEpoch++;
        lease = null;
        if (intent === 'play') {
          for (const out of outputs.list()) {
            if (out.type === 'AirPlay' && out.selected) resetDemand(out.id);
          }
        } else for (const id of epochs.keys()) revoke(id);
      }
    }
    if (newO && o) {
      if (o.kind === 'unregister') {
        for (const id of epochs.keys()) if (!outputs.get(id)) revoke(id);
      }
      if (o.selection) {
        for (const request of o.selection) {
          if (request.selected) resetDemand(request.id);
          else revoke(request.id);
        }
      }
    }
  };
  const usable = () =>
    [...runtimes.entries()].some(([id, r]) =>
      r.connected && r.transport && outputs.get(id)?.selected
    );
  const cancelPump = (id: string, r: Runtime) => {
    r.pump++;
    r.authorizedPump = null;
    r.transport?.cancelPcm();
    pendingPumps.delete(id);
  };
  const cancelHold = (r: Runtime) => {
    if (r.holdTimer !== undefined) clearTimeout(r.holdTimer);
    r.holdTimer = undefined;
    r.deadline = undefined;
    r.held = false;
  };

  const pumpCurrent = (id: string, r: Runtime) => {
    const out = outputs.get(id), view = playback.playerView(), t = r.transport;
    if (
      closed || blocked.has(id) || runtimes.get(id) !== r || !r.connected ||
      !t || !out?.selected || view.state !== 'play' || !view.current
    ) return;
    const generation = ++r.pump, session = r.session;
    r.authorizedPump = generation;
    r.entry = view.current.id;
    const path = view.current.song.path, startMs = view.itemProgressMs;
    const owns = () =>
      !closed && runtimes.get(id) === r && r.transport === t &&
      r.session === session && r.pump === generation;
    void (async () => {
      let bytes = 0;
      try {
        const stream = await media.decodePcm(
          path,
          startMs > 0 ? { startMs } : undefined,
        );
        if (!owns()) return;
        if (!stream) throw new Error('no decodable audio');
        for await (const chunk of stream) {
          if (!owns()) return;
          if (DEBUG && bytes === 0) {
            console.warn(
              `[melofon] airplay debug: pump first chunk ${chunk.length}B (${path})`,
            );
          }
          try {
            await t.pcm(chunk);
          } catch (error) {
            if (owns()) sessionFailed(id, r, `PCM: ${error}`);
            return;
          }
          if (!owns()) return;
          bytes += chunk.length;
        }
        if (!owns()) return;
        if (!bytes) throw new Error('empty decoder stream');
        if (DEBUG) {
          console.warn(
            `[melofon] airplay debug: pump generator end, total ${bytes}B (${path})`,
          );
        }
        // Nonempty EOF is decoder completion, not audible/drained completion.
      } catch (error) {
        if (!owns()) return;
        console.error(
          `[melofon] airplay: output ${id} content failed: ${error}`,
        );
        const e = epoch(id);
        e.contentError = true;
        cancelRetry(id);
        grants.delete(id);
        void retire(id, r, 'content');
        if (!usable() && playback.playerView().state === 'play') {
          lease = null;
          playback.pause(ownedSource);
        }
      }
    })();
  };
  const drainPumps = () => {
    if (closed || collecting || retiring.size) return;
    if (needsHandoff) {
      needsHandoff = false;
      const eligible = [...runtimes.entries()].filter(([id, r]) =>
        r.connected && r.transport && outputs.get(id)?.selected &&
        playback.playerView().state === 'play'
      );
      const current = eligible.find(([, r]) =>
        r.transport!.ownsSharedFeed() && r.authorizedPump === r.pump
      );
      if (!current && eligible.length) {
        const [id, r] = eligible[0];
        pendingPumps.delete(id);
        pumpCurrent(id, r);
      }
    }
    const batch = [...pendingPumps];
    pendingPumps.clear();
    for (const [id, r] of batch) pumpCurrent(id, r);
  };
  const requestPump = (id: string, r: Runtime) => {
    pendingPumps.set(id, r);
    drainPumps();
  };
  const retire = (id: string, r: Runtime, reason: string): Promise<boolean> => {
    const existing = retiring.get(id);
    if (existing) return existing;
    const t = r.transport;
    const wasFeed = t?.ownsSharedFeed() === true;
    if (wasFeed) {
      for (const [peerId, peer] of runtimes) {
        if (peerId !== id) cancelPump(peerId, peer);
      }
    }
    cancelPump(id, r);
    cancelHold(r);
    r.session++;
    r.connected = false;
    r.transport = null;
    runtimes.delete(id);
    if (!t) return Promise.resolve(true);
    console.log(
      `[melofon] airplay: output ${id} session gen ${
        r.session - 1
      } retire (reason=${reason})`,
    );
    const close = (async () => {
      try {
        await t.send({ cmd: 'teardown' }).catch(() => {});
        await t.close();
        if (wasFeed) needsHandoff = true;
        console.log(`[melofon] airplay: output ${id} retired locally`);
        return true;
      } catch (error) {
        blocked.add(id);
        grants.delete(id);
        cancelRetry(id);
        console.error(
          `[melofon] airplay: output ${id} retirement FAILED: ${error}; blocked until user-authorized restart`,
        );
        return false;
      }
    })();
    retiring.set(id, close);
    void close.then(() => {
      retiring.delete(id);
      if (closed) return;
      reconcile();
      drainPumps();
    });
    return close;
  };
  const scheduleRetry = (id: string) => {
    const e = epoch(id), out = outputs.get(id);
    if (
      closed || !policyReady || backoff === null || blocked.has(id) ||
      e.contentError || e.timer !== undefined || grants.has(id) ||
      !out?.selected || !out.host || intent !== 'play' ||
      (playback.playerView().state !== 'play' &&
        (!lease || lease.intent !== intentEpoch))
    ) return;
    if (e.attempts >= backoff.length) {
      console.warn(
        `[melofon] airplay: output ${id} exhausted ${e.attempts} retries; new explicit demand required`,
      );
      return;
    }
    const wait = backoff[e.attempts++], generation = e.generation;
    console.warn(
      `[melofon] airplay: output ${id} retry ${e.attempts}/${backoff.length} in ${wait}ms`,
    );
    e.timer = retryTimer.set(() => {
      e.timer = undefined;
      if (
        closed || e.generation !== generation || backoff === null ||
        !outputs.get(id)?.selected || intent !== 'play' || blocked.has(id)
      ) return;
      grant(id, 'retry');
      reconcile();
    }, wait);
  };
  const sessionFailed = (id: string, r: Runtime, why: string) => {
    if (runtimes.get(id) !== r) return;
    console.warn(`[melofon] airplay: output ${id} session failed (${why})`);
    const e = epoch(id);
    e.failed = true;
    void retire(id, r, 'failed');
    const view = playback.playerView();
    if (intent === 'play' && view.state === 'play' && !usable()) {
      // Acquire authority BEFORE synchronous internal Pause notification.
      lease = {
        intent: intentEpoch,
        outputs: new Map([...epochs].map(([key, v]) => [key, v.generation])),
      };
      playback.pause(ownedSource);
    }
    if (intent === 'play') scheduleRetry(id);
  };
  const volume = (out: Output, v: View) =>
    out.volume >= 100 ? v.volume : Math.round(out.volume * v.volume / 100);
  const spawnSession = (out: Output) => {
    const id = out.id, e = epoch(id), permission = grants.get(id);
    if (
      !permission || permission.epoch !== e.generation || blocked.has(id) ||
      retiring.has(id) || !out.selected || !out.host
    ) return;
    if (
      permission.kind === 'retry' &&
      (backoff === null || !policyReady || intent !== 'play')
    ) {
      grants.delete(id);
      return;
    }
    let view = playback.playerView();
    if (view.state !== 'play') {
      if (
        permission.kind === 'planned' || !lease ||
        lease.intent !== intentEpoch ||
        lease.outputs.get(id) !== e.generation || intent !== 'play'
      ) return;
      lease = null;
      playback.play(ownedSource);
      view = playback.playerView();
      // A synchronously reentrant USER Pause/Stop wins over owned resume.
      if (
        intent !== 'play' || grants.get(id) !== permission ||
        permission.epoch !== e.generation || view.state !== 'play'
      ) return;
    }
    if (!view.current) return;
    if (preparing.has(id)) return;
    const controller = new AbortController();
    const work = {
      controller,
      grant: permission,
      host: out.host,
      port: out.port,
    };
    preparing.set(id, work);
    let activated: Runtime | undefined;
    const current = () => {
      const row = outputs.get(id);
      return !closed && !controller.signal.aborted &&
        permission.epoch === epoch(id).generation &&
        row?.selected === true && intent === 'play' &&
        playback.playerView().state === 'play' &&
        (activated
          ? runtimes.get(id) === activated && activated.session === session
          : grants.get(id) === permission) &&
        !blocked.has(id) && !retiring.has(id);
    };
    let session = 0;
    void (async () => {
      const prepared = await devices.protocol.prepare({
        id,
        targetRevision: devices.admission.describe(id).targetRevision,
        signal: controller.signal,
        isCurrent: current,
      });
      if (preparing.get(id) !== work || !current()) return;
      preparing.delete(id);
      grants.delete(id);
      if (!prepared.ok) {
        e.failed = true;
        console.warn(
          `[melofon] airplay: output ${id} preparation failed (${prepared.error.code}: ${prepared.error.message})`,
        );
        if (!usable() && playback.playerView().state === 'play') {
          lease = {
            intent: intentEpoch,
            outputs: new Map(
              [...epochs].map(([key, value]) => [key, value.generation]),
            ),
          };
          playback.pause(ownedSource);
        }
        scheduleRetry(id);
        return;
      }
      const latestOut = outputs.get(id)!;
      view = playback.playerView();
      if (!view.current) return;
      e.failed = false;
      session = (generations.get(id) ?? 0) + 1;
      generations.set(id, session);
      const r: Runtime = {
        transport: null,
        session,
        pump: 0,
        authorizedPump: null,
        connected: false,
        // Retain queue identity for same-entry seeks before CONNECTED is
        // polled. Entry changes during the handshake still absorb the latest
        // item when the connecting generation starts its first pump.
        entry: view.current.id,
        strategy: latestOut.connectionStrategy,
        host: latestOut.host!,
        port: latestOut.port ?? 7000,
        progress: view.itemProgressMs,
        at: performance.now(),
        volume: volume(latestOut, view),
        held: false,
      };
      runtimes.set(id, r);
      activated = r;
      const own = () =>
        !closed && runtimes.get(id) === r && r.session === session &&
        r.transport !== null;
      try {
        console.log(
          `[melofon] airplay: output ${id} session gen ${session} start (strategy=${r.strategy} grant=${permission.kind})`,
        );
        const result = await devices.protocol.activate(prepared.value, {
          volume: r.volume,
          positionMs: 0,
          lengthMs: view.current.song.durationMs ?? 0,
          title: view.current.song.title ?? '',
          artist: view.current.song.artistName ?? '',
        }, {
          publish(transport) {
            r.transport = transport;
          },
          onEvent({ event, value }) {
            if (!own()) return;
            if (event === 'state' && value === 'failed') {
              sessionFailed(id, r, 'helper event');
            } else if (event === 'state' && value === 'password') {
              outputs.update(id, { needsAuthKey: true }, ownedSource);
            } else if (event === 'state' && value === 'connected') {
              const wasConnected = r.connected;
              r.connected = true;
              const latest = playback.playerView();
              r.progress = latest.itemProgressMs;
              r.at = performance.now();
              if (!wasConnected && !r.held && latest.state === 'play') {
                requestPump(id, r);
              }
              // Connected/FLUSH notifications never reset a demand's retry budget.
            }
          },
        });
        if (!result.ok && runtimes.get(id) === r) {
          sessionFailed(id, r, `activation: ${result.error.message}`);
        }
      } catch (error) {
        sessionFailed(id, r, `spawn: ${error}`);
      }
    })().catch((error) =>
      console.error(`[melofon] airplay: output ${id} preparation: ${error}`)
    );
  };
  const idle = (id: string, r: Runtime, choice: ConnectionStrategy) => {
    r.strategy = choice;
    if (CONNECTION_STRATEGIES[choice].idle === 'retire') {
      void retire(id, r, 'idle');
      return;
    }
    if (r.held) return;
    cancelPump(id, r);
    r.held = true;
    r.deadline = performance.now() + HOLD_MS;
    void r.transport!.send({ cmd: 'flush' }).catch((error) => {
      if (runtimes.get(id) === r) sessionFailed(id, r, `flush: ${error}`);
    });
    if (runtimes.get(id) !== r || !r.held) return;
    const session = r.session;
    r.holdTimer = setTimeout(() => {
      if (
        !closed && runtimes.get(id) === r && r.session === session && r.held
      ) void retire(id, r, 'hold expiry');
    }, Math.max(0, r.deadline! - performance.now()));
  };
  const reconcilePass = () => {
    const view = playback.playerView(),
      snapshot = outputs.list(),
      now = performance.now();
    const known = new Set(
      snapshot.filter((o) => o.type === 'AirPlay' && o.host).map((o) => o.id),
    );
    const retirements: [string, Runtime, string][] = [];
    const actions: (() => void)[] = [];
    for (const [id, work] of preparing) {
      const row = outputs.get(id);
      if (!row || row.host !== work.host || row.port !== work.port) {
        work.controller.abort();
        preparing.delete(id);
        devices.admission.describe(id);
      }
    }
    if (startup) {
      startup = false;
      if (view.state === 'play' && intent === 'play') {
        for (const id of startupIds) {
          if (!grants.has(id)) grant(id, 'explicit');
        }
      }
    }
    for (const [id, r] of runtimes) {
      if (!known.has(id)) {
        revoke(id);
        retirements.push([id, r, 'unregistered']);
      }
    }
    for (const out of snapshot) {
      if (!known.has(out.id)) continue;
      const id = out.id;
      epoch(id);
      const r = runtimes.get(id);
      if (blocked.has(id)) {
        grants.delete(id);
        continue;
      }
      if (!out.selected) {
        revoke(id);
        if (r) retirements.push([id, r, 'deselect']);
        continue;
      }
      if (forceRelease.delete(id)) {
        if (r) retirements.push([id, r, 'queue clear']);
        if (view.state === 'play' && intent === 'play') grant(id, 'explicit');
        continue;
      }
      if (r && (r.host !== out.host || r.port !== (out.port ?? 7000))) {
        if (intent === 'play' && view.state === 'play') grant(id, 'planned');
        retirements.push([id, r, 'address']);
        continue;
      }
      if (view.state !== 'play' || !view.current) {
        if (r) {
          // OwnTone may keep a current-null Stop transport; clear/deselect
          // were handled above and always release immediately.
          actions.push(() => idle(id, r, out.connectionStrategy));
        } else if (grants.has(id)) {
          actions.push(() => spawnSession(outputs.get(id) ?? out));
        }
        continue;
      }
      if (!r) {
        actions.push(() => spawnSession(outputs.get(id) ?? out));
        continue;
      }
      if (grants.get(id)?.kind === 'explicit') grants.delete(id);
      if (r.held) {
        actions.push(() => {
          cancelHold(r);
          r.strategy = out.connectionStrategy;
          if (r.connected) requestPump(id, r);
        });
      } else if (
        r.entry !== null && (r.connected || r.entry === view.current.id) &&
        (r.entry !== view.current.id ||
          Math.abs(view.itemProgressMs - (r.progress + (now - r.at))) >
            SEEK_JUMP_MS)
      ) {
        r.strategy = out.connectionStrategy; // Settings apply at transition.
        if (CONNECTION_STRATEGIES[r.strategy].discontinuity === 'retire') {
          grant(id, 'planned');
          retirements.push([
            id,
            r,
            r.entry !== view.current.id ? 'track' : 'seek',
          ]);
        } else if (r.connected) {
          actions.push(() => {
            cancelPump(id, r);
            void r.transport!.send({ cmd: 'flush' }).catch((error) => {
              if (runtimes.get(id) === r) {
                sessionFailed(id, r, `flush: ${error}`);
              }
            });
            requestPump(id, r);
          });
        }
      }
      actions.push(() => {
        if (runtimes.get(id) !== r || !r.transport) return;
        const current = playback.playerView(), row = outputs.get(id);
        if (!row) return;
        const v = volume(row, current);
        if (v !== r.volume) {
          r.volume = v;
          void r.transport.send({ cmd: 'volume', volume: v }).catch((error) => {
            if (runtimes.get(id) === r) {
              sessionFailed(id, r, `volume: ${error}`);
            }
          });
        }
        r.progress = current.itemProgressMs;
        r.at = performance.now();
      });
    }
    // Complete snapshot's barriers FIRST, independent of iteration order.
    collecting = true;
    for (const [id, r, why] of retirements) {
      if (runtimes.get(id) === r) void retire(id, r, why);
    }
    for (const action of actions) {
      if (rerun || closed) break;
      action();
    }
    collecting = false;
    drainPumps();
  };
  const reconcile = () => {
    if (closed) return;
    if (running) {
      rerun = true;
      return;
    }
    running = true;
    try {
      do {
        rerun = false;
        reconcilePass();
      } while (rerun && !closed);
    } finally {
      running = false;
    }
  };
  const applyPolicy = (value: string | null) => {
    backoff = parseRetryBackoff(value);
    policyReady = true;
    if (backoff === null) { for (const id of epochs.keys()) cancelRetry(id); }
    else for (const [id, e] of epochs) if (e.failed) scheduleRetry(id);
  };
  const unsubscribePolicy = deps.state && deps.retryBackoffMs === undefined
    ? deps.state.onChange((key, value) => {
      if (key !== AIRPLAY_RETRY_KEY) return;
      policyRevision++;
      applyPolicy(value);
      reconcile();
    })
    : undefined;
  if (deps.state && deps.retryBackoffMs === undefined) {
    const revision = policyRevision;
    void deps.state.get(AIRPLAY_RETRY_KEY).then((value) => {
      if (!closed && policyRevision === revision) applyPolicy(value);
    }).catch((error) => {
      if (closed || policyRevision !== revision) return;
      policyReady = true;
      backoff = null;
      console.error(
        `[melofon] airplay retry settings unavailable; automatic recovery disabled: ${error}`,
      );
    });
  }
  outputs.onCommand((id, cmd) => {
    const r = runtimes.get(id);
    if (cmd.pin !== undefined && r?.transport) {
      void r.transport.send({ cmd: 'pin', pin: cmd.pin }).catch((error) => {
        if (runtimes.get(id) === r) {
          sessionFailed(id, r, `PIN: ${error}`);
        }
      });
    }
  });
  const unsubscribe = notify.subscribe(() => {
    consumeCommands();
    reconcile();
  });
  if (startupIds.length) reconcile();
  return {
    async close() {
      closed = true;
      unsubscribe();
      unsubscribePolicy?.();
      lease = null;
      grants.clear();
      for (const work of preparing.values()) work.controller.abort();
      preparing.clear();
      pendingPumps.clear();
      for (const id of epochs.keys()) cancelRetry(id);
      const closes: Promise<unknown>[] = [...retiring.values()];
      for (const [id, r] of [...runtimes]) {
        closes.push(
          retire(id, r, 'boot close'),
        );
      }
      await Promise.all(closes);
    },
  };
}
