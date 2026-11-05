import { assert, assertEquals, assertRejects } from '@std/assert';
import { createHlsCache } from '../src/hls-cache.ts';

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
