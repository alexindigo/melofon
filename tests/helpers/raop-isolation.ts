// Public shipping-library ports for native isolation, without core capacity.
import { assert, assertEquals } from '@std/assert';
import { raopFfiInternals } from '../../src/boots/raop-ffi.ts';
import { type FakeRaopSession, startFakeRaop } from './fake-raop.ts';
import { decodeReceiverAudio } from './raop-audio-consumer.ts';
import { renderScheduledAudio } from './raop-scheduled-consumer.ts';

export const sleep = (ms = 5) => new Promise((r) => setTimeout(r, ms));
export async function until(
  label: string,
  predicate: () => boolean | Promise<boolean>,
  timeout = 15000,
) {
  const end = performance.now() + timeout;
  while (!await predicate()) {
    if (performance.now() >= end) throw new Error(`timed out: ${label}`);
    await sleep();
  }
}
export function pcm(frames: number, seed = 0) {
  const bytes = new Uint8Array(frames * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < frames; i++) {
    view.setInt16(i * 4, (i * 17 + seed) % 30001 - 15000, true);
    view.setInt16(i * 4 + 2, 14000 - (i * 19 + seed) % 28001, true);
  }
  return bytes;
}
export const text = (s: string) => new TextEncoder().encode(`${s}\0`);
export function nativeStream() {
  const lib = raopFfiInternals.loadLibrary().symbols;
  const pointer = lib.raop_stream_new();
  assert(pointer);
  let closed = false;
  const handles: Deno.PointerObject[] = [];
  return {
    pointer,
    id: lib.raop_stream_id(pointer),
    metadata: (
      title: string,
      artist: string,
      position: number,
      length: number,
    ) =>
      lib.raop_stream_metadata(
        pointer,
        text(title),
        text(artist),
        position,
        length,
      ),
    async attach(receiver: Receiver, metadata = 5, encrypted = false) {
      const handle = lib.raop_stream_attach(pointer);
      assert(handle);
      handles.push(handle);
      assertEquals(
        lib.raop_start_v2(
          handle,
          text('127.0.0.1'),
          receiver.port,
          text('Isolation'),
          50,
          6,
          encrypted ? 1 : 0,
          0,
          1000,
          metadata,
          0,
          0,
          text('attachment must not overwrite stream'),
          text('attachment'),
          0,
          null,
          0n,
          null,
          0n,
        ),
        0,
      );
      const events = new Uint8Array(4096);
      await until('public FFI connected', () => {
        const n = lib.raop_poll(handle, events, BigInt(events.length));
        return n > 0 &&
          new TextDecoder().decode(events.subarray(0, n)).includes('connected');
      });
      return handle;
    },
    write(bytes: Uint8Array) {
      assertEquals(
        lib.raop_stream_write(pointer, bytes, BigInt(bytes.length)),
        bytes.length,
      );
    },
    async cancel() {
      const epoch = lib.raop_stream_epoch(pointer);
      assertEquals(lib.raop_stream_cancel(pointer, epoch), 0);
      const receipt = new BigUint64Array(6);
      await until(
        'ordered stream reset',
        () =>
          lib.raop_stream_cancel_poll(pointer, epoch, receipt) === 1 &&
          receipt[2] !== 0n,
      );
      assertEquals(receipt[2], 1n);
      assertEquals(lib.raop_stream_cancel_ack(pointer, epoch), 0);
    },
    async close() {
      if (closed) return;
      for (const h of handles.splice(0)) {
        assertEquals(await lib.raop_free(h), 0);
      }
      assertEquals(await lib.raop_stream_free(pointer), 0);
      closed = true;
    },
  };
}
export type Receiver = Awaited<ReturnType<typeof startFakeRaop>>;
export { startFakeRaop };
export function titles(session: FakeRaopSession) {
  return session.parameters.filter((p) =>
    p.contentType === 'application/x-dmap-tagged'
  )
    .map((p) => new TextDecoder().decode(p.body));
}
export function progress(session: FakeRaopSession) {
  return session.parameters.flatMap((p) => {
    const match = /^progress: (\d+)\/(\d+)\/(\d+)\r\n$/.exec(
      new TextDecoder().decode(p.body),
    );
    return match
      ? [{
        atMs: p.atMs,
        display: Number(match[1]),
        pos: Number(match[2]),
        end: Number(match[3]),
      }]
      : [];
  });
}
export async function rendered(
  receiver: Receiver,
  expected: Uint8Array,
  transform: (session: FakeRaopSession) => FakeRaopSession = (s) => s,
  expectedFlushes = 0,
) {
  await until(
    'complete wire PCM and timing',
    () =>
      receiver.sessions[0].audioPackets >= expected.length / (352 * 4) &&
      receiver.sessions[0].wire.some((e) => e.kind === 'timing-reply'),
  );
  const session = transform(receiver.sessions[0]);
  assertEquals(
    decodeReceiverAudio(session.sdp, session.audioPayloads),
    expected,
  );
  const pending = renderScheduledAudio(session, receiver.nowMs());
  assertEquals(pending.issues, []);
  assert(
    pending.lastPresentationAtMs !== null &&
      pending.clockUncertaintyMs !== null,
  );
  await until(
    'independent scheduled boundary',
    () =>
      receiver.nowMs() >
        pending.lastPresentationAtMs! + pending.clockUncertaintyMs!,
  );
  const actual = renderScheduledAudio(session, receiver.nowMs());
  assertEquals(actual.issues, []);
  assertEquals(actual.pcm, expected);
  assertEquals(actual.pendingFrames, 0);
  assertEquals(actual.discarded, []);
  assertEquals([session.flushes, session.teardowns, receiver.sessions.length], [
    expectedFlushes,
    0,
    1,
  ]);
}
export async function libraryProof() {
  const path = await Deno.realPath(
    new URL('../../helper/raop/libmelofon_raop.so', import.meta.url),
  );
  assertEquals(await Deno.realPath(Deno.env.get('MELOFON_RAOP_LIB')!), path);
  assert(
    (await Deno.readTextFile('/proc/self/maps')).split('\n').some((l) =>
      l.endsWith(` ${path}`)
    ),
  );
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', await Deno.readFile(path)),
  );
  console.log(
    `isolation native library: ${path} sha256=${
      Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')
    }`,
  );
}
