// Explicit acquired receiver facts for lifecycle tests; never production fallback.
import type { Outputs } from '../../src/player.ts';
import { createAirplayDevices } from '../../src/boots/airplay-device.ts';
import {
  type AirplaySpawn,
  airplayStartFields,
  type AirplayStream,
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
export function recordingStream(spawn: AirplaySpawn): () => AirplayStream {
  let incarnation = 0n;
  return () => {
    const id = ++incarnation;
    type Peer = {
      transport: AirplayTransport;
      ready: boolean;
      close(): Promise<void>;
    };
    const peers = new Set<Peer>();
    const cancelPcm = () => {
      for (const peer of peers) peer.transport.cancelPcm();
    };
    return {
      id,
      attach(event, credential) {
        let closing: Promise<void> | undefined;
        const peer: Peer = {
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
          id: ++incarnation,
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
  };
}

/** Apply attachment instrumentation to the real stream without replacing its
 * input or native identity. */
export function mapStream(
  factory: () => AirplayStream,
  wrap: (spawn: AirplaySpawn) => AirplaySpawn,
): () => AirplayStream {
  return () => {
    const stream = factory();
    return {
      ...stream,
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
  stream?: () => AirplayStream,
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
