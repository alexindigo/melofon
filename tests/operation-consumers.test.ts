import { assert, assertEquals, assertRejects } from '@std/assert';
import { Demuxer, Muxer } from 'node-av';
import { createScan } from '../src/scan.ts';
import { createMedia } from '../src/media.ts';
import { createTagReader } from '../src/scan-tags.ts';
import { createHlsCache } from '../src/hls-cache.ts';
import { createLibraries } from '../src/libraries.ts';
import { authFixture } from './helpers/authentication.ts';
import { tagged } from './helpers/tagged.ts';

const flush = async () => {
  for (let n = 0; n < 20; n++) await Promise.resolve();
};

Deno.test('scan close cancels queued work and joins a held real tag read before store close', async () => {
  const f = await authFixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let writes = 0, disposed = false;
  const replace = f.store.catalog.replaceCatalog;
  f.store.catalog.replaceCatalog = (...args) => {
    writes++;
    return replace(...args);
  };
  const scan = createScan(f.store, createMedia(), {
    state: f.state,
    tagReader() {
      const reader = createTagReader(f.state);
      return {
        async read(path) {
          const metadata = await reader.read(path);
          entered.resolve();
          await release.promise;
          return metadata;
        },
        [Symbol.dispose]() {
          reader[Symbol.dispose]();
          disposed = true;
        },
      };
    },
  });
  try {
    await Deno.mkdir(`${f.dir}/music`);
    await tagged(`${f.dir}/music/song.mp3`, {
      TIT2: 'Song',
      TALB: 'Album',
      TPE1: 'Artist',
    });
    await createLibraries(f.store).add('Music', `${f.dir}/music`);
    const running = scan.run();
    const canceled = assertRejects(() => running, DOMException);
    assertEquals(scan.run(), running);
    await entered.promise;
    await scan.request();
    let storeClosing = false;
    const starting = scan.start({ afterCurrent: true });
    let startSettled = false;
    void starting.then(() => startSettled = true);
    const closing = scan.close();
    assertEquals(scan.close(), closing);
    const stopped = closing.then(async () => {
      assert(disposed);
      storeClosing = true;
      await f.store.close();
    });
    await flush();
    assertEquals(storeClosing, false);
    assertEquals(startSettled, false);
    for (
      const start of [
        () => scan.run(),
        () => scan.request(),
        () => scan.start(),
        () => scan.status(),
        () => scan.problems(),
      ]
    ) {
      await assertRejects(start, Error, 'Scan is closed');
    }
    release.resolve();
    await canceled;
    await starting;
    await stopped;
    assertEquals(writes, 0);
    assertEquals(disposed, true);
  } finally {
    release.resolve();
    await scan.close();
    await f.close();
  }
});

Deno.test('scan close joins request validation and does not launch its continuation', async () => {
  const f = await authFixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const list = f.store.catalog.listLibraries;
  let snapshots = 0;
  const snapshot = f.store.catalog.scanFilesSnapshot;
  f.store.catalog.listLibraries = async () => {
    entered.resolve();
    await release.promise;
    return list();
  };
  f.store.catalog.scanFilesSnapshot = () => {
    snapshots++;
    return snapshot();
  };
  const scan = createScan(f.store, undefined, { state: f.state });
  try {
    const request = scan.request();
    const canceled = assertRejects(() => request, DOMException);
    await entered.promise;
    let settled = false;
    const closing = scan.close().then(() => settled = true);
    await flush();
    assertEquals(settled, false);
    release.resolve();
    await canceled;
    await closing;
    assertEquals(snapshots, 0);
  } finally {
    release.resolve();
    await scan.close();
    await f.close();
  }
});

Deno.test('HLS close aborts a producer after its event view is released and joins cleanup', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'hls-operation-' });
  const entered = Promise.withResolvers<void>();
  const aborted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let cleaned = false;
  const cache = createHlsCache(
    async (_path, output, _options, _config, publish, signal) => {
      await Deno.mkdir(output, { recursive: true });
      await Deno.writeTextFile(`${output}/seg0.ts`, 'segment');
      await Deno.writeTextFile(
        `${output}/index.m3u8`,
        '#EXTM3U\n#EXTINF:1,\nseg0.ts\n',
      );
      await publish({ width: 160, height: 90 });
      entered.resolve();
      try {
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => {
            aborted.resolve();
            resolve();
          }, { once: true })
        );
        return null;
      } finally {
        await release.promise;
        cleaned = true;
      }
    },
    () => Promise.resolve({ width: 160, height: 90 }),
  );
  try {
    await Deno.writeTextFile(`${dir}/source`, 'source');
    const view = await cache.hls(`${dir}/source`, `${dir}/hls`);
    assert(view && !view.complete);
    await entered.promise;
    const segment = await view.segment(0);
    assert(segment);
    assertEquals(await new Response(segment).text(), 'segment');
    await view.release();
    let settled = false;
    const closing = cache.close();
    assertEquals(cache.close(), closing);
    void closing.then(() => settled = true);
    await aborted.promise;
    assertEquals(settled, false);
    await assertRejects(
      () => cache.hls(`${dir}/source`, `${dir}/hls`),
      Error,
      'HLS is closed',
    );
    release.resolve();
    await closing;
    assert(cleaned);
    assertEquals(Array.from(Deno.readDirSync(`${dir}/hls`)), []);
    await view.release();
  } finally {
    release.resolve();
    await cache.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('HLS close joins admitted source inspection without starting a producer', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'hls-inspection-operation-' });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let producers = 0;
  const cache = createHlsCache(() => {
    producers++;
    return Promise.resolve(null);
  }, async () => {
    entered.resolve();
    await release.promise;
    return { width: 160, height: 90 };
  });
  try {
    await Deno.writeTextFile(`${dir}/source`, 'source');
    const request = cache.hls(`${dir}/source`, `${dir}/hls`);
    const canceled = assertRejects(() => request, DOMException);
    await entered.promise;
    let settled = false;
    const closing = cache.close().then(() => settled = true);
    await flush();
    assertEquals(settled, false);
    release.resolve();
    await canceled;
    await closing;
    assertEquals(producers, 0);
  } finally {
    release.resolve();
    await cache.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('media close joins real HLS native teardown before returning', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'media-operation-' });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const write = Muxer.prototype.writePacket;
  const inputClose = Demuxer.prototype.close;
  let holding = true, inputsClosed = 0;
  Muxer.prototype.writePacket = async function (...args) {
    if (holding) {
      holding = false;
      entered.resolve();
      await release.promise;
    }
    return write.apply(this, args);
  };
  Demuxer.prototype.close = async function () {
    await inputClose.call(this);
    inputsClosed++;
  };
  const media = createMedia();
  let request: ReturnType<typeof media.hls> | undefined;
  try {
    request = media.hls(
      'tests/fixtures/library/Fixture Artist/Fixture Album/03 - Clip.mp4',
      `${dir}/hls`,
    );
    await entered.promise;
    let settled = false;
    const closing = media.close();
    assertEquals(media.close(), closing);
    void closing.then(() => settled = true);
    await flush();
    assertEquals(settled, false);
    release.resolve();
    await closing;
    assertEquals(await request, null);
    assert(
      inputsClosed >= 2,
      'source inspection and encode inputs must both close',
    );
    assertEquals(Array.from(Deno.readDirSync(`${dir}/hls`)), []);
    await assertRejects(
      () => media.hls('unopened', `${dir}/hls`),
      Error,
      'HLS is closed',
    );
  } finally {
    release.resolve();
    await media.close();
    await request;
    Muxer.prototype.writePacket = write;
    Demuxer.prototype.close = inputClose;
    await Deno.remove(dir, { recursive: true });
  }
});
