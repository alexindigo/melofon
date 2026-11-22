import { assertEquals } from '@std/assert';
import { raopFfiInternals } from '../src/boots/raop-ffi.ts';
import {
  nativeStream,
  pcm,
  progress,
  rendered,
  startFakeRaop,
  until,
} from './helpers/raop-isolation.ts';

Deno.test({
  name: 'RAOP review: a late receiver gets the cached burst without more PCM',
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const stream = nativeStream();
    const first = await startFakeRaop({
      captureAudio: true,
      captureWire: true,
    });
    const late = await startFakeRaop({ captureAudio: true, captureWire: true });
    const bytes = pcm(352 * 4, 73);
    try {
      await stream.attach(first);
      stream.write(bytes);
      await until(
        'original cached burst',
        () => first.sessions[0].audioPackets === 4,
      );
      await stream.attach(late);
      await rendered(late, bytes);
      assertEquals(
        first.sessions[0].audioPackets,
        4,
        'sync does not append PCM',
      );
    } finally {
      await stream.close();
      first.close();
      late.close();
    }
  },
});

Deno.test({
  name:
    'RAOP review: metadata between reset and PCM cannot reuse the previous clock',
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const stream = nativeStream();
    const receiver = await startFakeRaop({
      captureAudio: true,
      captureWire: true,
    });
    try {
      await stream.attach(receiver);
      stream.write(pcm(352 * 8, 73));
      await until(
        'old epoch PCM',
        () => receiver.sessions[0].audioPackets === 8,
      );
      assertEquals(
        await raopFfiInternals.loadLibrary().symbols.raop_stream_reset(
          stream.pointer,
        ),
        0,
      );
      const count = progress(receiver.sessions[0]).length;
      assertEquals(await stream.metadata('New epoch', 'Artist', 700, 3456), 0);
      await until(
        'new metadata progress',
        () => progress(receiver.sessions[0]).length > count,
      );
      const last = progress(receiver.sessions[0]).at(-1)!;
      assertEquals(
        (last.pos - last.display) >>> 0,
        Math.floor(700 * 44100 / 1000) + 15360,
      );
    } finally {
      await stream.close();
      receiver.close();
    }
  },
});

Deno.test({
  name:
    'RAOP review: FLUSH synchronizes an empty producer without appending PCM',
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const stream = nativeStream();
    const receiver = await startFakeRaop({
      captureAudio: true,
      captureWire: true,
    });
    try {
      const handle = await stream.attach(receiver);
      stream.write(pcm(352 * 4, 81));
      await until(
        'original PCM before FLUSH',
        () => receiver.sessions[0].audioPackets === 4,
      );
      const syncs = () =>
        receiver.sessions[0].wire.filter((event) =>
          event.kind === 'control' && (event.data[1] & 0x7f) === 0x54
        ).length;
      const before = syncs();
      assertEquals(
        raopFfiInternals.loadLibrary().symbols.raop_flush(handle),
        0,
      );
      await until(
        'FLUSH sync without more input',
        () => receiver.sessions[0].flushes === 1 && syncs() > before,
      );
      assertEquals(receiver.sessions[0].audioPackets, 4);
    } finally {
      await stream.close();
      receiver.close();
    }
  },
});
