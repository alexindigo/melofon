// Explicit acquired receiver facts for lifecycle tests; never production fallback.
import type { Outputs } from '../../src/player.ts';
import { createAirplayDevices } from '../../src/boots/airplay-device.ts';
import {
  type AirplayCompletionKey,
  type AirplayExactStream,
  type AirplaySourceSnapshot,
  type AirplaySpawn,
  airplayStartFields,
  type AirplayStream,
  type AirplayTimelineStream,
  type AirplayTransport,
  type HelperEventFn,
} from '../../src/boots/airplay-profile.ts';

interface RecordedTransport extends AirplayTransport {
  send(command: Record<string, unknown>): Promise<void>;
}
export function recordingSpawn(
  spawn: (event: HelperEventFn) => RecordedTransport,
): AirplaySpawn {
  return (event) => {
    const transport = spawn(event);
    return {
      transport,
      start: (profile, input) =>
        transport.send(airplayStartFields(profile, input)),
    };
  };
}

/** Lifecycle-test stream: one input, fanout to connected fake attachments. The
 * attachment's PCM recorder observes delivery, never source election. Native
 * fixtures supply createFfiStream explicitly instead. */
export function recordingStream(
  spawn: AirplaySpawn,
): () => AirplayTimelineStream {
  let incarnation = 0n;
  return () => {
    const id = ++incarnation;
    let epoch = 1n;
    type Peer = {
      id: bigint;
      transport: AirplayTransport;
      ready: boolean;
      close(): Promise<void>;
    };
    const peers = new Set<Peer>();
    const sources = new Map<bigint, AirplaySourceSnapshot>();
    let inputFrames = 0n;
    const cancelPcm = () => {
      for (const peer of peers) peer.transport.cancelPcm();
    };
    // Explicit lifecycle recorder, not native scheduled-consumer evidence. Its
    // fake attachments accept synchronously and have no transport schedule.
    const completion = (key: AirplayCompletionKey) => ({
      ...key,
      streamId: id,
      inputEnd: sources.get(key.source)?.inputEnd ?? 0n,
      status: key.epoch === epoch ? 'complete' as const : 'canceled' as const,
      error: 'none' as const,
      transportEnd: inputFrames,
      capturedNs: 0n,
      required: BigInt(peers.size),
      attachments: [],
    });
    const api: AirplayTimelineStream = {
      id,
      get epoch() {
        return epoch;
      },
      async append(input) {
        if (input.epoch !== epoch) {
          return {
            streamId: id,
            epoch: input.epoch,
            segment: input.segment,
            acceptedFrames: 0n,
            status: 'canceled',
          };
        }
        await Promise.all(
          [...peers].filter((p) => p.ready).map((p) =>
            p.transport.pcm(input.pcm)
          ),
        );
        return {
          streamId: id,
          epoch: input.epoch,
          segment: input.segment,
          acceptedFrames: BigInt(input.pcm.length / 4),
          status: 'accepted',
        };
      },
      async appendSource(input) {
        const previous = sources.get(input.source)?.acceptedFrames ?? 0n;
        const receipt = await api.append(input);
        const inputOffset = inputFrames;
        inputFrames += receipt.acceptedFrames;
        if (receipt.acceptedFrames) {
          sources.set(input.source, {
            streamId: id,
            epoch: input.epoch,
            source: input.source,
            acceptedFrames: previous + receipt.acceptedFrames,
            fedFrames: previous + receipt.acceptedFrames,
            sealed: false,
            target: null,
            inputEnd: null,
          });
        }
        return {
          ...receipt,
          source: input.source,
          sourceOffset: previous,
          inputOffset,
        };
      },
      seal(captured, source, target) {
        const record = sources.get(source);
        if (!record || record.acceptedFrames !== target) {
          throw new Error('invalid fixture seal');
        }
        sources.set(source, {
          ...record,
          sealed: true,
          target,
          inputEnd: inputFrames,
        });
        return Promise.resolve({
          streamId: id,
          epoch: captured,
          source,
          target,
          inputEnd: inputFrames,
          status: 'accepted' as const,
        });
      },
      endStream: (captured, target) =>
        Promise.resolve({
          streamId: id,
          epoch: captured,
          source: 0n,
          target,
          inputEnd: target,
          status: 'accepted',
        }),
      compatibilitySilence: () => Promise.resolve(),
      source: (_epoch, source) => Promise.resolve(sources.get(source) ?? null),
      range: () => Promise.resolve(null),
      progress: () => Promise.resolve(null),
      pollCompletion: (key) => Promise.resolve(completion(key)),
      waitCompletion: (key) => Promise.resolve(completion(key)),
      reviseCompletion: (key) =>
        Promise.resolve({ ...key, revision: key.revision + 1n }),
      ackCompletion: (key) => {
        sources.delete(key.source);
        return Promise.resolve();
      },
      async cancelSource(captured, source, retire, capture) {
        const ready = api.cancel(captured, retire);
        const cutoff = {
          streamId: id,
          epoch: captured,
          nextEpoch: captured + 1n,
          admittedNs: 0n,
          source,
          // This lifecycle recorder has no presentation schedule. Its explicit
          // unobserved zero prefix is not accepted PCM masquerading as playback.
          progress: {
            streamId: id,
            epoch: captured,
            source,
            attachment: 0n,
            capturedNs: 0n,
            status: 'waiting' as const,
            error: 'none' as const,
            participants: 0n,
            coverageStart: 0n,
            submittedFrames: 0n,
            scheduledFrames: 0n,
            scheduleOriginNs: 0n,
            fedFrames: 0n,
            realFrames: 0n,
            silenceFrames: 0n,
            sourceFrames: 0n,
          },
        };
        await Promise.resolve();
        let failure: { error: unknown } | undefined;
        try {
          capture?.(cutoff);
        } catch (error) {
          failure = { error };
        }
        const result = await ready;
        if (failure) throw failure.error;
        return { ...result, source, progress: cutoff.progress };
      },
      async cancel(captured, retire = []) {
        if (epoch !== captured) throw new Error('stale fixture epoch');
        epoch++;
        inputFrames = 0n;
        cancelPcm();
        await Promise.all(
          [...peers].map((p) =>
            retire.includes(p.id)
              ? p.close()
              : p.ready
              ? p.transport.send({ cmd: 'flush' })
              : Promise.resolve()
          ),
        );
        return {
          streamId: id,
          epoch: captured,
          nextEpoch: captured + 1n,
          status: epoch === captured + 1n ? 'ready' : 'canceled',
          cutoffFrames: 0n,
          admittedNs: 0n,
        };
      },
      ackCancel: () => Promise.resolve(),
      attach(event, credential) {
        let closing: Promise<void> | undefined;
        const peer: Peer = {
          id: ++incarnation,
          transport: null as unknown as AirplayTransport,
          ready: false,
          close: () =>
            closing ??= (async () => {
              peer.ready = false;
              await peer.transport.close();
              peers.delete(peer);
            })(),
        };
        const driver = spawn((name, value) => {
          if (name === 'state') peer.ready = value === 'connected';
          event(name, value);
        }, credential);
        const transport: AirplayTransport = {
          send(command) {
            if (command.cmd === 'teardown') peer.ready = false;
            return driver.transport.send(command);
          },
          pcm: () =>
            Promise.reject(new Error('attachment PCM is not an input')),
          ownsSharedFeed: () => false,
          cancelPcm() {},
          close: peer.close,
        };
        peer.transport = driver.transport;
        peers.add(peer);
        return {
          id: peer.id,
          streamId: id,
          transport,
          start: driver.start,
        };
      },
      async pcm(chunk) {
        await Promise.all(
          [...peers].filter((p) => p.ready).map((p) => p.transport.pcm(chunk)),
        );
      },
      cancelPcm,
      reset() {
        cancelPcm();
        return Promise.resolve();
      },
      async close() {
        cancelPcm();
        await Promise.all([...peers].map((p) => p.close()));
      },
    };
    return api;
  };
}

/** Apply attachment instrumentation to the real stream without replacing its
 * input or native identity. */
export function mapStream(
  factory: () => AirplayExactStream,
  wrap: (spawn: AirplaySpawn) => AirplaySpawn,
): () => AirplayExactStream {
  return () => {
    const stream = factory();
    return {
      ...stream,
      get epoch() {
        return stream.epoch;
      },
      attach(...args) {
        let attached: ReturnType<AirplayStream['attach']> | undefined;
        const driver = wrap((...input) => attached = stream.attach(...input))(
          ...args,
        );
        if (!attached) {
          throw new Error('instrumentation did not acquire attachment');
        }
        return { ...attached, ...driver };
      },
    };
  };
}

/** Direct-device lifecycle fixtures opt in to a matching fake stream as well as
 * fake attachments. Omitted spawn/stream retain the actual production backend. */
export function createRecordingAirplayDevices(
  deps: Parameters<typeof createAirplayDevices>[0],
) {
  return createAirplayDevices({
    ...deps,
    ...(deps.spawn && !deps.stream
      ? { stream: recordingStream(deps.spawn) }
      : {}),
  });
}

export function createTestAirplayDevices(
  outputs: Outputs,
  spawn?: AirplaySpawn,
  stream?: () => AirplayExactStream,
) {
  return createAirplayDevices({
    outputs,
    ...(spawn === undefined ? {} : { spawn }),
    ...(stream ? { stream } : spawn ? { stream: recordingStream(spawn) } : {}),
    resolver: {
      resolve(host, port, signal) {
        if (signal?.aborted) {
          return Promise.reject(new Error('fixture lookup cancelled'));
        }
        const row = outputs.list().find((o) =>
          o.host === host && (port === undefined || o.port === port)
        );
        return Promise.resolve({
          name: `001122334455@${row?.name ?? 'test'}._raop._tcp.local`,
          host: 'fixture.local',
          address: host,
          port: port ?? 7000,
          ttlMs: 3600000,
          txt: {
            tp: 'UDP',
            am: row?.model ?? 'AppleTV2,1',
            sr: '44100',
            ss: '16',
            ch: '2',
          },
        });
      },
      close() {},
    },
  });
}
