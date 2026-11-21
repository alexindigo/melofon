// Natural-boundary crossfade through real plain HTTP, file decoder, core
// timeline mixer, shipping FFI and the scheduled receiver model.
import { assert, assertEquals, assertThrows } from '@std/assert';
import { nativeHttpFixture } from './helpers/playback-native-http.ts';
import { renderScheduledAudio } from './helpers/raop-scheduled-consumer.ts';
import { crossfadeFrames, type CrossfadeRecord } from '../src/playback-mix.ts';
import { createPlayer } from '../src/player.ts';

type Sample = (i: number) => [number, number];

function pcm(frames: number, sample: Sample) {
  const bytes = new Uint8Array(frames * 4), view = new DataView(bytes.buffer);
  for (let i = 0; i < frames; i++) {
    const [l, r] = sample(i);
    view.setInt16(i * 4, l, true);
    view.setInt16(i * 4 + 2, r, true);
  }
  return bytes;
}
// Independent reference: exact rational ramp weights, rounded half up once.
function mixed(a: number, b: number, i: number, frames: number) {
  const d = BigInt(frames - 1);
  const n = BigInt(a) * (d - BigInt(i)) + BigInt(b) * BigInt(i);
  const twice = 2n * n + d, den = 2n * d;
  let q = twice / den;
  if (twice % den !== 0n && twice < 0n) q -= 1n;
  return Number(q);
}
/** Expected rendered stream: each boundary overlaps at most the outgoing
 * source's own remaining frames and leaves the incoming one >= 1 frame. */
function model(parts: Uint8Array[], requested: number) {
  const applied: number[] = [];
  const own = parts.map((p) => p.length / 4);
  for (let k = 0; k + 1 < parts.length; k++) {
    let f = Math.min(requested, own[k], parts[k + 1].length / 4 - 1);
    if (f < 2) f = 0;
    applied.push(f);
    own[k + 1] -= f;
  }
  const total = parts.reduce((n, p) => n + p.length / 4, 0) -
    applied.reduce((n, f) => n + f, 0);
  const out = new Uint8Array(total * 4), view = new DataView(out.buffer);
  let at = 0;
  for (const [k, part] of parts.entries()) {
    const head = k ? applied[k - 1] : 0;
    const p = new DataView(part.buffer);
    const frames = part.length / 4;
    // Frames [0, head) were already mixed into the previous source's tail.
    for (let i = head; i < frames; i++) {
      for (let c = 0; c < 2; c++) {
        view.setInt16(at * 4 + c * 2, p.getInt16(i * 4 + c * 2, true), true);
      }
      at++;
    }
    const next = parts[k + 1];
    const f = applied[k] ?? 0;
    if (!f) continue;
    const n = new DataView(next.buffer);
    at -= f;
    for (let i = 0; i < f; i++) {
      for (let c = 0; c < 2; c++) {
        const a = p.getInt16((frames - f + i) * 4 + c * 2, true);
        const b = n.getInt16(i * 4 + c * 2, true);
        view.setInt16(at * 4 + c * 2, mixed(a, b, i, f), true);
      }
      at++;
    }
  }
  assertEquals(at, total);
  return { pcm: out, applied };
}
async function until(predicate: () => boolean | Promise<boolean>) {
  const deadline = performance.now() + 20000;
  while (!await predicate()) {
    assert(performance.now() < deadline, 'crossfade outcome timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
async function libraryProof() {
  const path = await Deno.realPath(
    new URL('../helper/raop/libmelofon_raop.so', import.meta.url),
  );
  assertEquals(await Deno.realPath(Deno.env.get('MELOFON_RAOP_LIB')!), path);
  assert(
    (await Deno.readTextFile('/proc/self/maps')).split('\n').some((line) =>
      line.endsWith(` ${path}`)
    ),
  );
}
async function render(parts: Uint8Array[], crossfadeMs: number) {
  const records: CrossfadeRecord[] = [];
  const f = await nativeHttpFixture({
    pcm: parts[0],
    additionalPcm: parts.slice(1),
    crossfadeMs: () => crossfadeMs,
    crossfadeObserved: (record) => records.push(record),
  });
  try {
    const { credential } = await f.fixture.login('bearer');
    const added = await f.fixture.json(
      '/api/v1/players/1/queue/items',
      'POST',
      { references: f.songIds.map((id) => ({ kind: 'song', id })) },
      credential,
    );
    assertEquals(added.status, 200, await added.text());
    const entries = f.playback.queueView().items.map((e) => e.id);
    const played = await f.fixture.json(
      '/api/v1/players/1/play',
      'POST',
      {},
      credential,
    );
    assertEquals(played.status, 204, await played.text());
    await until(() => f.playback.playerView().state === 'stop');
    assertEquals(f.receiver.sessions.length, 1, 'one receiver session');
    const session = f.receiver.sessions[0];
    assertEquals(
      session.requests.filter((r) => r.method === 'FLUSH').length,
      0,
      'natural boundaries never flush',
    );
    assertEquals(f.audio.epochs.length, 1, 'one transport epoch');
    const real = f.audio.epochs[0].ranges.filter((r) => r.kind === 'real');
    let boundary = 0n;
    for (const range of real) {
      assertEquals(range.transportStart, boundary, 'no gap between sources');
      boundary += range.frames;
    }
    const replay = renderScheduledAudio(session, f.receiver.nowMs());
    assertEquals(replay.issues, []);
    await libraryProof();
    return {
      records,
      entries,
      audio: f.audio.realAudio(session),
      scheduled: f.audio.scheduledRealAudio(session, f.receiver.nowMs()),
      rendered: replay.pcm,
      // Native frames per source, in transport order.
      realFrames: [...Map.groupBy(real, (r) => r.source).values()].map((
        ranges,
      ) => ranges.reduce((n, r) => n + Number(r.frames), 0)),
    };
  } finally {
    await f.close();
  }
}
function test(name: string, fn: () => Promise<void>) {
  Deno.test({
    name: `playback crossfade: ${name}`,
    sanitizeOps: false,
    sanitizeResources: false,
    fn,
  });
}
async function exact(parts: Uint8Array[], crossfadeMs: number) {
  const requested = Math.floor(crossfadeMs * 44100 / 1000);
  const expected = model(parts, requested);
  const out = await render(parts, crossfadeMs);
  assertEquals(out.audio.length, expected.pcm.length, 'length A+B-F');
  assertEquals(out.audio, expected.pcm);
  assertEquals(out.scheduled, expected.pcm);
  assertEquals(
    out.rendered.subarray(0, expected.pcm.length),
    expected.pcm,
    'the mixed final tail renders before terminal stop',
  );
  assertEquals(
    out.records.map((r) => Number(r.appliedFrames)),
    expected.applied,
  );
  for (const [k, record] of out.records.entries()) {
    assertEquals(record.requestedFrames, BigInt(requested));
    assertEquals(record.outgoingEntryId, out.entries[k]);
    assertEquals(record.incomingEntryId, out.entries[k + 1]);
  }
  // A owns its mixed tail; B's native range starts after its overlapped head.
  assertEquals(
    out.realFrames,
    parts.map((p, k) => p.length / 4 - (k ? expected.applied[k - 1] : 0)),
  );
  return { ...out, expected };
}

test('settings enter core only within the approved 0 to 13 second range', () => {
  assertEquals(crossfadeFrames(0), 0n);
  assertEquals(crossfadeFrames(13_000), 573300n);
  const player = createPlayer({ crossfadeMs: 13_000 });
  for (const ms of [-1, 13_001, 1_000_000_000, 1.5, NaN, Infinity]) {
    assertThrows(() => crossfadeFrames(ms), RangeError, '0 to 13000');
    assertThrows(
      () => createPlayer({ crossfadeMs: ms }),
      RangeError,
      '0 to 13000',
    );
    assertThrows(() => player.setCrossfade(ms), RangeError, '0 to 13000');
    assertEquals(player.status().crossfadeMs, 13_000);
  }
  player.setCrossfade(0);
  assertEquals(player.status().crossfadeMs, 0);
  return Promise.resolve();
});

test('constants mix with exact pure prefix, suffix and endpoints', async () => {
  const a = pcm(44100 + 137, () => [12000, -12000]);
  const b = pcm(22050 + 19, () => [-30000, 30000]);
  const out = await exact([a, b], 100);
  assertEquals(out.records[0].reason, 'applied');
  const f = 4410, start = 44100 + 137 - f;
  const view = new DataView(out.audio.buffer);
  assertEquals(view.getInt16((start - 1) * 4, true), 12000);
  assertEquals(view.getInt16(start * 4, true), 12000, 'mix starts at A gain 1');
  assertEquals(
    view.getInt16((start + f - 1) * 4, true),
    -30000,
    'mix ends at B gain 1',
  );
  assertEquals(view.getInt16((start + f) * 4 + 2, true), 30000);
});

test('full-scale opposite signals never wrap or clip incorrectly', async () => {
  const a = pcm(30000, () => [32767, -32768]);
  const b = pcm(30000, () => [-32768, 32767]);
  const out = await exact([a, b], 50);
  const view = new DataView(out.audio.buffer);
  const f = 2205, start = 30000 - f;
  for (let i = 0; i < f; i++) {
    const l = view.getInt16((start + i) * 4, true);
    const r = view.getInt16((start + i) * 4 + 2, true);
    assert(l + r >= -1 && l + r <= 1, `symmetric ramp at ${i}`);
    if (i) assert(l <= view.getInt16((start + i - 1) * 4, true), 'monotone');
  }
});

test('correlated full-scale samples keep unity gain throughout the overlap', async () => {
  await exact([
    pcm(44100 + 137, () => [32767, -32768]),
    pcm(22050 + 19, () => [32767, -32768]),
  ], 100);
});

test('antiphase overlap cancels to the rounded ramp', async () => {
  const f = 441, a = pcm(5000, (i) => [(i * 37) % 20000 - 10000, 0]);
  const tail = new DataView(a.buffer, (5000 - f) * 4);
  const b = pcm(3000, (i) => [i < f ? -tail.getInt16(i * 4, true) : 777, 1]);
  const out = await exact([a, b], 10);
  const view = new DataView(out.audio.buffer);
  assertEquals(view.getInt16((5000 - f + 220) * 4, true), 0, 'center cancels');
});

test('ramps across nonaligned packet boundaries', async () => {
  await exact([
    pcm(3 * 352 + 17, (i) => [i * 7 - 4000, 3000 - i * 5]),
    pcm(1000 + 351, (i) => [(i * 13) % 9000, -((i * 11) % 7000)]),
    pcm(2 * 352 + 1, (i) => [-i, i]),
  ], 10);
});

test('zero crossfade is byte-identical to gapless and records nothing', async () => {
  const parts = [
    pcm(353, (i) => [1000 + i, -2000 - i]),
    pcm(351, (i) => [7000 - i, i]),
  ];
  const out = await render(parts, 0);
  const expected = new Uint8Array(parts[0].length + parts[1].length);
  expected.set(parts[0]);
  expected.set(parts[1], parts[0].length);
  assertEquals(out.audio, expected);
  assertEquals(out.records, []);
  assertEquals(out.realFrames, [353, 351]);
});

test('short chained sources never triple-mix or reuse an incoming head', async () => {
  const parts = [
    pcm(8000, () => [10000, 10000]),
    pcm(6000, (i) => [i % 2 ? 20000 : -20000, i]),
    pcm(8000, () => [-10000, -10000]),
  ];
  const out = await exact(parts, 100);
  assertEquals(out.expected.applied, [4410, 1590]);
  assertEquals(out.records.map((r) => r.reason), [
    'applied',
    'short-outgoing',
  ]);
});

test('incoming source shorter than the window keeps one frame of its own', async () => {
  const parts = [
    pcm(8000, () => [5000, 5000]),
    pcm(900, (i) => [i, -i]),
    pcm(2000, () => [-5000, 5000]),
  ];
  const out = await exact(parts, 100);
  assertEquals(out.expected.applied, [899, 0]);
  assertEquals(out.records.map((r) => r.reason), [
    'short-incoming',
    'short-outgoing',
  ]);
});
