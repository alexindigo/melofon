import { assert, assertEquals, assertThrows } from '@std/assert';
import { createFfiSpawn } from '../src/boots/raop-ffi.ts';
import { profileFromService } from '../src/boots/airplay-profile.ts';
import { type FakeRaopSession, startFakeRaop } from './helpers/fake-raop.ts';
import { decodeReceiverAudio, pcmAt } from './helpers/raop-audio-consumer.ts';
import { renderScheduledAudio } from './helpers/raop-scheduled-consumer.ts';

const SDP = 'a=rtpmap:96 AppleLossless\r\n' +
  'a=fmtp:96 352 0 16 40 10 14 2 255 0 0 44100\r\n';
const BLOCK = 352;
const FIRST = 0xffffff00;
const SSRC = 0x12345678;
const START = 3251;
const endpoints = {
  audio: { address: '127.0.0.1', port: 4000 },
  control: { address: '127.0.0.1', port: 4001 },
  timing: { address: '127.0.0.1', port: 4002 },
  senderControl: { address: '127.0.0.1', port: 5001 },
  senderTiming: { address: '127.0.0.1', port: 5002 },
};
type Capture = Pick<FakeRaopSession, 'sdp' | 'wire' | 'endpoints'>;

function pcm(first = 0, frames = BLOCK): Uint8Array {
  const bytes = new Uint8Array(frames * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < frames; i++) {
    const [left, right] = pcmAt(first + i);
    view.setInt16(i * 4, left, true);
    view.setInt16(i * 4 + 2, right, true);
  }
  return bytes;
}

// Known lossless wire fixture: ALAC stereo channel-pair, no explicit size,
// uncompressed 16-bit samples, then END. Not the production encoder and not a
// PCM injection into the receiver model: every assertion goes through libavcodec.
function alac(bytes: Uint8Array): Uint8Array {
  const bits: number[] = [];
  const put = (value: number, width: number) => {
    for (let i = width - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  put(1, 3); // stereo channel pair
  put(0, 16); // instance tag and reserved bits
  put(0, 1); // default frame size from SDP
  put(0, 2); // no low-byte escape
  put(1, 1); // uncompressed
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < bytes.length; i += 2) put(view.getUint16(i, true), 16);
  put(7, 3);
  const data = new Uint8Array(Math.ceil(bits.length / 8));
  for (let i = 0; i < bits.length; i++) {
    data[i >> 3] |= bits[i] << (7 - (i & 7));
  }
  return data;
}

function audio(index: number): Uint8Array {
  const payload = alac(pcm(index * BLOCK));
  const data = new Uint8Array(12 + payload.length);
  const view = new DataView(data.buffer);
  data.set([0x80, 0xe0]);
  view.setUint16(2, (65535 + index) & 0xffff);
  view.setUint32(4, (FIRST + index * BLOCK) >>> 0);
  view.setUint32(8, SSRC);
  data.set(payload, 12);
  return data;
}

function sync(lead = 88200): Uint8Array {
  const data = new Uint8Array(20);
  const view = new DataView(data.buffer);
  data.set([0x90, 0xd4, 0, 7]);
  view.setUint32(4, (FIRST - lead) >>> 0);
  // Sender NTP has a deliberately unrelated epoch from receiver-local time.
  view.setBigUint64(8, 0x9123456800000000n);
  view.setUint32(16, FIRST);
  return data;
}

function fixture(): Capture {
  const request = new Uint8Array(32), reply = new Uint8Array(32);
  request.set([0x80, 0xd2, 1, 0]);
  new DataView(request.buffer).setBigUint64(24, 0x1234000000000000n);
  reply.set([0x80, 0xd3, 1, 0]);
  reply.set(request.subarray(24), 8);
  const replyView = new DataView(reply.buffer);
  replyView.setBigUint64(16, 0x9123456700000000n);
  replyView.setBigUint64(24, 0x9123456700000000n);
  return {
    sdp: SDP,
    endpoints: structuredClone(endpoints),
    wire: [
      {
        kind: 'timing-request',
        atMs: 0,
        data: request,
        peer: endpoints.senderTiming,
        local: endpoints.timing,
      },
      {
        kind: 'timing-reply',
        atMs: 2,
        data: reply,
        peer: endpoints.senderTiming,
        local: endpoints.timing,
      },
      {
        kind: 'record',
        atMs: 1000,
        rtpInfo: `seq=65535;rtptime=${FIRST}`,
        latencyFrames: 11025,
      },
      {
        kind: 'control',
        atMs: 1002,
        data: sync(),
        peer: endpoints.senderControl,
        local: endpoints.control,
      },
      {
        kind: 'audio',
        atMs: 1010,
        data: audio(0),
        peer: { address: '127.0.0.1', port: 5000 },
        local: endpoints.audio,
      },
      {
        kind: 'audio',
        atMs: 1020,
        data: audio(1),
        peer: { address: '127.0.0.1', port: 5000 },
        local: endpoints.audio,
      },
    ],
  };
}

function arrival(capture: Capture) {
  return decodeReceiverAudio(
    capture.sdp,
    capture.wire.filter((e) => e.kind === 'audio').map((e) =>
      ('data' in e ? e.data : new Uint8Array()).subarray(12)
    ),
  );
}

Deno.test('scheduled receiver: known ALAC and wire clocks render only when due', () => {
  const capture = fixture();
  assertEquals(arrival(capture), pcm(0, 704));
  const early = renderScheduledAudio(capture, START);
  assertEquals(early.issues, []);
  assertEquals(early.pcm.length, 0);
  assertEquals(early.pendingFrames, 704);
  assertEquals(early.clockUncertaintyMs, 1);
  const middle = renderScheduledAudio(capture, START + BLOCK * 1000 / 44100);
  assertEquals(middle.pcm, pcm());
  const full = renderScheduledAudio(capture, START + 704 * 1000 / 44100);
  assertEquals(full.issues, []);
  assertEquals(full.pcm, pcm(0, 704));
  assertEquals(full.discarded, []);
  assertEquals(full.pendingFrames, 0);
  assertEquals(full.ranges.map((r) => [r.sequence, r.timestamp, r.ssrc]), [
    [65535, FIRST, SSRC],
    [65536, FIRST + BLOCK, SSRC],
  ]);
  assertEquals(full.ranges[0].atMs, START);
});

for (const kind of ['flush', 'teardown', 'close'] as const) {
  Deno.test(`scheduled receiver: complete arrival still truncates at ${kind}`, () => {
    const capture = fixture();
    const atMs = START + 528 * 1000 / 44100;
    capture.wire.push(
      kind === 'flush'
        ? { kind, atMs, rtpInfo: `seq=1;rtptime=${(FIRST + 704) >>> 0}` }
        : { kind, atMs },
    );
    assertEquals(arrival(capture), pcm(0, 704), 'arrival-only proof is green');
    const actual = renderScheduledAudio(capture, 10000);
    assertEquals(actual.issues, []);
    assertEquals(actual.pcm, pcm(0, 528), 'unplayed tail must be discarded');
    assertEquals(actual.discarded, [{
      reason: kind,
      epoch: 1,
      timestamp: FIRST + 528,
      frames: 176,
    }]);
    assertEquals(actual.pendingFrames, 0);
  });
}

Deno.test('scheduled receiver: transport lead and advertised latency are each counted once', () => {
  const capture = fixture();
  const record = capture.wire.find((e) => e.kind === 'record')!;
  if (record.kind === 'record') record.latencyFrames = 22050;
  const control = capture.wire.find((e) => e.kind === 'control')!;
  if ('data' in control) control.data = sync(44100);
  const actual = renderScheduledAudio(capture, 3000);
  assertEquals(actual.issues, []);
  assertEquals(actual.ranges[0].atMs, 2501);
  assertEquals(actual.pcm, pcm(0, 704));
});

Deno.test('scheduled receiver: reorders wrapped RTP and deduplicates raw and enveloped retransmits', () => {
  const capture = fixture();
  const first = capture.wire[4], second = capture.wire[5];
  first.atMs = 1020;
  second.atMs = 1010;
  const retransmit = new Uint8Array(4 + audio(0).length);
  retransmit.set([0x80, 0xd6, 0, 1]);
  retransmit.set(audio(0), 4);
  capture.wire.push(
    { ...first, atMs: 1030 },
    {
      kind: 'control',
      atMs: 1040,
      data: retransmit,
      peer: endpoints.senderControl,
      local: endpoints.control,
    },
  );
  const actual = renderScheduledAudio(capture, 4000);
  assertEquals(actual.issues, []);
  assertEquals(actual.pcm, pcm(0, 704));
  assertEquals(actual.duplicates, 2);
});

for (
  const fault of [
    'missing',
    'length',
    'flags',
    'zero-clock',
    'anchor',
    'endpoint',
  ]
) {
  Deno.test(`scheduled receiver: ${fault} sync cannot prove playout`, () => {
    const capture = fixture();
    const event = capture.wire[3];
    assert(event.kind === 'control');
    if (fault === 'missing') capture.wire.splice(3, 1);
    if (fault === 'length') event.data = event.data.slice(0, 19);
    if (fault === 'flags') event.data[3] = 4;
    if (fault === 'zero-clock') event.data.fill(0, 8, 16);
    if (fault === 'anchor') {
      new DataView(event.data.buffer).setUint32(16, FIRST + 1);
    }
    if (fault === 'endpoint') event.peer = endpoints.senderTiming;
    assertEquals(arrival(capture), pcm(0, 704));
    const actual = renderScheduledAudio(capture, 10000);
    assert(actual.issues.length > 0);
    assertEquals(actual.pcm.length, 0);
  });
}

Deno.test('scheduled receiver: missing or forged timing cannot substitute arrival time', () => {
  for (const missing of [true, false]) {
    const capture = fixture();
    if (missing) capture.wire.splice(0, 2);
    else {
      const reply = capture.wire[1];
      assert('data' in reply);
      reply.data[8] ^= 1;
    }
    const actual = renderScheduledAudio(capture, 10000);
    assert(actual.issues.includes('missing timing exchange'));
    assertEquals(actual.pcm.length, 0);
  }
});

Deno.test('scheduled receiver: late retransmit is not retroactively rendered', () => {
  const capture = fixture();
  capture.wire[5].atMs = START + 528 * 1000 / 44100;
  const actual = renderScheduledAudio(capture, 4000);
  assertEquals(actual.issues, []);
  assertEquals(actual.pcm, new Uint8Array([...pcm(), ...pcm(528, 176)]));
  assertEquals(actual.discarded, [{
    reason: 'late',
    epoch: 1,
    timestamp: FIRST + BLOCK,
    frames: 176,
  }]);
});

Deno.test('scheduled receiver: arrival inside a frame cannot recover that already-started sample', () => {
  const capture = fixture();
  capture.wire[5].atMs = START + 528.5 * 1000 / 44100;
  const actual = renderScheduledAudio(capture, 4000);
  assertEquals(actual.issues, []);
  assertEquals(actual.pcm, new Uint8Array([...pcm(), ...pcm(529, 175)]));
  assertEquals(actual.discarded, [{
    reason: 'late',
    epoch: 1,
    timestamp: FIRST + BLOCK,
    frames: 177,
  }]);
});

Deno.test('scheduled receiver: flush fences late old packets and requires a fresh sync', () => {
  const capture = fixture();
  capture.wire.push({
    kind: 'flush',
    atMs: 1030,
    rtpInfo: `seq=1;rtptime=${(FIRST + 704) >>> 0}`,
  });
  const old = capture.wire[4];
  capture.wire.push({ ...old, atMs: 1040 });
  const fresh = audio(2);
  capture.wire.push({
    kind: 'audio',
    atMs: 1050,
    data: fresh,
    peer: { address: '127.0.0.1', port: 5000 },
    local: endpoints.audio,
  });
  const actual = renderScheduledAudio(capture, 10000);
  assertEquals(actual.pcm.length, 0);
  assert(actual.issues.includes('missing sync'));
  assertEquals(actual.pendingFrames, BLOCK);
  assertEquals(actual.discarded.reduce((n, r) => n + r.frames, 0), 704);
});

Deno.test('scheduled receiver: rejects unsupported encrypted audio and invalid snapshot clocks', () => {
  const capture = fixture();
  capture.sdp += 'a=aesiv:private\r\n';
  assertThrows(
    () => renderScheduledAudio(capture, 4000),
    Error,
    'unencrypted ALAC',
  );
  assertThrows(
    () => renderScheduledAudio(fixture(), NaN),
    Error,
    'snapshot time',
  );
});

async function until(what: string, predicate: () => boolean) {
  const deadline = performance.now() + 15000;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error(`timed out: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

Deno.test({
  name:
    'scheduled receiver: production public FFI -> UDP -> ALAC -> scheduled PCM',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const expectedLibrary = await Deno.realPath(
      new URL(
        '../helper/raop/libmelofon_raop.so',
        import.meta.url,
      ),
    );
    assertEquals(
      await Deno.realPath(Deno.env.get('MELOFON_RAOP_LIB')!),
      expectedLibrary,
    );
    const fake = await startFakeRaop({ captureAudio: true, captureWire: true });
    let connected = false;
    const driver = createFfiSpawn()((event, value) => {
      if (event === 'state' && value === 'connected') connected = true;
    });
    try {
      await driver.start(
        profileFromService({
          name: '001122334455@Scheduled._raop._tcp.local',
          host: 'fixture.local',
          address: '127.0.0.1',
          port: fake.port,
          ttlMs: 60000,
          txt: { tp: 'UDP', am: 'AppleTV2,1' },
        }),
        { volume: 50, positionMs: 0, lengthMs: 1000, title: '', artist: '' },
      );
      await until('native connected', () => connected);
      await driver.transport.pcm(pcm(0, 704));
      await until(
        'two RTP packets and wire timing reply',
        () =>
          fake.sessions[0]?.audioPackets >= 2 &&
          fake.sessions[0].wire.some((e) => e.kind === 'timing-reply'),
      );
      const session = fake.sessions[0];
      const maps = await Deno.readTextFile('/proc/self/maps');
      assert(
        maps.split('\n').some((line) => line.endsWith(` ${expectedLibrary}`)),
      );
      const digest = new Uint8Array(
        await crypto.subtle.digest(
          'SHA-256',
          await Deno.readFile(expectedLibrary),
        ),
      );
      console.log(
        `scheduled native library: ${expectedLibrary} sha256=${
          Array.from(digest, (v) => v.toString(16).padStart(2, '0')).join('')
        }`,
      );
      assertEquals(
        decodeReceiverAudio(session.sdp, session.audioPayloads),
        pcm(0, 704),
      );
      const buffered = renderScheduledAudio(session, fake.nowMs());
      assertEquals(buffered.issues, []);
      assertEquals(
        buffered.pcm.length,
        0,
        'arrival precedes actual presentation',
      );
      assertEquals(buffered.pendingFrames, 704);
      assert(buffered.lastPresentationAtMs !== null);
      assert(buffered.clockUncertaintyMs !== null);
      fake.requestRetransmit(session.id);
      await until(
        'real native retransmission on negotiated endpoints',
        () => session.audioPackets >= 3,
      );
      // Wait on the independently derived wire boundary, not a drain estimate.
      await until(
        'scheduled last frame boundary',
        () =>
          fake.nowMs() >
            buffered.lastPresentationAtMs! + buffered.clockUncertaintyMs!,
      );
      const actual = renderScheduledAudio(session, fake.nowMs());
      assertEquals(actual.issues, []);
      assertEquals(actual.pcm, pcm(0, 704));
      assertEquals(actual.pendingFrames, 0);
      assertEquals(actual.discarded, []);
      assertEquals(actual.duplicates, 1);
      assertEquals(session.flushes, 0);
      assertEquals(session.teardowns, 0);
      assert(session.requests.some((r) => r.method === 'RECORD' && r.rtpInfo));
      assert(session.endpoints?.senderControl?.port);
      assert(session.endpoints?.senderTiming?.port);
      assertEquals(
        new Set(Object.values(session.endpoints!).map((e) => e.port)).size,
        5,
      );
      await driver.transport.close();
      await until('actual receiver closure', () => session.closedAtMs !== null);
      assertEquals(
        renderScheduledAudio(session, fake.nowMs()).pcm,
        pcm(0, 704),
      );
      console.log(
        `scheduled consumer: ${
          actual.pcm.length / 4
        } exact frames, ${actual.duplicates} duplicate, no discard`,
      );
    } finally {
      await driver.transport.close();
      fake.close();
    }
  },
});
