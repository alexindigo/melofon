// Explicit acquired receiver facts for lifecycle tests; never production fallback.
import type { Outputs } from '../../src/player.ts';
import { createAirplayDevices } from '../../src/boots/airplay-device.ts';
import {
  type AirplaySpawn,
  airplayStartFields,
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

export function createTestAirplayDevices(
  outputs: Outputs,
  spawn?: AirplaySpawn,
) {
  return createAirplayDevices({
    outputs,
    ...(spawn === undefined ? {} : { spawn }),
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
