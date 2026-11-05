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
  await assertRejects(() =>
    cache.hls('unopened', 'uncreated', { width: 322, height: 180 })
  );
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
