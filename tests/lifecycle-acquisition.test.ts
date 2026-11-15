import { assert, assertEquals, assertRejects } from '@std/assert';
import { createHlsCache } from '../src/hls-cache.ts';
import { createLibraries } from '../src/libraries.ts';
import { createNotify, type NotifyFn } from '../src/notify.ts';
import { createScan } from '../src/scan.ts';
import type { State } from '../src/state.ts';
import { authFixture } from './helpers/authentication.ts';
import { tagged } from './helpers/tagged.ts';

async function turns() {
  for (let n = 0; n < 20; n++) await Promise.resolve();
}

for (const phase of ['queued', 'opened'] as const) {
  Deno.test(`HLS close owns ${phase} segment acquisition and releases unpublished resources`, async () => {
    const dir = await Deno.makeTempDir();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const values = new Map<string, unknown>();
    let armed = false, closed = false, opens = 0;
    let file: Deno.FsFile | undefined;
    const open = Deno.open;
    const cache = createHlsCache(
      async (_path, output) => {
        await Deno.mkdir(output, { recursive: true });
        await Deno.writeTextFile(`${output}/seg0.ts`, 'segment');
        await Deno.writeTextFile(
          `${output}/index.m3u8`,
          '#EXTM3U\n#EXTINF:1,\nseg0.ts\n#EXT-X-ENDLIST\n',
        );
        return { width: 160, height: 90 };
      },
      () => Promise.resolve({ width: 160, height: 90 }),
      {
        declare(key, schema) {
          values.set(key, (schema as { default: unknown }).default);
        },
        async getTyped(key) {
          assertEquals(closed, false, 'no settings access after close');
          if (armed && key === 'media.hlsCacheMegabytes') {
            entered.resolve();
            await release.promise;
            return 0;
          }
          return values.get(key) as Awaited<ReturnType<State['getTyped']>>;
        },
      },
    );
    let acquiring: Promise<ReadableStream<Uint8Array> | null> | undefined;
    let releasing: Promise<void> | undefined;
    try {
      await Deno.writeTextFile(`${dir}/source`, 'source');
      const view = await cache.hls(`${dir}/source`, `${dir}/hls`);
      assert(view);
      const peer = await cache.hls(`${dir}/source`, `${dir}/hls`);
      assert(peer);
      Deno.open = async (...args) => {
        opens++;
        file = await open(...args);
        entered.resolve();
        await release.promise;
        return file;
      };
      if (phase === 'queued') {
        armed = true;
        releasing = peer.release();
        await entered.promise;
      } else await peer.release();
      acquiring = view.segment(0);
      // Attach both branches immediately: the fixed owner rejects on cancellation.
      const outcome = acquiring.then(
        (body) => ({ body, error: undefined }),
        (error: unknown) => ({ body: null, error }),
      );
      if (phase === 'opened') await entered.promise;
      const closing = cache.close();
      assertEquals(cache.close(), closing);
      void closing.then(() => closed = true);
      await turns();
      if (phase === 'opened') {
        assertEquals(
          closed,
          false,
          'close must join the held file acquisition',
        );
      }
      release.resolve();
      const result = await outcome;
      await Promise.all([closing, releasing]);
      // Always dispose a wrongly published BASE stream before asserting.
      await result.body?.cancel();
      assert(
        result.error instanceof DOMException,
        'revoked acquisition rejects',
      );
      assertEquals(
        result.body,
        null,
        'no stream may publish after cancellation',
      );
      assertEquals(opens, phase === 'opened' ? 1 : 0);
      if (file) {
        await assertRejects(() => file!.stat(), Deno.errors.BadResource);
      }
      await view.release();
      assertEquals(await view.segment(0), null);
    } finally {
      release.resolve();
      const body = await acquiring?.catch(() => null);
      await body?.cancel().catch(() => {});
      await releasing;
      Deno.open = open;
      await cache.close();
      await Deno.remove(dir, { recursive: true });
    }
  });
}

Deno.test('cancelled scan announces committed catalog changes before joining close', async () => {
  const notify = createNotify();
  const f = await authFixture(notify);
  const scan = createScan(f.store, undefined, { state: f.state, notify });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const events: Parameters<NotifyFn>[] = [];
  let reconciliations = 0;
  try {
    const root = `${f.dir}/music`;
    await Deno.mkdir(root);
    const library = await createLibraries(f.store).add('Music', root);
    // Establish a real unavailable -> available change as well as a new song.
    await Deno.remove(root);
    await scan.run();
    assertEquals((await f.store.catalog.listLibraries())[0].available, false);
    await Deno.mkdir(root);
    await tagged(`${root}/song.mp3`, { TIT2: 'Committed song', TALB: 'Album' });
    const replace = f.store.catalog.replaceCatalog;
    f.store.catalog.replaceCatalog = async (...args) => {
      entered.resolve();
      await release.promise;
      return replace(...args);
    };
    const reconcile = f.store.candidates.replaceLocal;
    f.store.candidates.replaceLocal = (...args) => {
      reconciliations++;
      return reconcile(...args);
    };
    notify.subscribe((...args) => events.push(args));
    const running = scan.run();
    const rejected = assertRejects(() => running, DOMException);
    await entered.promise;
    let closed = false;
    const closing = scan.close().then(() => closed = true);
    await turns();
    assertEquals(closed, false, 'close must join the admitted catalog write');
    release.resolve();
    await Promise.all([rejected, closing]);
    assertEquals(
      (await f.store.catalog.scanFilesSnapshot()).map((song) => song.title),
      ['Committed song'],
    );
    assertEquals((await f.store.catalog.listLibraries())[0].available, true);
    assertEquals(
      events.filter(([types]) =>
        types.includes('library') || types.includes('libraries')
      ),
      [
        [['library'], undefined, 'all'],
        [['libraries'], { libraries: [library.id] }, 'admins'],
      ],
    );
    assertEquals(
      reconciliations,
      0,
      'cancellation still prevents candidate work',
    );
    assertEquals(events.some(([types]) => types.includes('database')), false);
  } finally {
    release.resolve();
    await scan.close();
    await f.close();
  }
});
