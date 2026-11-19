import { assertEquals } from '@std/assert';
import { recordingStream } from './helpers/airplay-devices.ts';
import type { AirplaySpawn } from '../src/boots/airplay-profile.ts';

Deno.test('recording stream reset fences and joins admitted append and PCM writers', async () => {
  const held = Promise.withResolvers<void>();
  let calls = 0, cancellations = 0;
  const commands: string[] = [];
  const spawn: AirplaySpawn = (event) => ({
    start: () => {
      event('state', 'connected');
      return Promise.resolve();
    },
    transport: {
      send: (command) => {
        commands.push(String(command.cmd));
        return Promise.resolve();
      },
      pcm: async () => {
        calls++;
        if (calls <= 2) await held.promise;
      },
      cancelPcm: () => {
        cancellations++;
      },
      ownsSharedFeed: () => false,
      close: () => Promise.resolve(),
    },
  });
  const stream = recordingStream(spawn)();
  // The fixture start ignores protocol facts: only its connected event matters.
  const peer = stream.attach(() => {});
  // Use the driver via start with facts from the same standard test profile.
  const { profileFromService } = await import(
    '../src/boots/airplay-profile.ts'
  );
  const profile = profileFromService({
    name: 'Fixture',
    host: 'fixture',
    address: '127.0.0.1',
    port: 7000,
    ttlMs: 1000,
    txt: { tp: 'UDP', am: 'AppleTV2,1' },
  });
  await peer.start(profile, {
    volume: 50,
    positionMs: 0,
    lengthMs: 1000,
    title: '',
    artist: '',
  });
  const oldAppend = stream.append({
    epoch: stream.epoch,
    segment: 1n,
    pcm: new Uint8Array(4),
  });
  const oldPcm = stream.pcm(new Uint8Array(4));
  await Promise.resolve();
  let resetDone = false;
  const reset = stream.reset().then(() => {
    resetDone = true;
  });
  try {
    await new Promise((done) => setTimeout(done, 20));
    assertEquals(calls, 2);
    assertEquals(cancellations, 1);
    assertEquals(resetDone, false, 'void cancel is not writer settlement');
    const replacement = stream.pcm(new Uint8Array(4));
    await new Promise((done) => setTimeout(done, 20));
    assertEquals(calls, 2, 'replacement input waits behind reset');
    held.resolve();
    await Promise.all([oldAppend, oldPcm, reset, replacement]);
    assertEquals(calls, 3);
    const canceled = stream.cancel(stream.epoch);
    assertEquals(commands, ['flush'], 'control submits at the input fence');
    await canceled;
  } finally {
    held.resolve();
    await Promise.all([oldAppend, oldPcm, reset]);
    await stream.close();
  }
});
