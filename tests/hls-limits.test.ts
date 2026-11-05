import { assert, assertEquals, assertRejects } from '@std/assert';
import { createHlsCache } from '../src/hls-cache.ts';
import { openStore } from '../src/store/index.ts';
import { createState } from '../src/state.ts';

Deno.test('HLS admission rejects the whole request before probing or producing any rung', async () => {
  let probes = 0, producers = 0;
  const cache = createHlsCache(
    () => {
      producers++;
      return Promise.resolve(null);
    },
    undefined,
    () => {
      probes++;
      return Promise.resolve({ width: 320, height: 180 });
    },
  );
  for (
    const options of [
      Array.from({ length: 9 }, () => ({ kbps: 100 })),
      [{ kbps: 100 }, { kbps: 100001 }],
      [{ width: 60000, height: 60000 }],
      [{ width: 160, height: 181 }],
    ]
  ) {
    const failure = await assertRejects(() =>
      cache.hlsRenditions('unopened', 'uncreated', options)
    );
    assert(failure instanceof Error && failure.name === 'HlsError');
  }
  assertEquals(probes, 0);
  assertEquals(producers, 0);
  const root = await Deno.makeTempDir({ prefix: 'melofon-hls-source-' });
  try {
    await Deno.writeTextFile(`${root}/source`, 'source');
    await assertRejects(() =>
      cache.hls(`${root}/source`, `${root}/hls`, { width: 322, height: 180 })
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
  assertEquals(probes, 1);
  assertEquals(producers, 0);
});

Deno.test('HLS cache identity follows encoding settings while live admission limits gate persisted reuse', async () => {
  const root = await Deno.makeTempDir({ prefix: 'melofon-hls-cache-policy-' });
  const store = await openStore(`${root}/db`);
  const state = createState(store);
  const path = `${root}/source`;
  let producers = 0;
  const produce: Parameters<typeof createHlsCache>[0] = async (_path, dir) => {
    producers++;
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(`${dir}/seg0.ts`, `encoded-${producers}`);
    await Deno.writeTextFile(
      `${dir}/index.m3u8`,
      '#EXTM3U\n#EXTINF:1,\nseg0.ts\n#EXT-X-ENDLIST\n',
    );
    return { width: 160, height: 90 };
  };
  const reopen = () =>
    createHlsCache(
      produce,
      state,
      () => Promise.resolve({ width: 320, height: 180 }),
    );
  let cache = reopen();
  const options = { kbps: 100, width: 160, height: 90 };
  async function consume(expected: number) {
    const view = await cache.hls(path, `${root}/hls`, options);
    assert(view?.complete);
    try {
      const segment = await view.segment(0);
      assert(segment);
      assertEquals(await new Response(segment).text(), `encoded-${expected}`);
    } finally {
      await view.release();
    }
    assertEquals(producers, expected);
  }
  try {
    await Deno.writeTextFile(path, 'source');
    await consume(1);
    for (
      const [name, value] of Object.entries({
        maxRenditions: '2',
        maxDimension: '320',
        maxKbps: '400',
      })
    ) {
      await state.set(`media.hls.${name}`, value);
      await consume(1);
      cache = reopen();
      await consume(1);
    }
    await state.set('media.hls.maxKbps', '99');
    await assertRejects(() => cache.hls(path, `${root}/hls`, options));
    assertEquals(producers, 1);
    await state.set('media.hls.maxKbps', '400');
    await consume(1);
    // Each encoding setting remains part of persistent rendition identity.
    let expected = 1;
    for (
      const [name, value] of Object.entries({
        segmentSeconds: '2',
        audioKbps: '64',
        videoKbps: '300',
        preset: 'fast',
        threads: '1',
        quality: '20',
        ladder: '100@160x90',
      })
    ) {
      await state.set(`media.hls.${name}`, value);
      cache = reopen();
      await consume(++expected);
    }
  } finally {
    await store.close();
    await Deno.remove(root, { recursive: true });
  }
});

async function sourceFixture() {
  const root = await Deno.makeTempDir({ prefix: 'melofon-hls-source-facts-' });
  const store = await openStore(`${root}/db`);
  const state = createState(store);
  const path = `${root}/source`;
  await Deno.writeTextFile(path, 'medium');
  let probes = 0;
  const dimensions = (text: string) =>
    text === 'small'
      ? { width: 160, height: 90 }
      : text === 'large'
      ? { width: 640, height: 360 }
      : { width: 320, height: 180 };
  const cache = createHlsCache(
    async (path, dir, options) => {
      const text = await Deno.readTextFile(path);
      await Deno.mkdir(dir, { recursive: true });
      await Deno.writeTextFile(`${dir}/seg0.ts`, text);
      await Deno.writeTextFile(
        `${dir}/index.m3u8`,
        '#EXTM3U\n#EXTINF:1,\nseg0.ts\n#EXT-X-ENDLIST\n',
      );
      const source = dimensions(text);
      return {
        width: options.width ?? source.width,
        height: options.height ?? source.height,
      };
    },
    state,
    async (path) => {
      probes++;
      const text = await Deno.readTextFile(path);
      return text === 'broken' ? null : dimensions(text);
    },
  );
  return {
    root,
    path,
    state,
    cache,
    probes: () => probes,
    async segment(expected: string) {
      const view = await cache.hls(path, `${root}/hls`, {
        width: 160,
        height: 90,
      });
      assert(view?.complete);
      try {
        const segment = await view.segment(0);
        assert(segment);
        assertEquals(await new Response(segment).text(), expected);
      } finally {
        await view.release();
      }
    },
    async close() {
      await store.close();
      await Deno.remove(root, { recursive: true });
    },
  };
}

Deno.test('HLS source facts are shared across segment reads and concurrent requests, refreshed by size or mtime, and never bypass live limits', async () => {
  const f = await sourceFixture();
  try {
    await Promise.all(Array.from({ length: 4 }, () => f.segment('medium')));
    await f.segment('medium');
    assertEquals(f.probes(), 1);
    await f.state.set('media.hls.maxDimension', '200');
    await assertRejects(() => f.cache.hls(f.path, `${f.root}/hls`));
    assertEquals(
      f.probes(),
      1,
      'live geometry admission uses cached source facts',
    );
    await f.state.set('media.hls.maxDimension', '4096');
    const before = (await Deno.stat(f.path)).mtime!;
    await Deno.writeTextFile(f.path, 'small');
    await Deno.utime(f.path, before, before);
    await f.segment('small');
    assertEquals(f.probes(), 2, 'size change alone refreshes source facts');
    await assertRejects(() =>
      f.cache.hls(f.path, `${f.root}/hls`, { width: 320, height: 180 })
    );
    assertEquals(f.probes(), 2, 'updated source dimensions reject upscaling');
    await Deno.writeTextFile(f.path, 'large');
    await Deno.utime(f.path, before, new Date(before.getTime() + 2000));
    await f.segment('large');
    assertEquals(
      f.probes(),
      3,
      'mtime change alone refreshes same-size source facts',
    );
    await f.segment('large');
    assertEquals(f.probes(), 3);
    // Reusing an older output must attach the current inspection record, too.
    await Deno.writeTextFile(f.path, 'medium');
    await Deno.utime(f.path, before, before);
    await f.segment('medium');
    assertEquals(f.probes(), 4);
    await f.segment('medium');
    assertEquals(
      f.probes(),
      4,
      'returning to a cached identity retains refreshed facts',
    );
    await Deno.rename(f.path, `${f.root}/moved`);
    assertEquals(await f.cache.hls(f.path, `${f.root}/hls`), null);
    await Deno.rename(`${f.root}/moved`, f.path);
    await f.segment('medium');
    assertEquals(f.probes(), 5);
    await f.segment('medium');
    assertEquals(
      f.probes(),
      5,
      'source restoration does not resume per-segment inspection',
    );
  } finally {
    await f.close();
  }
});

Deno.test('HLS source facts follow output leases and budget eviction, while rejected and failed probes leave no retained cache', async () => {
  const f = await sourceFixture();
  try {
    await f.segment('medium');
    await f.state.set('media.hlsCacheMegabytes', '0');
    const view = await f.cache.hls(f.path, `${f.root}/hls`, {
      width: 160,
      height: 90,
    });
    assert(view);
    const body = await view.segment(0);
    assert(body);
    await view.release();
    await f.segment('medium');
    assertEquals(f.probes(), 1, 'open segment lease retains source facts');
    await body.cancel();
    await f.segment('medium');
    assertEquals(
      f.probes(),
      2,
      'evicting the final output retires source facts',
    );
    await f.state.set('media.hlsCacheMegabytes', '2048');
    for (let i = 0; i < 2; i++) {
      await assertRejects(() =>
        f.cache.hls(f.path, `${f.root}/hls`, { width: 322, height: 180 })
      );
    }
    assertEquals(
      f.probes(),
      4,
      'requests with no admitted output retain no facts',
    );
    await Deno.writeTextFile(f.path, 'broken');
    for (let i = 0; i < 2; i++) {
      assertEquals(await f.cache.hls(f.path, `${f.root}/hls`), null);
    }
    assertEquals(
      f.probes(),
      6,
      'failed probes are retried rather than retained',
    );
  } finally {
    await f.close();
  }
});
