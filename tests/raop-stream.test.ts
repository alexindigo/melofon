import { assert, assertEquals, assertRejects, assertThrows } from '@std/assert';
import {
  createFfiSpawn,
  createFfiStream,
  raopFfiInternals,
} from '../src/boots/raop-ffi.ts';
import { profileFromService } from '../src/boots/airplay-profile.ts';
import type {
  AirplayExactStream,
  AirplayPlaybackStream,
  AirplayStream,
  AirplayTransport,
} from '../src/boots/airplay-profile.ts';
import { createAirplayDevices } from '../src/boots/airplay-device.ts';
import { createOutputs } from '../src/player.ts';
import type { PlaybackCapacity } from '../src/playback-capacity.ts';
import { startFakeRaop } from './helpers/fake-raop.ts';
import { decodeReceiverAudio } from './helpers/raop-audio-consumer.ts';
import { renderScheduledAudio } from './helpers/raop-scheduled-consumer.ts';

const input = {
  volume: 50,
  positionMs: 0,
  lengthMs: 1000,
  title: '',
  artist: '',
};
const pause = () => new Promise((resolve) => setTimeout(resolve, 5));
async function until(what: string, predicate: () => boolean) {
  const deadline = performance.now() + 15000;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error(`timed out: ${what}`);
    await pause();
  }
}
function pcm(frames: number) {
  const bytes = new Uint8Array(frames * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < frames; i++) {
    view.setInt16(i * 4, -15000 + i * 17, true);
    view.setInt16(i * 4 + 2, 14000 - i * 19, true);
  }
  return bytes;
}
type Receiver = Awaited<ReturnType<typeof startFakeRaop>>;
function timestamps(fake: Receiver) {
  return fake.sessions[0].wire.flatMap((event) =>
    event.kind === 'audio'
      ? [
        new DataView(
          event.data.buffer,
          event.data.byteOffset,
          event.data.byteLength,
        ).getUint32(4),
      ]
      : []
  );
}
function profile(fake: Receiver) {
  return profileFromService({
    name: '001122334455@Stream._raop._tcp.local',
    host: 'fixture.local',
    address: '127.0.0.1',
    port: fake.port,
    ttlMs: 60000,
    txt: { tp: 'UDP', am: 'AppleTV2,1' },
  });
}
async function libraryProof() {
  const expected = await Deno.realPath(
    new URL('../helper/raop/libmelofon_raop.so', import.meta.url),
  );
  assertEquals(
    await Deno.realPath(Deno.env.get('MELOFON_RAOP_LIB')!),
    expected,
  );
  assert(
    (await Deno.readTextFile('/proc/self/maps')).split('\n').some((line) =>
      line.endsWith(` ${expected}`)
    ),
  );
  const hash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', await Deno.readFile(expected)),
  );
  console.log(
    `stream native library: ${expected} sha256=${
      Array.from(hash, (v) => v.toString(16).padStart(2, '0')).join('')
    }`,
  );
}
async function rendered(fake: Receiver, expected: Uint8Array) {
  const session = fake.sessions[0];
  await until(
    'audio and independent timing mapping',
    () =>
      session.audioPackets >= expected.length / (352 * 4) &&
      session.wire.some((event) => event.kind === 'timing-reply'),
  );
  assertEquals(
    decodeReceiverAudio(session.sdp, session.audioPayloads),
    expected,
  );
  const pending = renderScheduledAudio(session, fake.nowMs());
  assertEquals(pending.issues, []);
  assert(pending.lastPresentationAtMs !== null);
  assert(pending.clockUncertaintyMs !== null);
  await until(
    'scheduled real-frame boundary',
    () =>
      fake.nowMs() >
        pending.lastPresentationAtMs! + pending.clockUncertaintyMs!,
  );
  const result = renderScheduledAudio(session, fake.nowMs());
  assertEquals(result.issues, []);
  assertEquals(result.pcm, expected);
  assertEquals(result.pendingFrames, 0);
  assertEquals(result.discarded, []);
  assertEquals(session.flushes, 0);
  assertEquals(session.teardowns, 0);
  assertEquals(fake.sessions.length, 1);
}

Deno.test({
  name:
    'RAOP compatibility: competing input rejects instead of silently dropping PCM',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const a = await startFakeRaop({ captureAudio: true, captureWire: true });
    const b = await startFakeRaop({ captureAudio: true, captureWire: true });
    let connected = 0;
    const event = (kind: string, value?: string) => {
      if (kind === 'state' && value === 'connected') connected++;
    };
    const spawn = createFfiSpawn();
    const first = spawn(event), second = spawn(event);
    try {
      await Promise.all([
        first.start(profile(a), input),
        second.start(profile(b), input),
      ]);
      await until('two compatibility attachments', () => connected === 2);
      await first.transport.pcm(pcm(704));
      await assertRejects(
        () => second.transport.pcm(new Uint8Array(704 * 4)),
        Error,
        'compatibility input busy',
      );
      await Promise.all([rendered(a, pcm(704)), rendered(b, pcm(704))]);
      await libraryProof();
    } finally {
      await Promise.all([first.transport.close(), second.transport.close()]);
      a.close();
      b.close();
    }
  },
});

Deno.test({
  name: 'RAOP stream: one input fans exact scheduled PCM to two attachments',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const stream = createFfiStream();
    const a = await startFakeRaop({ captureAudio: true, captureWire: true });
    const b = await startFakeRaop({ captureAudio: true, captureWire: true });
    let connected = 0;
    const event = (kind: string, value?: string) => {
      if (kind === 'state' && value === 'connected') connected++;
    };
    const first = stream.attach(event), second = stream.attach(event);
    try {
      assertEquals(typeof stream.id, 'bigint');
      assert(stream.id > 1n);
      assert(first.id !== second.id && first.id > 0n);
      assertEquals(first.streamId, stream.id);
      assertEquals(second.streamId, stream.id);
      await Promise.all([
        first.start(profile(a), input),
        second.start(profile(b), input),
      ]);
      await until('two ready attachments', () => connected === 2);
      await assertRejects(
        () => first.transport.pcm(pcm(352)),
        Error,
        'belongs to the RAOP stream',
      );
      await stream.pcm(pcm(704));
      await Promise.all([rendered(a, pcm(704)), rendered(b, pcm(704))]);
      assertEquals(timestamps(a), timestamps(b));
      await libraryProof();
    } finally {
      await stream.close();
      a.close();
      b.close();
    }
  },
});

for (const removed of [0, 1]) {
  Deno.test({
    name: `RAOP stream: detach attachment ${
      removed + 1
    } preserves shared partial PCM and PTS`,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      const stream = createFfiStream();
      const receivers = await Promise.all(
        [0, 1].map(() =>
          startFakeRaop({ captureAudio: true, captureWire: true })
        ),
      );
      let connected = 0;
      const attachments = receivers.map(() =>
        stream.attach((kind, value) => {
          if (kind === 'state' && value === 'connected') connected++;
        })
      );
      try {
        await Promise.all(
          attachments.map((attachment, i) =>
            attachment.start(profile(receivers[i]), input)
          ),
        );
        await until('two ready attachments', () => connected === 2);
        const expected = pcm(704);
        // Exactly one native 441-frame tick: one 352-frame ALAC packet plus an
        // 89-frame partial block. Detach must never discard that shared tail.
        await stream.pcm(expected.subarray(0, 441 * 4));
        await until(
          'both receivers got the first packet',
          () => receivers.every((r) => r.sessions[0]?.audioPackets === 1),
        );
        const survivor = receivers[1 - removed];
        const originalTimestamp = timestamps(survivor)[0];
        await attachments[removed].transport.close();
        await until(
          'removed attachment locally closed',
          () => receivers[removed].sessions[0].closedAtMs !== null,
        );
        await stream.pcm(expected.subarray(441 * 4));
        await rendered(survivor, expected);
        assertEquals(timestamps(survivor)[1], (originalTimestamp + 352) >>> 0);
        assertEquals(receivers[removed].sessions[0].audioPackets, 1);
        await libraryProof();
      } finally {
        await stream.close();
        for (const receiver of receivers) receiver.close();
      }
    },
  });
}

Deno.test({
  name:
    'RAOP stream: concurrent explicit and compatibility contexts cannot cross-feed',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const a = createFfiStream(), b = createFfiStream();
    const first = await startFakeRaop({
      captureAudio: true,
      captureWire: true,
    });
    const refused = await startFakeRaop({
      captureAudio: true,
      captureWire: true,
    });
    const compatibility = await startFakeRaop({
      captureAudio: true,
      captureWire: true,
    });
    let ready = false;
    const owner = a.attach((kind, value) => {
      if (kind === 'state' && value === 'connected') ready = true;
    });
    let otherReady = false, legacyReady = false;
    const dormant = b.attach((kind, value) => {
      if (kind === 'state' && value === 'connected') otherReady = true;
    });
    const legacy = createFfiSpawn()((kind, value) => {
      if (kind === 'state' && value === 'connected') legacyReady = true;
    });
    try {
      assert(b.id > a.id);
      await owner.start(profile(first), input);
      await until('active owner ready', () => ready);
      await dormant.start(profile(refused), input);
      await legacy.start(profile(compatibility), input);
      await until(
        'independent contexts ready',
        () => otherReady && legacyReady,
      );
      const otherPcm = new Uint8Array(352 * 500 * 4).fill(0x35);
      const legacyPcm = new Uint8Array(704 * 4).fill(0x61);
      await a.pcm(pcm(704));
      await b.pcm(otherPcm);
      await legacy.transport.pcm(legacyPcm);
      await Promise.all([
        rendered(first, pcm(704)),
        rendered(compatibility, legacyPcm),
      ]);
      await until(
        'B initial PCM before A close',
        () => refused.sessions[0].audioPayloads.length >= 2,
      );
      assertEquals(
        decodeReceiverAudio(
          refused.sessions[0].sdp,
          refused.sessions[0].audioPayloads.slice(0, 2),
        ),
        otherPcm.subarray(0, 704 * 4),
      );
      await owner.transport.close();
      await a.close();
      const continuation = new Uint8Array(704 * 4).fill(0x72);
      await b.pcm(continuation);
      const combined = new Uint8Array(otherPcm.length + continuation.length);
      combined.set(otherPcm);
      combined.set(continuation, otherPcm.length);
      await rendered(refused, combined);
      assertEquals(refused.sessions.length, 1);
      await libraryProof();
    } finally {
      await Promise.all([a.close(), b.close(), legacy.transport.close()]);
      first.close();
      refused.close();
      compatibility.close();
    }
  },
});

Deno.test({
  name:
    'RAOP stream: explicit activation is independent of an existing compatibility owner',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const stream = createFfiStream();
    const receiver = await startFakeRaop({
      captureAudio: true,
      captureWire: true,
    });
    const refused = await startFakeRaop({
      captureAudio: true,
      captureWire: true,
    });
    let ready = false;
    const legacy = createFfiSpawn()((kind, value) => {
      if (kind === 'state' && value === 'connected') ready = true;
    });
    let explicitReady = false;
    const attachment = stream.attach((kind, value) => {
      if (kind === 'state' && value === 'connected') explicitReady = true;
    });
    try {
      await legacy.start(profile(receiver), input);
      await until('compatibility owner ready', () => ready);
      await attachment.start(profile(refused), input);
      await until('explicit context ready', () => explicitReady);
      const explicitPcm = new Uint8Array(704 * 4).fill(0x42);
      await stream.pcm(explicitPcm);
      await legacy.transport.pcm(pcm(704));
      await Promise.all([
        rendered(receiver, pcm(704)),
        rendered(refused, explicitPcm),
      ]);
      await libraryProof();
    } finally {
      await stream.close();
      await legacy.transport.close();
      receiver.close();
      refused.close();
    }
  },
});

Deno.test({
  name:
    'RAOP stream: retained attachments prevent native free and dormant streams retain runtime',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const lib = raopFfiInternals.loadLibrary();
    const raw = lib.symbols.raop_stream_new();
    assert(raw);
    const id = lib.symbols.raop_stream_id(raw);
    const attachment = lib.symbols.raop_stream_attach(raw);
    assert(attachment);
    assertEquals(await lib.symbols.raop_stream_free(raw), -2);
    assertEquals(lib.symbols.raop_stream_id(raw), id);
    assertEquals(await lib.symbols.raop_free(attachment), 0);
    // The last device is gone, but its stream still owns the event loop/player.
    assertEquals(lib.symbols.raop_stream_write(raw, pcm(1), 4n), 4);
    assertEquals(lib.symbols.raop_stream_write(raw, pcm(1), 3n), -1);
    await libraryProof();
    assertEquals(await lib.symbols.raop_stream_free(raw), 0);
  },
});

Deno.test({
  name:
    'RAOP stream: close cancels and joins a backpressured producer before freeing',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const stream = createFfiStream();
    await assertRejects(
      () => stream.pcm(new Uint8Array(3)),
      Error,
      'whole stereo frames',
    );
    const pending = stream.pcm(new Uint8Array((2 * 44100 + 1) * 4));
    const rejected = assertRejects(() => pending, Error, 'producer canceled');
    await libraryProof();
    const closing = stream.close();
    assertEquals(stream.close(), closing);
    await rejected;
    await closing;
    assertThrows(() => stream.attach(() => {}), Error, 'closed');
    await assertRejects(() => stream.pcm(pcm(1)), Error, 'closed');
  },
});

Deno.test({
  name:
    'RAOP stream reset: fences blocked writers and preserves queued replacement input',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const stream = createFfiStream();
    const receiver = await startFakeRaop({
      captureAudio: true,
      captureWire: true,
    });
    let ready = false, settled = false;
    const attachment = stream.attach((kind, value) => {
      if (kind === 'state' && value === 'connected') ready = true;
    });
    try {
      // With no ready receiver the two-second ingress cannot drain. This write
      // accepts a prefix then remains blocked, rather than being a mock waiter.
      const old = stream.pcm(new Uint8Array((2 * 44100 + 1) * 4).fill(0x37));
      const canceled = assertRejects(() => old, Error, 'producer canceled')
        .then(() => settled = true);
      await pause();
      assertEquals(settled, false);
      const reset = stream.reset();
      const replacement = stream.pcm(pcm(704));
      await reset;
      assertEquals(settled, true, 'reset joins the canceled native writer');
      await replacement;
      await attachment.start(profile(receiver), input);
      await until('replacement receiver ready', () => ready);
      await rendered(receiver, pcm(704));
      await canceled;
      await libraryProof();
    } finally {
      await stream.close();
      receiver.close();
    }
  },
});

Deno.test({
  name:
    'RAOP stream reset: discards active partial PCM without reopening attachments',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const stream = createFfiStream();
    const receiver = await startFakeRaop({
      captureAudio: true,
      captureWire: true,
    });
    let ready = false;
    const attachment = stream.attach((kind, value) => {
      if (kind === 'state' && value === 'connected') ready = true;
    });
    try {
      await attachment.start(profile(receiver), input);
      await until('active receiver ready', () => ready);
      const old = pcm(441);
      await stream.pcm(old);
      // A full 441-frame tick has emitted 352 and retained 89 in the master.
      await rendered(receiver, old.subarray(0, 352 * 4));
      await stream.reset();
      const replacement = new Uint8Array(704 * 4).fill(0x59);
      await stream.pcm(replacement);
      await until(
        'replacement packets',
        () => receiver.sessions[0].audioPackets === 3,
      );
      const expected = new Uint8Array((352 + 704) * 4);
      expected.set(old.subarray(0, 352 * 4));
      expected.set(replacement, 352 * 4);
      const session = receiver.sessions[0];
      assertEquals(
        decodeReceiverAudio(session.sdp, session.audioPayloads),
        expected,
      );
      assertEquals(receiver.sessions.length, 1);
      assertEquals(session.flushes, 0, 'local reset is not receiver FLUSH');
      assertEquals(session.teardowns, 0);
      await libraryProof();
      // Local reset must synchronize the pacer's new anchor on the wire too.
      // It still neither retracts old wire packets nor proves FLUSH readiness.
      await rendered(receiver, expected);
      const progress = (await stream.progress(stream.epoch))!;
      assertEquals(progress.error, 'none');
      assertEquals(progress.coverageStart, 352n);
      assertEquals(progress.submittedFrames, 1056n);
      assertEquals(progress.scheduledFrames, 1056n);
    } finally {
      await stream.close();
      receiver.close();
    }
  },
});

Deno.test({
  name: 'RAOP stream reset: consecutive resets cancel intervening queued input',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const stream = createFfiStream();
    const receiver = await startFakeRaop({
      captureAudio: true,
      captureWire: true,
    });
    let ready = false;
    const attachment = stream.attach((kind, value) => {
      if (kind === 'state' && value === 'connected') ready = true;
    });
    try {
      const first = stream.reset();
      const stale = stream.pcm(new Uint8Array(352 * 4).fill(0x71));
      const rejected = assertRejects(() => stale, Error, 'producer canceled');
      const second = stream.reset();
      const replacement = stream.pcm(pcm(704));
      await Promise.all([first, second, rejected, replacement]);
      await attachment.start(profile(receiver), input);
      await until('receiver ready after serialized resets', () => ready);
      await rendered(receiver, pcm(704));
      await libraryProof();
    } finally {
      await stream.close();
      receiver.close();
    }
  },
});

Deno.test({
  name:
    'RAOP stream reset: dormant reset leaves another stream partial PCM and PTS intact',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const active = createFfiStream(), dormant = createFfiStream();
    const receiver = await startFakeRaop({
      captureAudio: true,
      captureWire: true,
    });
    let ready = false;
    const attachment = active.attach((kind, value) => {
      if (kind === 'state' && value === 'connected') ready = true;
    });
    try {
      await attachment.start(profile(receiver), input);
      await until('active stream ready', () => ready);
      const expected = pcm(704);
      await active.pcm(expected.subarray(0, 441 * 4));
      await until(
        'active partial block',
        () => receiver.sessions[0].audioPackets === 1,
      );
      const before = timestamps(receiver)[0];
      await dormant.reset();
      await dormant.pcm(pcm(352));
      await active.pcm(expected.subarray(441 * 4));
      await rendered(receiver, expected);
      assertEquals(timestamps(receiver)[1], (before + 352) >>> 0);
      await libraryProof();
    } finally {
      await Promise.all([active.close(), dormant.close()]);
      receiver.close();
    }
  },
});

Deno.test({
  name:
    'RAOP stream reset: close joins admitted reset and rejects later admission',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const stream = createFfiStream();
    const writing = stream.pcm(new Uint8Array((2 * 44100 + 1) * 4));
    const canceled = assertRejects(() => writing, Error, 'producer canceled');
    await pause();
    const reset = stream.reset();
    const closing = stream.close();
    assertEquals(stream.close(), closing);
    await Promise.all([reset, canceled, closing]);
    await assertRejects(() => stream.reset(), Error, 'closed');
    await assertRejects(() => stream.pcm(pcm(352)), Error, 'closed');
    await libraryProof();
  },
});

function deviceFixture(
  receivers: Receiver[],
  options: Partial<Parameters<typeof createAirplayDevices>[0]> = {},
) {
  const outputs = createOutputs();
  for (const [i, receiver] of receivers.entries()) {
    outputs.register({
      id: String(i + 1),
      name: `Stream receiver ${i + 1}`,
      type: 'AirPlay',
      host: '127.0.0.1',
      port: receiver.port,
      selected: true,
      volume: 50,
      receiverIdentity: BigInt(`0x00112233440${i}`).toString(10),
    });
  }
  const devices = createAirplayDevices({
    outputs,
    resolver: {
      resolve(_host, port) {
        const i = receivers.findIndex((r) => r.port === port);
        return Promise.resolve({
          name: `00112233440${i}@Stream._raop._tcp.local`,
          host: 'fixture.local',
          address: '127.0.0.1',
          port: port!,
          ttlMs: 60000,
          txt: { tp: 'UDP', am: 'AppleTV2,1' },
        });
      },
      close() {},
    },
    ...options,
  });
  const retained = [0, 0];
  const capacities = [1, 2].map((id, index) => {
    const port = devices.capacity.forPlayer(() => ({
      id,
      name: `Stream player ${id}`,
    }));
    return {
      ...port,
      retain() {
        const token = port.retain();
        retained[index]++;
        let released = false;
        return {
          release() {
            if (released) return;
            released = true;
            retained[index]--;
            token.release();
          },
        };
      },
    };
  });
  const prepare = (
    index: number,
    stream: AirplayPlaybackStream,
    capacity?: PlaybackCapacity,
  ) =>
    devices.protocol.prepare({
      id: String(index + 1),
      targetRevision:
        devices.admission.describe(String(index + 1)).targetRevision,
      signal: new AbortController().signal,
      isCurrent: () => true,
      stream,
      capacity,
    });
  const activate = async (
    index: number,
    stream: AirplayPlaybackStream,
    capacity?: PlaybackCapacity,
  ) => {
    const permit = await prepare(index, stream, capacity);
    assert(permit.ok, permit.ok ? '' : permit.error.message);
    let ready = false;
    const result = await devices.protocol.activate(permit.value, input, {
      publish() {},
      onEvent(kind) {
        if (kind.event === 'state' && kind.value === 'connected') ready = true;
      },
    });
    assert(result.ok, result.ok ? '' : result.error.message);
    await until('admitted attachment connected', () => ready);
    return result.value;
  };
  return { outputs, devices, capacities, retained, prepare, activate };
}

for (const removed of [null, 0, 1]) {
  Deno.test({
    name: removed === null
      ? 'RAOP device stream: admission binds two exact scheduled consumers'
      : `RAOP device stream: admitted detach ${
        removed + 1
      } keeps partial PCM and PTS`,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      const receivers = await Promise.all(
        [0, 1].map(() =>
          startFakeRaop({ captureAudio: true, captureWire: true })
        ),
      );
      let allocations = 0;
      const f = deviceFixture(receivers, {
        stream() {
          allocations++;
          return createFfiStream();
        },
        spawn() {
          throw new Error(
            'explicit admission must not use compatibility spawn',
          );
        },
      });
      const demand = f.capacities[0].reserve();
      const stream = f.devices.createStream(f.capacities[0]);
      try {
        assertEquals(stream.id, null);
        assertEquals(
          allocations,
          0,
          'construction does not allocate native state',
        );
        const attachments = await Promise.all(
          [0, 1].map((i) => f.activate(i, stream, f.capacities[0])),
        );
        assertEquals(allocations, 1);
        assertEquals(typeof stream.id, 'bigint');
        await assertRejects(
          () => attachments[0].pcm(pcm(352)),
          Error,
          'belongs to the RAOP stream',
        );
        const expected = pcm(704);
        if (removed === null) {
          await stream.pcm(expected);
          await Promise.all(receivers.map((r) => rendered(r, expected)));
          assertEquals(timestamps(receivers[0]), timestamps(receivers[1]));
        } else {
          await stream.pcm(expected.subarray(0, 441 * 4));
          await until(
            'both admitted receivers got first packet',
            () => receivers.every((r) => r.sessions[0]?.audioPackets === 1),
          );
          const survivor = receivers[1 - removed];
          const firstTimestamp = timestamps(survivor)[0];
          await attachments[removed].close();
          await stream.pcm(expected.subarray(441 * 4));
          await rendered(survivor, expected);
          assertEquals(timestamps(survivor)[1], (firstTimestamp + 352) >>> 0);
          assertEquals(receivers[removed].sessions[0].audioPackets, 1);
        }
        await libraryProof();
        await Promise.all(attachments.map((attachment) => attachment.close()));
        demand.release();
        assertEquals(
          f.retained,
          [1, 0],
          'last attachment is not native storage release',
        );
        f.capacities[1].reserve().release();
        const closing = stream.close();
        assertEquals(stream.close(), closing);
        await closing;
        assertEquals(f.retained, [0, 0]);
        f.capacities[1].reserve().release();
        await assertRejects(() => stream.pcm(pcm(1)), Error, 'closed');
      } finally {
        demand.release();
        await stream.close();
        f.devices.close();
        receivers.forEach((r) => r.close());
      }
    },
  });
}

Deno.test({
  name:
    'RAOP device stream: independent native activation without public capacity',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const receivers = await Promise.all(
      [0, 1].map(() =>
        startFakeRaop({ captureAudio: true, captureWire: true })
      ),
    );
    const f = deviceFixture(receivers);
    // Native stream binding remains independent without a core demand port too.
    const first = f.devices.createStream(), second = f.devices.createStream();
    try {
      await f.activate(0, first);
      await f.activate(1, second);
      const distinct = new Uint8Array(704 * 4).fill(0x23);
      await second.pcm(distinct);
      await first.pcm(pcm(704));
      await Promise.all([
        rendered(receivers[0], pcm(704)),
        rendered(receivers[1], distinct),
      ]);
      await libraryProof();
    } finally {
      await Promise.all([first.close(), second.close()]);
      f.devices.close();
      receivers.forEach((r) => r.close());
    }
  },
});

Deno.test({
  name:
    'RAOP device stream: capacity waits for stream free after last attachment',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const receiver = await startFakeRaop({
      captureAudio: true,
      captureWire: true,
    });
    const gate = Promise.withResolvers<void>();
    let entered = false;
    const f = deviceFixture([receiver], {
      stream() {
        const native = createFfiStream();
        return {
          ...native,
          async close() {
            entered = true;
            await gate.promise;
            await native.close();
          },
        };
      },
    });
    const demand = f.capacities[0].reserve();
    const stream = f.devices.createStream(f.capacities[0]);
    try {
      const attachment = await f.activate(0, stream, f.capacities[0]);
      await stream.pcm(pcm(704));
      await rendered(receiver, pcm(704));
      await attachment.close();
      demand.release();
      const closing = stream.close();
      await until('native stream free entered', () => entered);
      assertEquals(f.retained, [1, 0]);
      f.capacities[1].reserve().release();
      gate.resolve();
      await closing;
      assertEquals(f.retained, [0, 0]);
      f.capacities[1].reserve().release();
      await libraryProof();
    } finally {
      gate.resolve();
      demand.release();
      await stream.close();
      f.devices.close();
      receiver.close();
    }
  },
});

Deno.test({
  name:
    'RAOP device stream: failed stream close retains capacity and quarantine',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const receiver = await startFakeRaop({
      captureAudio: true,
      captureWire: true,
    });
    let native: AirplayExactStream | undefined;
    let attempts = 0;
    const f = deviceFixture([receiver], {
      stream() {
        native = createFfiStream();
        return {
          ...native,
          close() {
            attempts++;
            return Promise.reject(new Error('controlled native free failure'));
          },
        };
      },
    });
    const demand = f.capacities[0].reserve();
    const stream = f.devices.createStream(f.capacities[0]);
    try {
      const attachment = await f.activate(0, stream, f.capacities[0]);
      await stream.pcm(pcm(704));
      await rendered(receiver, pcm(704));
      await attachment.close();
      demand.release();
      const closing = stream.close();
      await assertRejects(
        () => closing,
        AggregateError,
        'stream release failed',
      );
      assertEquals(
        stream.close(),
        closing,
        'failure cannot become a new attempt',
      );
      assertEquals(attempts, 1);
      assertEquals(
        f.retained,
        [1, 0],
        'failed native close keeps its own resource token',
      );
      f.capacities[1].reserve().release();
      await assertRejects(() => stream.pcm(pcm(1)), Error, 'closed');
      const permit = await f.prepare(0, stream, f.capacities[0]);
      assert(!permit.ok);
      assertEquals(permit.error.code, 'cancelled');
      await libraryProof();
    } finally {
      // Test-owned failure seam refused native free. Explicitly release that
      // retained native object, never retry/reset the public quarantined owner.
      await native?.close();
      demand.release();
      f.devices.close();
      receiver.close();
    }
  },
});

Deno.test({
  name: 'RAOP device stream: close joins and cancels a backpressured producer',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const f = deviceFixture([]);
    const demand = f.capacities[0].reserve();
    const stream = f.devices.createStream(f.capacities[0]);
    try {
      const writing = stream.pcm(new Uint8Array((2 * 44100 + 1) * 4));
      const failed = assertRejects(() => writing, Error, 'producer canceled');
      await libraryProof();
      demand.release();
      const closing = stream.close();
      assertEquals(stream.close(), closing);
      await failed;
      await closing;
      f.capacities[1].reserve().release();
    } finally {
      demand.release();
      await stream.close();
      f.devices.close();
    }
  },
});

Deno.test({
  name:
    'RAOP device stream reset: delegates writer fencing and preserves replacement PCM',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const receiver = await startFakeRaop({
      captureAudio: true,
      captureWire: true,
    });
    const f = deviceFixture([receiver]);
    const demand = f.capacities[0].reserve();
    const stream = f.devices.createStream(f.capacities[0]);
    try {
      await stream.reset();
      assertEquals(
        stream.id,
        null,
        'reset does not allocate dormant native storage',
      );
      const writing = stream.pcm(
        new Uint8Array((2 * 44100 + 1) * 4).fill(0x35),
      );
      const canceled = assertRejects(() => writing, Error, 'producer canceled');
      await pause();
      const reset = stream.reset();
      const replacement = stream.pcm(pcm(704));
      await Promise.all([reset, canceled, replacement]);
      await f.activate(0, stream, f.capacities[0]);
      await rendered(receiver, pcm(704));
      await libraryProof();
      await stream.close();
      await assertRejects(() => stream.reset(), Error, 'closed');
      demand.release();
      f.capacities[1].reserve().release();
    } finally {
      demand.release();
      await stream.close();
      f.devices.close();
      receiver.close();
    }
  },
});

Deno.test('RAOP device stream: foreign or mismatched capacity binding cannot prepare', async () => {
  let allocations = 0;
  const f = deviceFixture([], {
    stream() {
      allocations++;
      throw new Error('unreachable allocation');
    },
  });
  const stream = f.devices.createStream(f.capacities[0]);
  const foreign = deviceFixture([]);
  try {
    const wrongCapacity = await f.prepare(0, stream, f.capacities[1]);
    const wrongFactory = await foreign.prepare(0, stream, f.capacities[0]);
    for (const result of [wrongCapacity, wrongFactory]) {
      assert(!result.ok);
      assertEquals(result.error.code, 'stale');
    }
    assertEquals(allocations, 0);
    assertEquals(stream.id, null);
  } finally {
    await stream.close();
    f.devices.close();
    foreign.devices.close();
  }
});

Deno.test('RAOP device stream: allocation failure releases only its unacquired resource', async () => {
  const f = deviceFixture([], {
    stream() {
      throw new Error('controlled allocation failure');
    },
  });
  const demand = f.capacities[0].reserve();
  const stream = f.devices.createStream(f.capacities[0]);
  try {
    await assertRejects(() => stream.pcm(pcm(1)), Error, 'allocation failure');
    demand.release();
    f.capacities[1].reserve().release();
    assertEquals(stream.id, null);
  } finally {
    demand.release();
    await stream.close();
    f.devices.close();
  }
});

Deno.test('RAOP device stream: expired demand permit cannot acquire a later reservation', async () => {
  const receiver = await startFakeRaop();
  let allocations = 0;
  const f = deviceFixture([receiver], {
    stream() {
      allocations++;
      throw new Error('unreachable allocation');
    },
  });
  const demand = f.capacities[0].reserve();
  const stream = f.devices.createStream(f.capacities[0]);
  try {
    const permit = await f.prepare(0, stream, f.capacities[0]);
    assert(permit.ok);
    demand.release();
    const replacement = f.capacities[0].reserve();
    try {
      let published = false;
      const result = await f.devices.protocol.activate(permit.value, input, {
        publish() {
          published = true;
        },
        onEvent() {},
      });
      assert(!result.ok);
      assertEquals(published, false);
      assertEquals(allocations, 0);
      assertEquals(receiver.sessions.length, 0);
    } finally {
      replacement.release();
    }
    f.capacities[1].reserve().release();
  } finally {
    demand.release();
    await stream.close();
    f.devices.close();
    receiver.close();
  }
});

Deno.test('RAOP device stream: failed attachment close still releases siblings and retains occupancy', async () => {
  const receivers = await Promise.all([startFakeRaop(), startFakeRaop()]);
  const attempts = [0, 0];
  let nativeAttempts = 0;
  const f = deviceFixture(receivers, {
    stream() {
      let next = 0;
      return {
        id: 1000n,
        epoch: 1n,
        append: () => Promise.reject(new Error('unused fixture input')),
        cancel: () => Promise.reject(new Error('unused fixture cancel')),
        ackCancel: () => Promise.reject(new Error('unused fixture ack')),
        attach(event) {
          const index = next++;
          let closing: Promise<void> | undefined;
          return {
            id: BigInt(index + 1),
            streamId: 1000n,
            start() {
              event('state', 'connected');
              return Promise.resolve();
            },
            transport: {
              send: () => Promise.resolve(),
              pcm: () => Promise.reject(new Error('stream-owned input')),
              ownsSharedFeed: () => false,
              cancelPcm() {},
              close() {
                return closing ??= Promise.resolve().then(() => {
                  attempts[index]++;
                  if (index === 0) {
                    throw new Error('controlled attachment failure');
                  }
                });
              },
            },
          };
        },
        pcm: () => Promise.resolve(),
        cancelPcm() {},
        reset: () => Promise.resolve(),
        close() {
          nativeAttempts++;
          return Promise.reject(new Error('native attachment retained'));
        },
      };
    },
  });
  const demand = f.capacities[0].reserve();
  const stream = f.devices.createStream(f.capacities[0]);
  try {
    await Promise.all(
      [0, 1].map((i) => f.activate(i, stream, f.capacities[0])),
    );
    demand.release();
    const closing = stream.close();
    await assertRejects(() => closing, AggregateError, 'stream release failed');
    assertEquals(
      attempts,
      [1, 1],
      'a failed sibling cannot skip other releases',
    );
    assertEquals(nativeAttempts, 1, 'native release is still attempted');
    assertEquals(stream.close(), closing);
    assertEquals(f.retained, [1, 0]);
    f.capacities[1].reserve().release();
  } finally {
    demand.release();
    f.devices.close();
    receivers.forEach((r) => r.close());
  }
});

Deno.test('RAOP device stream: close cancels and joins preparation before publication', async () => {
  const gate = Promise.withResolvers<void>();
  let entered = false, aborted = false, allocations = 0;
  const f = deviceFixture([], {
    resolver: {
      async resolve(_host, _port, signal) {
        entered = true;
        signal!.addEventListener('abort', () => aborted = true);
        await gate.promise;
        throw new Error('controlled preparation ended');
      },
      close() {},
    },
    stream() {
      allocations++;
      throw new Error('unreachable allocation');
    },
  });
  f.outputs.register({
    id: '1',
    name: 'held',
    type: 'AirPlay',
    host: '127.0.0.1',
    selected: true,
    volume: 50,
  });
  const stream = f.devices.createStream();
  try {
    const preparing = f.prepare(0, stream);
    await until('preparation entered', () => entered);
    let closed = false;
    const closing = stream.close().then(() => closed = true);
    assert(aborted);
    await pause();
    assertEquals(closed, false, 'close joins held resolver cleanup');
    gate.resolve();
    const result = await preparing;
    assert(!result.ok);
    assertEquals(result.error.code, 'cancelled');
    await closing;
    assertEquals(allocations, 0);
  } finally {
    gate.resolve();
    await stream.close();
    f.devices.close();
  }
});

Deno.test('RAOP device stream: close joins activation and prevents late native acquisition', async () => {
  const receiver = await startFakeRaop();
  const gate = Promise.withResolvers<void>();
  let entered = false, allocations = 0, published = false;
  const f = deviceFixture([receiver], {
    credentials: {
      async session() {
        entered = true;
        await gate.promise;
        return {
          password: null,
          pairingKey: null,
          isCurrent: () => true,
          acceptPairing: () => Promise.resolve(),
        };
      },
    },
    stream() {
      allocations++;
      throw new Error('unreachable allocation');
    },
  });
  const demand = f.capacities[0].reserve();
  const stream = f.devices.createStream(f.capacities[0]);
  try {
    const permit = await f.prepare(0, stream, f.capacities[0]);
    assert(permit.ok);
    const activating = f.devices.protocol.activate(permit.value, input, {
      publish() {
        published = true;
      },
      onEvent() {},
    });
    await until('credential acquisition entered', () => entered);
    let closed = false;
    const closing = stream.close().then(() => closed = true);
    await pause();
    assertEquals(closed, false, 'close joins admitted activation');
    gate.resolve();
    const result = await activating;
    assert(!result.ok);
    assertEquals(result.error.code, 'cancelled');
    await closing;
    assertEquals(published, false);
    assertEquals(allocations, 0);
    assertEquals(receiver.sessions.length, 0);
    demand.release();
    f.capacities[1].reserve().release();
  } finally {
    gate.resolve();
    demand.release();
    await stream.close();
    f.devices.close();
    receiver.close();
  }
});

for (const explicit of [true, false]) {
  Deno.test(`RAOP device stream: synchronous construction event closes the bound ${explicit ? 'stream' : 'compatibility'} attachment`, async () => {
    const receiver = await startFakeRaop();
    let acquired = false,
      acquiredAtEvent = false,
      closed = false,
      starts = 0,
      frees = 0;
    const attach: AirplayStream['attach'] = (event) => {
      // Construction has not yet returned the handle when the event fires.
      event('state', 'failed');
      acquired = true;
      return {
        id: 1n,
        streamId: 1000n,
        start() {
          starts++;
          return Promise.resolve();
        },
        transport: {
          send: () => Promise.resolve(),
          pcm: () => Promise.resolve(),
          cancelPcm() {},
          ownsSharedFeed: () => false,
          close() {
            assert(acquired, 'close must own the returned handle');
            closed = true;
            return Promise.resolve();
          },
        },
      };
    };
    const f = deviceFixture([receiver], {
      spawn: attach,
      stream: () => ({
        id: 1000n,
        epoch: 1n,
        append: () => Promise.reject(new Error('unused fixture input')),
        cancel: () => Promise.reject(new Error('unused fixture cancel')),
        ackCancel: () => Promise.reject(new Error('unused fixture ack')),
        attach,
        pcm: () => Promise.resolve(),
        cancelPcm() {},
        reset: () => Promise.resolve(),
        close() {
          assert(closed, 'attachment closes before native storage');
          frees++;
          return Promise.resolve();
        },
      }),
    });
    const demand = f.capacities[0].reserve();
    const stream = f.devices.createStream(f.capacities[0]);
    try {
      const request = {
        id: '1',
        targetRevision: f.devices.admission.describe('1').targetRevision,
        signal: new AbortController().signal,
        isCurrent: () => true,
        capacity: f.capacities[0],
        ...(explicit ? { stream } : {}),
      };
      const permit = await f.devices.protocol.prepare(request);
      assert(permit.ok);
      let published: AirplayTransport | undefined;
      let closing: Promise<void> | undefined;
      const result = await f.devices.protocol.activate(permit.value, input, {
        publish(transport) {
          published = transport;
        },
        onEvent(event) {
          assertEquals(event, { event: 'state', value: 'failed' });
          acquiredAtEvent = acquired;
          closing = published!.close();
        },
      });
      assert(!result.ok);
      await closing;
      assert(acquiredAtEvent, 'construction event waits for immutable binding');
      assert(closed);
      assertEquals(starts, 0, 'closed attachment cannot subsequently start');
      demand.release();
      assertEquals(f.retained, [explicit ? 1 : 0, 0]);
      f.capacities[1].reserve().release();
      await stream.close();
      assertEquals(frees, explicit ? 1 : 0);
      f.capacities[1].reserve().release();
    } finally {
      demand.release();
      await stream.close();
      f.devices.close();
      receiver.close();
    }
  });
}
