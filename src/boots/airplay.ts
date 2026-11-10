// AirPlay lifecycle: engine/operator state survives temporary connections.
// One scheduler, per-output intent epochs, proven local-release barriers.
import type { Media } from '../media.ts';
import {
  createPlaybackSource,
  type PlaybackSources,
} from '../playback-source.ts';
import { type Log, scopedLog } from '../logging.ts';
import { queueDisplay } from '../queue-source.ts';
import type { Notify } from '../notify.ts';
import type {
  CommandSource,
  Output,
  Outputs,
  PlaybackSource,
} from '../player.ts';
import type { Playback } from '../playback.ts';
import type { State } from '../state.ts';
import {
  CONNECTION_STRATEGIES,
  type ConnectionStrategy,
} from '../connection-strategy.ts';
import type { AirplayDevices } from './airplay-device.ts';
import type { AirplayTransport } from './airplay-profile.ts';
import { SpeakerError, type SpeakerPairingView } from '../speakers.ts';
export { airplayOutputId } from './airplay-profile.ts';
export type { AirplayTransport, HelperEventFn } from './airplay-profile.ts';
export interface AirplayBootDeps {
  playerId?: number;
  outputs: Outputs;
  playback: Playback;
  media: Media;
  sources?: PlaybackSources;
  notify: Notify;
  devices: AirplayDevices;
  state?: State;
  log?: Log;
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
const HOLD_MS = 10_000;
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
interface RuntimePin {
  timer?: ReturnType<typeof setTimeout>;
  saved: boolean;
  stopped: boolean;
  current(): boolean;
}
interface Runtime {
  transport: AirplayTransport | null;
  activationCurrent?: () => boolean;
  session: number;
  pump: number;
  connected: boolean;
  authenticationRequired: boolean;
  pin?: RuntimePin;
  entry: number | null;
  playbackGeneration: number;
  strategy: ConnectionStrategy;
  host: string;
  port: number;
  volume: number;
  held: boolean;
  deadline?: number;
  holdTimer?: ReturnType<typeof setTimeout>;
}
interface ResumeWork {
  controller: AbortController;
  grant?: Grant;
  runtime?: Runtime;
  isCurrent(): boolean;
}

interface PairingWork {
  controller: AbortController;
  transport?: AirplayTransport;
  timer?: ReturnType<typeof setTimeout>;
  view: SpeakerPairingView;
  saved: boolean;
  stopped: boolean;
  current(): boolean;
}

export function createAirplayBoot(
  deps: AirplayBootDeps,
): {
  retry(id: string): Promise<void>;
  changeCredentials(id: string, save: () => Promise<void>): Promise<void>;
  pair(id: string): Promise<SpeakerPairingView>;
  submitPin(id: string, pin: string): Promise<SpeakerPairingView>;
  close(): Promise<void>;
} {
  const { outputs, playback, media, notify } = deps;
  const sources = deps.sources ?? createPlaybackSource({ media });
  // Keep the existing permissive off/list parser (including clamping) at its owner.
  deps.state?.declare(AIRPLAY_RETRY_KEY, {
    type: 'string',
    default: DEFAULT_SECONDS.join(','),
    description: 'Retry delays in seconds, or off; delays are clamped to 0–60',
  });
  const log = deps.log ?? scopedLog('airplay');
  deps.state?.declare('airplay.pairingSeconds', {
    type: 'number',
    minimum: 0.01,
    maximum: 600,
    default: 120,
    description: 'Maximum lifetime of an explicit speaker pairing operation',
  });
  const devices = deps.devices;
  const retryTimer = deps.retryTimer ??
    {
      set(callback: () => void, delay: number) {
        const timer = setTimeout(callback, delay);
        return { cancel: () => clearTimeout(timer) };
      },
    };
  const ownedSource: CommandSource = { kind: 'internal', via: 'airplay-boot' };
  log.event('airplay_policy', {
    policy: 'connection-strategies-v1',
    default: 'melofon',
  });
  const runtimes = new Map<string, Runtime>();
  const epochs = new Map<string, Epoch>();
  const generations = new Map<string, number>();
  const grants = new Map<string, Grant>();
  const resuming = new Map<string, ResumeWork>();
  const preparing = new Map<
    string,
    { controller: AbortController; grant: Grant; host: string; port?: number }
  >();
  const retiring = new Map<string, Promise<boolean>>();
  const blocked = new Set<string>();
  const pendingPumps = new Map<string, Runtime>();
  const pumps = new Set<Promise<void>>();
  // One source lifetime for the native shared stream, elected BEFORE acquisition.
  // Keep the slot through nonempty EOF: accepted PCM may still be playing out.
  let source: {
    id: string;
    runtime: Runtime;
    generation: number;
    lease: PlaybackSource;
  } | null = null;
  const pairings = new Map<string, PairingWork>();
  const forceRelease = new Set<string>();
  let closed = false, running = false, rerun = false, collecting = false;
  let needsHandoff = false;
  let feedBlocked = false;
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

  const publishPairing = (id: string, work: PairingWork) => {
    devices.sessionChanged(id, {
      connection: 'disconnected',
      authentication:
        work.view.state === 'awaiting_pin' || work.view.state === 'pairing'
          ? 'authentication_required'
          : 'none',
      pairing: structuredClone(work.view),
    });
  };
  const finishPairing = (
    id: string,
    work: PairingWork,
    state: SpeakerPairingView['state'],
    code?: string,
  ) => {
    if (pairings.get(id) !== work || work.controller.signal.aborted) return;
    const publish = work.current();
    work.view = {
      state,
      saved: state === 'complete' && outputs.lifetime(id).adopted,
      ...(code
        ? { error: { code, message: 'Speaker pairing did not complete' } }
        : {}),
    };
    work.controller.abort();
    clearTimeout(work.timer);
    if (publish) publishPairing(id, work);
    const transport = work.transport;
    work.transport = undefined;
    if (transport) {
      const closing = transport.close().then(() => true).catch(() => {
        blocked.add(id);
        return false;
      });
      retiring.set(id, closing);
      void closing.then(() => {
        if (retiring.get(id) === closing) retiring.delete(id);
        reconcile();
      });
    }
  };
  const cancelPairing = (id: string) => {
    const work = pairings.get(id);
    if (work) finishPairing(id, work, 'cancelled');
  };
  // Reservation, receipt flags and timeout have one lifetime. Identity guards
  // keep a stale async exit from releasing a later challenge's attempt.
  const releasePin = (runtime: Runtime, work = runtime.pin) => {
    if (!work || runtime.pin !== work) return;
    clearTimeout(work.timer);
    runtime.pin = undefined;
  };

  const epoch = (id: string) => {
    let e = epochs.get(id);
    if (!e) {
      e = { generation: 0, attempts: 0, failed: false, contentError: false };
      epochs.set(id, e);
    }
    return e;
  };
  const cancelResume = (id: string) => {
    const work = resuming.get(id);
    if (!work) return;
    resuming.delete(id);
    work.controller.abort();
  };
  const cancelRetry = (id: string) => {
    const e = epoch(id);
    e.timer?.cancel();
    e.timer = undefined;
    if (grants.get(id)?.kind === 'retry') grants.delete(id);
    if (preparing.get(id)?.grant.kind === 'retry') {
      preparing.get(id)!.controller.abort();
    }
    if (resuming.get(id)?.grant?.kind === 'retry') cancelResume(id);
  };
  const revoke = (id: string) => {
    const runtime = runtimes.get(id);
    if (runtime) releasePin(runtime);
    cancelResume(id);
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
        for (const id of pairings.keys()) cancelPairing(id);
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
          cancelPairing(request.id);
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
  const pauseWithoutPeer = () => {
    if (
      intent !== 'play' || playback.playerView().state !== 'play' || usable()
    ) return;
    lease = {
      intent: intentEpoch,
      outputs: new Map(
        [...epochs].map(([id, value]) => [id, value.generation]),
      ),
    };
    if (source) cancelPump(source.id, source.runtime);
    playback.pause(ownedSource);
  };
  const resume = (out: Output, permission?: Grant, r?: Runtime) => {
    const id = out.id;
    if (resuming.has(id)) return;
    const authority = lease;
    const demand = intentEpoch, generation = epoch(id).generation;
    const incarnation = outputs.revision(id);
    const session = r?.session, transport = r?.transport;
    const controller = new AbortController();
    const work: ResumeWork = {
      controller,
      grant: permission,
      runtime: r,
      isCurrent() {
        const row = outputs.get(id);
        return resuming.get(id) === work && !controller.signal.aborted &&
          !closed && intent === 'play' && intentEpoch === demand &&
          epoch(id).generation === generation &&
          outputs.revision(id) === incarnation &&
          row?.selected === true && row.type === out.type &&
          row.host === out.host && row.port === out.port &&
          !blocked.has(id) && !retiring.has(id) &&
          (permission
            ? grants.get(id) === permission &&
              (permission.kind !== 'retry' || policyReady && backoff !== null)
            : r !== undefined && runtimes.get(id) === r &&
              r.session === session &&
              r.transport === transport && r.connected);
      },
    };
    resuming.set(id, work);
    let retry = false;
    void (async () => {
      await playback.play(ownedSource, {
        signal: controller.signal,
        isCurrent: work.isCurrent,
      });
      consumeCommands();
      const view = playback.playerView();
      if (!work.isCurrent() || view.state !== 'play' || !view.current) return;
      if (lease === authority) lease = null;
      if (r) {
        requestPump(id, r);
      }
    })().catch((error) => {
      if (!work.isCurrent()) return;
      // This exact attempt is spent. Reconciliation cannot reuse its grant;
      // only the finite retry scheduler may authorize another preparation.
      if (permission && grants.get(id) === permission) grants.delete(id);
      epoch(id).failed = true;
      retry = true;
      if (r) {
        void retire(id, r, 'failed');
        devices.sessionChanged(id, {
          connection: 'failed',
          authentication: 'none',
          error: {
            code: 'transport_failed',
            message: 'Speaker could not resume playback',
          },
        });
      }
      log.event('preparation_error', { output: id, error });
    }).finally(() => {
      if (resuming.get(id) === work) resuming.delete(id);
      if (
        retry && intentEpoch === demand && epoch(id).generation === generation
      ) scheduleRetry(id);
      reconcile();
    });
  };
  const cancelPump = (id: string, r: Runtime) => {
    if (source?.runtime === r) {
      playback.cancelSource(source.lease);
      source = null;
    }
    r.pump++;
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
      !t || !out?.selected || view.state !== 'play' || !view.current || source
    ) return;
    const sourceLease = playback.openSource(view.current.id, view.generation);
    if (!sourceLease) return;
    const generation = ++r.pump, session = r.session;
    const authority = { id, runtime: r, generation, lease: sourceLease };
    source = authority;
    r.entry = view.current.id;
    const current = view.current, startMs = sourceLease.startMs;
    const path = current.facts.kind === 'song'
      ? current.facts.song.path
      : undefined;
    const owns = () =>
      source === authority && !sourceLease.signal.aborted && !closed &&
      runtimes.get(id) === r &&
      r.transport === t &&
      r.session === session && r.pump === generation;
    const pumping = (async () => {
      let bytes = 0;
      try {
        const stream = await sources.open(current, {
          signal: sourceLease.signal,
          startMs,
          onMetadata: (metadata) => {
            if (owns()) playback.reportSourceMetadata(sourceLease, metadata);
          },
          retry: (reason) => playback.retrySource(sourceLease, reason),
        });
        if (!stream) {
          if (!owns()) return;
          throw new Error('no decodable audio');
        }
        const iterator = stream[Symbol.asyncIterator]();
        try {
          if (!owns()) return;
          for await (
            const chunk of { [Symbol.asyncIterator]: () => iterator }
          ) {
            if (!owns()) return;
            if (DEBUG && path !== undefined && bytes === 0) {
              log.event('pump_first', {
                output: id,
                generation: session,
                path,
                bytes: chunk.length,
              });
            }
            try {
              await t.pcm(chunk);
            } catch (error) {
              if (owns()) sessionFailed(id, r, 'PCM', error);
              return;
            }
            if (!owns()) return;
            bytes += chunk.length;
            playback.sourceAudio(
              sourceLease,
              chunk.length / (44100 * 2 * 2) * 1000,
            );
          }
        } finally {
          await iterator.return?.();
        }
        if (!owns()) return;
        if (!bytes) throw new Error('empty decoder stream');
        if (DEBUG && path !== undefined) {
          log.event('pump_end', {
            output: id,
            generation: session,
            path,
            bytes,
          });
        }
        // Nonempty EOF is decoder completion, not audible/drained completion.
        playback.reportSourceOutcome(sourceLease, 'eof');
      } catch (error) {
        if (!owns()) return;
        if (current.facts.kind === 'web') {
          // The source owner exhausted its bounded retries. Healthy receiver
          // sessions remain admitted; core alone skips/stops the failed item.
          playback.reportSourceOutcome(sourceLease, 'decode-error');
          return;
        }
        log.event('content_failed', { output: id, generation: session, error });
        // A shared source failure is not a speaker failure. Fence every demand
        // before retiring any session, so a peer cannot reopen the same source.
        lease = null;
        for (const out of outputs.list()) {
          if (out.type !== 'AirPlay' || !out.selected) continue;
          epoch(out.id).contentError = true;
          revoke(out.id);
          devices.sessionChanged(out.id, {
            connection: 'failed',
            authentication: 'none',
            error: {
              code: 'content_failed',
              message: 'Audio source could not be decoded',
            },
          });
        }
        playback.reportSourceOutcome(sourceLease, 'decode-error');
        for (const [peerId, peer] of [...runtimes]) {
          void retire(peerId, peer, 'content');
        }
      }
    })();
    pumps.add(pumping);
    void pumping.finally(() => pumps.delete(pumping));
  };
  const drainPumps = () => {
    if (closed || collecting || retiring.size || feedBlocked) return;
    if (!needsHandoff && !pendingPumps.size) return;
    const eligible = [...runtimes.entries()].filter(([id, r]) =>
      r.connected && r.transport && !r.held && !epoch(id).contentError &&
      !blocked.has(id) && outputs.get(id)?.selected &&
      playback.playerView().state === 'play'
    );
    needsHandoff = false;
    pendingPumps.clear();
    if (source || !eligible.length) return;
    // A held/FLUSHed native session retains its token until close. Reuse it;
    // otherwise the elected writer claims the free token on its first PCM.
    const [id, r] = eligible.find(([, r]) => r.transport!.ownsSharedFeed()) ??
      eligible[0];
    pumpCurrent(id, r);
  };
  const requestPump = (id: string, r: Runtime) => {
    const view = playback.playerView();
    r.entry = view.current?.id ?? null;
    r.playbackGeneration = view.generation;
    pendingPumps.set(id, r);
    drainPumps();
  };
  const retire = (id: string, r: Runtime, reason: string): Promise<boolean> => {
    const existing = retiring.get(id);
    if (existing) return existing;
    if (resuming.get(id)?.runtime === r) cancelResume(id);
    const t = r.transport;
    const wasFeed = t?.ownsSharedFeed() === true || source?.runtime === r;
    if (wasFeed) {
      for (const [peerId, peer] of runtimes) {
        if (peerId !== id) cancelPump(peerId, peer);
      }
    }
    cancelPump(id, r);
    cancelHold(r);
    releasePin(r);
    r.session++;
    r.connected = false;
    r.transport = null;
    runtimes.delete(id);
    if (reason !== 'failed' && reason !== 'content') {
      devices.sessionChanged(id, {
        connection: 'disconnected',
        authentication: r.authenticationRequired
          ? 'authentication_required'
          : 'none',
      });
    }
    if (!t) {
      // A runtime can be awaiting credential acquisition before publication.
      // Its removal still has to replan the current intent's pending grant.
      reconcile();
      return Promise.resolve(true);
    }
    log.event('session_retire', {
      output: id,
      generation: r.session - 1,
      reason,
    });
    const close = (async () => {
      try {
        await t.send({ cmd: 'teardown' }).catch(() => {});
        await t.close();
        if (wasFeed) needsHandoff = true;
        log.event('session_retired', { output: id, generation: r.session - 1 });
        return true;
      } catch (error) {
        if (wasFeed) feedBlocked = true;
        blocked.add(id);
        grants.delete(id);
        cancelRetry(id);
        devices.sessionChanged(id, {
          connection: 'failed',
          authentication: 'none',
          error: {
            code: 'retirement_failed',
            message: 'Speaker session could not be released',
          },
        });
        log.event('retirement_failed', {
          output: id,
          generation: r.session - 1,
          error,
        });
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
      log.event('retry_exhausted', { output: id, attempts: e.attempts });
      return;
    }
    const wait = backoff[e.attempts++], generation = e.generation;
    log.event('retry_scheduled', {
      output: id,
      generation,
      attempt: e.attempts,
      limit: backoff.length,
      waitMs: wait,
    });
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
  const sessionFailed = (
    id: string,
    r: Runtime,
    why: string,
    error?: unknown,
  ) => {
    if (runtimes.get(id) !== r) return;
    log.event('session_failed', {
      output: id,
      generation: r.session,
      reason: why,
      error,
    });
    const e = epoch(id);
    e.failed = true;
    void retire(id, r, 'failed');
    devices.sessionChanged(id, {
      connection: 'failed',
      authentication: 'none',
      error: { code: 'transport_failed', message: 'Speaker connection failed' },
    });
    pauseWithoutPeer();
    if (intent === 'play') scheduleRetry(id);
  };
  const volume = (out: Output, v: View) =>
    out.volume >= 100 ? v.volume : Math.round(out.volume * v.volume / 100);
  const spawnSession = (out: Output) => {
    if (resuming.has(out.id)) return;
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
      resume(out, permission);
      return;
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
        devices.sessionChanged(id, {
          connection: 'disconnected',
          authentication: 'none',
        });
        log.event('preparation_failed', { output: id, error: prepared.error });
        pauseWithoutPeer();
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
        activationCurrent: current,
        session,
        pump: 0,
        connected: false,
        authenticationRequired: false,
        // Retain queue identity for same-entry seeks before CONNECTED is
        // polled. Entry changes during the handshake still absorb the latest
        // item when the connecting generation starts its first pump.
        entry: view.current.id,
        playbackGeneration: view.generation,
        strategy: latestOut.connectionStrategy,
        host: latestOut.host!,
        port: latestOut.port ?? 7000,
        volume: volume(latestOut, view),
        held: false,
      };
      runtimes.set(id, r);
      activated = r;
      const own = () =>
        !closed && runtimes.get(id) === r && r.session === session &&
        r.transport !== null;
      const activationFailed = (why: string, error: unknown) => {
        if (runtimes.get(id) !== r) return;
        if (!current()) {
          // Superseding intent revokes the captured activation authority. It
          // is not a receiver failure and cannot pause or spend output retries.
          // Retire the obsolete runtime before reconciling the current grant.
          void retire(id, r, 'superseded activation');
          return;
        }
        sessionFailed(id, r, why, error);
      };
      try {
        log.event('session_start', {
          output: id,
          generation: session,
          strategy: r.strategy,
          grant: permission.kind,
        });
        const result = await devices.protocol.activate(prepared.value, {
          volume: r.volume,
          positionMs: 0,
          lengthMs: view.itemLengthMs,
          title: queueDisplay(view.current).title ?? '',
          artist: queueDisplay(view.current).artistName ?? '',
        }, {
          publish(transport) {
            r.transport = transport;
            devices.sessionChanged(id, {
              connection: 'connecting',
              authentication: 'none',
            });
          },
          onEvent({ event, value }) {
            if (!own()) {
              return;
            }
            const pin = r.pin;
            if (event === 'credential' && value === 'saved') {
              if (pin?.current()) pin.saved = true;
            }
            if (event === 'state' && value === 'stopped') {
              if (pin?.current()) pin.stopped = true;
            }
            if (pin?.current() && pin.saved && pin.stopped) {
              releasePin(r, pin);
              void controls.changeCredentials(id, async () => {}).catch(
                () => {},
              );
              return;
            }
            if (event === 'state' && value === 'failed') {
              sessionFailed(id, r, 'helper event');
            } else if (event === 'state' && value === 'password') {
              releasePin(r);
              r.connected = false;
              r.authenticationRequired = true;
              // The writer feeds a shared native player, not this speaker's
              // socket. A healthy peer still consumes it while this control
              // session handles authentication; its token releases at close.
              if (!usable()) cancelPump(id, r);
              outputs.update(id, { needsAuthKey: true }, ownedSource);
              devices.sessionChanged(id, {
                connection: 'connecting',
                authentication: 'authentication_required',
              });
              pauseWithoutPeer();
            } else if (event === 'state' && value === 'connected') {
              releasePin(r);
              const wasConnected = r.connected;
              r.connected = true;
              devices.sessionChanged(id, {
                connection: 'connected',
                authentication: 'none',
              });
              if (outputs.get(id)?.needsAuthKey) {
                outputs.update(id, { needsAuthKey: false }, ownedSource);
              }
              r.authenticationRequired = false;
              const latest = playback.playerView();
              if (
                latest.state === 'pause' && lease?.intent === intentEpoch &&
                lease.outputs.get(id) === epoch(id).generation &&
                intent === 'play'
              ) {
                resume(outputs.get(id)!, undefined, r);
                return;
              }
              if (!wasConnected && !r.held && latest.state === 'play') {
                requestPump(id, r);
              }
              // Connected/FLUSH notifications never reset a demand's retry budget.
            }
          },
        });
        if (result.ok) r.activationCurrent = undefined;
        if (!result.ok && runtimes.get(id) === r) {
          activationFailed('activation', result.error);
        }
      } catch (error) {
        activationFailed('spawn', error);
      }
    })().catch((error) =>
      log.event('preparation_error', { output: id, error })
    );
  };
  const idle = (id: string, r: Runtime, choice: ConnectionStrategy) => {
    // An internal no-audio pause retains the challenged control session so its
    // bounded native auth handshake can complete. Explicit Pause/Stop revokes
    // the lease and follows the normal retirement policy.
    if (
      (r.authenticationRequired || resuming.has(id)) && intent === 'play' &&
      (resuming.has(id) ||
        lease?.intent === intentEpoch &&
          lease.outputs.get(id) === epoch(id).generation)
    ) return;
    r.strategy = choice;
    if (!r.transport || CONNECTION_STRATEGIES[choice].idle === 'retire') {
      void retire(id, r, 'idle');
      return;
    }
    if (r.held) return;
    cancelPump(id, r);
    r.held = true;
    r.deadline = performance.now() + HOLD_MS;
    void r.transport!.send({ cmd: 'flush' }).catch((error) => {
      if (runtimes.get(id) === r) sessionFailed(id, r, 'flush', error);
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
    const view = playback.playerView(), snapshot = outputs.list();
    const known = new Set(
      snapshot.filter((o) => o.type === 'AirPlay' && o.host).map((o) => o.id),
    );
    const retirements: [string, Runtime, string][] = [];
    const actions: (() => void)[] = [];
    for (const [id, work] of resuming) {
      if (!work.isCurrent()) revoke(id);
    }
    for (const [id, work] of preparing) {
      const row = outputs.get(id);
      if (!row || row.host !== work.host || row.port !== work.port) {
        // Preparation authority belongs to this endpoint, not just this id.
        revoke(id);
        devices.admission.describe(id);
      }
    }
    for (const [id, work] of pairings) {
      if (!work.controller.signal.aborted && !work.current()) {
        finishPairing(id, work, 'cancelled');
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
      if (pairings.get(id)?.current()) continue;
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
      // A guarded auth resume owns the transition through player.play's
      // synchronous notification. Its continuation binds the new source run;
      // reconciliation must not mistake that intermediate view for a seek.
      if (resuming.get(id)?.runtime === r) continue;
      if (r.activationCurrent && !r.activationCurrent()) {
        // An in-flight activation cannot absorb a newer grant: admission still
        // checks the old demand. Preserve the new grant and release the old
        // runtime before starting its replacement, for every strategy.
        retirements.push([id, r, 'superseded activation']);
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
          r.playbackGeneration !== view.generation)
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
                sessionFailed(id, r, 'flush', error);
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
              sessionFailed(id, r, 'volume', error);
            }
          });
        }
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
      log.event('retry_settings_failed', { error });
    });
  }
  const unsubscribeCommands = outputs.onCommand((id, cmd) => {
    if (cmd.forget) {
      cancelPairing(id);
      revoke(id);
      const runtime = runtimes.get(id);
      const retirement = runtime
        ? retire(id, runtime, 'forget')
        : retiring.get(id);
      return retirement?.then((ok) => {
        if (!ok) throw new Error('Speaker retirement failed');
      });
    }
  });
  const unsubscribe = notify.subscribe((types, keys) => {
    if (
      deps.playerId !== undefined &&
      !types.some((type) =>
        !['player', 'queue', 'volume', 'options'].includes(type) ||
        !keys?.[type] || keys[type].includes(String(deps.playerId))
      )
    ) return;
    consumeCommands();
    reconcile();
  });
  if (startupIds.length) reconcile();
  const controls = {
    async pair(id: string): Promise<SpeakerPairingView> {
      consumeCommands();
      const out = outputs.get(id);
      if (!out) throw new SpeakerError('not_found', 'Speaker not found');
      if (
        closed || blocked.has(id) || retiring.has(id) || runtimes.has(id) ||
        preparing.has(id) || pairings.get(id)?.current()
      ) {
        throw new SpeakerError('speaker_busy', 'Speaker is already in use');
      }
      const incarnation = outputs.revision(id);
      const endpoint = JSON.stringify([out.type, out.host, out.port]);
      const work: PairingWork = {
        controller: new AbortController(),
        view: { state: 'preparing', saved: false },
        saved: false,
        stopped: false,
        current: () => {
          const row = outputs.get(id);
          return !closed && pairings.get(id) === work &&
            !work.controller.signal.aborted &&
            outputs.revision(id) === incarnation && !!row &&
            JSON.stringify([row.type, row.host, row.port]) === endpoint;
        },
      };
      pairings.set(id, work);
      let pending = false, settingsReady = false;
      let failure = 'pairing_unavailable';
      try {
        await (async () => {
          publishPairing(id, work);
          const seconds = deps.state
            ? await deps.state.getTyped('airplay.pairingSeconds') as number
            : 120;
          settingsReady = true;
          if (!work.current()) return;
          work.timer = setTimeout(
            () => finishPairing(id, work, 'failed', 'pairing_timeout'),
            seconds * 1000,
          );
          const prepared = await devices.protocol.prepare({
            id,
            targetRevision: devices.admission.describe(id).targetRevision,
            signal: work.controller.signal,
            isCurrent: work.current,
          });
          if (!work.current()) return;
          if (!prepared.ok || !devices.describe(id).abilities?.pin) {
            throw new SpeakerError(
              'pairing_unavailable',
              'Speaker cannot be prepared for PIN pairing',
            );
          }
          failure = 'pairing_failed';
          const result = await devices.protocol.activate(prepared.value, {
            probe: true,
            volume: 0,
            positionMs: 0,
            lengthMs: 0,
            title: '',
            artist: '',
          }, {
            publish: (transport) => {
              work.transport = transport;
            },
            onEvent({ event, value }) {
              if (!work.current()) return;
              if (event === 'credential' && value === 'unavailable') {
                work.view = {
                  ...work.view,
                  error: {
                    code: 'credential_unavailable',
                    message: 'Pairing credential could not be saved',
                  },
                };
                publishPairing(id, work);
              }
              if (event === 'credential' && value === 'saved') {
                work.saved = true;
              }
              if (event === 'credential' && value === 'cleared') {
                work.saved = false;
              }
              if (event === 'state' && value === 'stopped') work.stopped = true;
              if (work.saved && work.stopped) {
                outputs.update(id, { needsAuthKey: false }, ownedSource);
                finishPairing(id, work, 'complete');
              } else if (event === 'state' && value === 'password') {
                if (work.view.state === 'pairing') {
                  finishPairing(id, work, 'failed', 'pairing_rejected');
                } else {
                  work.view = { state: 'awaiting_pin', saved: false };
                  outputs.update(id, { needsAuthKey: true }, ownedSource);
                  publishPairing(id, work);
                }
              } else if (event === 'state' && value === 'failed') {
                finishPairing(id, work, 'failed', 'pairing_failed');
              }
            },
          });
          // Only a successfully activated operation transfers cleanup to its
          // event/timeout owner. Every other exit finishes in the same finally.
          pending = result.ok && work.current();
        })();
      } catch (error) {
        if (!settingsReady || error instanceof SpeakerError) throw error;
        throw new SpeakerError(
          'pairing_unavailable',
          'Speaker pairing is unavailable',
        );
      } finally {
        if (!pending) {
          const current = work.current();
          finishPairing(
            id,
            work,
            current ? 'failed' : 'cancelled',
            current ? failure : undefined,
          );
        }
      }
      return structuredClone(work.view);
    },
    async submitPin(id: string, pin: string): Promise<SpeakerPairingView> {
      const work = pairings.get(id);
      if (
        !work?.current() || !work.transport ||
        work.view.state !== 'awaiting_pin'
      ) {
        // A current playback authentication challenge is the other entry path.
        // The same private receipt/recycle owner handles its result.
        const runtime = runtimes.get(id);
        if (
          runtime?.authenticationRequired && runtime.transport &&
          !runtime.pin && intent === 'play' && outputs.get(id)?.selected
        ) {
          const demand = intentEpoch, generation = epoch(id).generation;
          const transport = runtime.transport, session = runtime.session;
          const attempt: RuntimePin = {
            saved: false,
            stopped: false,
            current: () =>
              !closed && runtime.pin === attempt &&
              runtimes.get(id) === runtime && runtime.transport === transport &&
              runtime.session === session && runtime.authenticationRequired &&
              intent === 'play' && outputs.get(id)?.selected === true &&
              intentEpoch === demand && epoch(id).generation === generation,
          };
          runtime.pin = attempt;
          let pending = false;
          try {
            const seconds = deps.state
              ? await deps.state.getTyped('airplay.pairingSeconds') as number
              : 120;
            if (!attempt.current()) {
              throw new SpeakerError(
                'pairing_required',
                'Speaker pairing has ended',
              );
            }
            attempt.timer = setTimeout(() => {
              if (attempt.current()) {
                releasePin(runtime, attempt);
                sessionFailed(id, runtime, 'pairing timeout');
              }
            }, seconds * 1000);
            try {
              await transport.send({ cmd: 'pin', pin });
            } catch {
              if (attempt.current()) {
                sessionFailed(id, runtime, 'PIN submission');
              }
              throw new SpeakerError(
                'pairing_unavailable',
                'Speaker PIN could not be submitted',
              );
            }
            pending = attempt.current();
            return { state: 'pairing', saved: false };
          } finally {
            if (!pending) releasePin(runtime, attempt);
          }
        }
        throw new SpeakerError(
          'pairing_required',
          'Begin pairing and wait for the PIN prompt first',
        );
      }
      work.view = { state: 'pairing', saved: false };
      work.stopped = false;
      publishPairing(id, work);
      try {
        await work.transport.send({ cmd: 'pin', pin });
      } catch {
        finishPairing(id, work, 'failed', 'pairing_failed');
        throw new SpeakerError(
          'pairing_unavailable',
          'Speaker PIN could not be submitted',
        );
      }
      return structuredClone(work.view);
    },
    async changeCredentials(id: string, save: () => Promise<void>) {
      consumeCommands();
      cancelPairing(id);
      const out = outputs.get(id);
      if (closed || !out) throw new Error('Speaker lifecycle unavailable');
      const incarnation = outputs.revision(id), demand = intentEpoch;
      const view = playback.playerView();
      const authorized = out.selected && intent === 'play' &&
        (view.state === 'play' || lease?.intent === intentEpoch &&
            lease.outputs.get(id) === epoch(id).generation);
      // Revoke immediately, before encryption/store awaits. A replacement is an
      // explicit credential operation, never a catalog update or a play intent.
      revoke(id);
      const generation = epoch(id).generation;
      if (authorized && lease?.intent === demand) {
        lease.outputs.set(id, generation);
      }
      devices.admission.invalidate(id);
      const runtime = runtimes.get(id);
      const released = runtime
        ? retire(id, runtime, 'credentials')
        : retiring.get(id) ?? Promise.resolve(true);
      if (authorized) pauseWithoutPeer();
      await save();
      if (!await released) {
        throw new Error('Speaker session could not be released');
      }
      consumeCommands();
      const current = outputs.get(id);
      if (
        !closed && authorized && current?.selected &&
        outputs.revision(id) === incarnation && current.host === out.host &&
        current.port === out.port && intent === 'play' &&
        intentEpoch === demand &&
        epoch(id).generation === generation &&
        (playback.playerView().state === 'play' ||
          lease?.intent === demand && lease.outputs.get(id) === generation)
      ) {
        resetDemand(id);
        reconcile();
      }
    },
    async retry(id: string) {
      consumeCommands();
      if (pairings.get(id)?.current()) {
        throw new SpeakerError(
          'speaker_busy',
          'Speaker pairing is in progress',
        );
      }
      const out = outputs.get(id);
      if (closed || !out || out.type !== 'AirPlay') return;
      const e = epoch(id), view = playback.playerView();
      const failedDemand = e.failed && out.selected && intent === 'play' &&
        (view.state === 'play' ||
          (lease?.intent === intentEpoch &&
            lease.outputs.get(id) === e.generation));
      // Only the lifecycle owner can renew a demand or its resume lease.
      // Refreshing facts alone never creates either one.
      if (failedDemand) resetDemand(id);
      else if (preparing.has(id)) {
        preparing.get(id)!.controller.abort();
        preparing.delete(id);
      }
      devices.admission.invalidate(id);
      reconcile();
      if (failedDemand || preparing.has(id)) return;
      const revision = outputs.revision(id);
      const controller = new AbortController();
      // Catalog-only refresh: discard the permit, including on Pause/Stop.
      await devices.protocol.prepare({
        id,
        targetRevision: devices.admission.describe(id).targetRevision,
        refresh: true,
        signal: controller.signal,
        isCurrent: () =>
          !closed && outputs.get(id) !== null &&
          outputs.revision(id) === revision,
      });
    },
    async close() {
      for (const id of pairings.keys()) cancelPairing(id);
      closed = true;
      for (const id of resuming.keys()) cancelResume(id);
      unsubscribe();
      if (typeof unsubscribeCommands === 'function') unsubscribeCommands();
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
      await Promise.all(pumps);
    },
  };
  return controls;
}
