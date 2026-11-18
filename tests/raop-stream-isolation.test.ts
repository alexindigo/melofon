import { assert, assertEquals } from '@std/assert';
import {
  libraryProof,
  nativeStream,
  pcm,
  progress,
  rendered,
  startFakeRaop,
  titles,
  until,
} from './helpers/raop-isolation.ts';

Deno.test({
  name:
    'RAOP isolation: dormant metadata survives foreign replacement, purge and retirement through keepalive',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const a = nativeStream(), b = nativeStream();
    const ra = await startFakeRaop({ captureAudio: true, captureWire: true });
    const rb = await startFakeRaop({ captureAudio: true, captureWire: true });
    try {
      assertEquals(await b.metadata('Dormant B', 'Artist B', 700, 3456), 0);
      assertEquals(await a.metadata('Active A', 'Artist A', 100, 1234), 0);
      await a.attach(ra);
      a.write(pcm(704, 1));
      await rendered(ra, pcm(704, 1));
      assertEquals(await a.metadata('Replacement A', 'New A', 300, 1234), 0);
      await until(
        'A replacement receiver metadata',
        () => titles(ra.sessions[0]).some((s) => s.includes('Replacement A')),
      );
      await a.close();
      await b.attach(rb);
      await until(
        'B retained startup text',
        () => titles(rb.sessions[0]).length > 0,
      );
      assert(
        titles(rb.sessions[0]).every((s) =>
          s.includes('Dormant B') && s.includes('Artist B') &&
          !s.includes('Active A') && !s.includes('Replacement A')
        ),
      );
      b.write(pcm(704, 900));
      await rendered(rb, pcm(704, 900));
      // Use the real 25-second scheduler, not an accelerated production knob.
      await until(
        'B 25-second keepalive',
        () =>
          progress(rb.sessions[0]).some((p) =>
            p.atMs - rb.sessions[0].requests[0].atMs >= 20000
          ),
        32000,
      );
      const last = progress(rb.sessions[0]).at(-1)!;
      assertEquals(
        (last.end - last.display) >>> 0,
        Math.floor(3456 * 44100 / 1000) + 30720,
      );
      assertEquals(rb.sessions[0].sdp.includes('a=rsaaeskey:'), false);
      await libraryProof();
    } finally {
      await a.close();
      await b.close();
      ra.close();
      rb.close();
    }
  },
});

Deno.test({
  name:
    'RAOP isolation: later metadata-capable peer receives stream content when first peer wants none',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const a = nativeStream();
    const ra = await startFakeRaop({ captureAudio: true, captureWire: true });
    const rb = await startFakeRaop({ captureAudio: true, captureWire: true });
    try {
      assertEquals(await a.metadata('One stream', 'Both peers', 0, 1000), 0);
      await a.attach(ra, 0);
      await a.attach(rb, 5);
      await until(
        'late peer metadata',
        () => titles(rb.sessions[0]).length > 0,
      );
      assert(
        titles(rb.sessions[0]).every((s) =>
          s.includes('One stream') && s.includes('Both peers')
        ),
      );
      assertEquals(titles(ra.sessions[0]), []);
      a.write(pcm(704, 400));
      await Promise.all([
        rendered(ra, pcm(704, 400)),
        rendered(rb, pcm(704, 400)),
      ]);
      await libraryProof();
    } finally {
      await a.close();
      ra.close();
      rb.close();
    }
  },
});
