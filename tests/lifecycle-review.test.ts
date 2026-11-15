import { assert, assertEquals, assertRejects } from '@std/assert';
import { createHlsCache } from '../src/hls-cache.ts';
import { createTagReader } from '../src/scan-tags.ts';
import { createScan } from '../src/scan.ts';
import { createLibraries } from '../src/libraries.ts';
import { createOutputs } from '../src/player.ts';
import { createSpeakers } from '../src/speakers.ts';
import { PlaybackError } from '../src/playback-errors.ts';
import type { State } from '../src/state.ts';
import { authFixture } from './helpers/authentication.ts';
import {
  artworkStateFixture,
  waitForWorkerSignal,
} from './helpers/artwork-worker.ts';

async function turns() {
  for (let n = 0; n < 20; n++) await Promise.resolve();
}

for (const phase of ['startup', 'call'] as const) {
  Deno.test(`tag read cancellation retires its ${phase} without closing reader intake`, async () => {
    const entered = Promise.withResolvers<void>();
    const enteredAgain = Promise.withResolvers<void>();
    let starts = 0;
    const server = Deno.serve(
      { hostname: '0.0.0.0', port: 0, onListen() {} },
      () => {
        starts++;
        entered.resolve();
        if (starts === 2) enteredAgain.resolve();
        return new Response('entered');
      },
    );
    const notify =
      `await (await fetch('http://melofon.home:${server.addr.port}/entered')).text();`;
    const code = phase === 'startup'
      ? `${notify} setInterval(() => {}, 1000);`
      : `postMessage({ready:true}); onmessage = async () => { ${notify} };`;
    const state = artworkStateFixture();
    const reader = createTagReader(
      state as unknown as State,
      new URL(`data:application/javascript,${encodeURIComponent(code)}`),
    );
    state.set('scan.tagParseTimeoutSeconds', '5');
    state.set('scan.tagWorkerStartupSeconds', '5');
    const controller = new AbortController();
    const rejected = assertRejects(() =>
      reader.read('held', controller.signal)
    );
    try {
      await waitForWorkerSignal(entered.promise, 'tag entry');
      controller.abort();
      await waitForWorkerSignal(
        rejected.then(() => {}),
        'tag cancellation',
        1000,
      );
      // A retired session is not a closed owner: the next read can start afresh.
      const again = new AbortController();
      const next = assertRejects(() => reader.read('next', again.signal));
      await waitForWorkerSignal(enteredAgain.promise, 'replacement tag entry');
      again.abort();
      await waitForWorkerSignal(next.then(() => {}), 'next cancellation', 1000);
      assertEquals(starts, 2);
    } finally {
      await reader.close();
      await rejected;
      await server.shutdown();
    }
  });
}

Deno.test('completed tag reads remove cancellation authority before a successor reuses the worker', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const server = Deno.serve(
    { hostname: '0.0.0.0', port: 0, onListen() {} },
    async () => {
      entered.resolve();
      await release.promise;
      return new Response('released');
    },
  );
  const code = `postMessage({ready:true}); onmessage = async ({data}) => {
    if (data.path === 'second') await (await fetch('http://melofon.home:${server.addr.port}/held')).text();
    postMessage({call:data.call,metadata:{common:{title:data.path}}});
  };`;
  const reader = createTagReader(
    artworkStateFixture() as unknown as State,
    new URL(`data:application/javascript,${encodeURIComponent(code)}`),
  );
  const previous = new AbortController();
  let second: ReturnType<typeof reader.read> | undefined;
  try {
    assertEquals(
      (await reader.read('first', previous.signal)).common.title,
      'first',
    );
    second = reader.read('second');
    void second.catch(() => {});
    await waitForWorkerSignal(entered.promise, 'successor tag read');
    previous.abort();
    release.resolve();
    assertEquals((await second).common.title, 'second');
  } finally {
    release.resolve();
    await reader.close();
    await second?.catch(() => {});
    await server.shutdown();
  }
});

Deno.test('tag read cancellation during settings prevents a worker from starting', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const state = artworkStateFixture();
  const reader = createTagReader(
    {
      ...state,
      async getTyped(key: string) {
        entered.resolve();
        await release.promise;
        return state.getTyped(key);
      },
    } as unknown as State,
    new URL('data:application/javascript,throw new Error("must not start")'),
  );
  const controller = new AbortController();
  const rejected = assertRejects(
    () => reader.read('held', controller.signal),
    Error,
    'closed',
  );
  try {
    await entered.promise;
    controller.abort();
    release.resolve();
    await rejected;
    await assertRejects(
      () => reader.read('already aborted', controller.signal),
      Error,
      'closed',
    );
  } finally {
    release.resolve();
    await reader.close();
  }
});

Deno.test('scan close cancels an in-flight tag Worker rather than waiting for its parse budget', async () => {
  const f = await authFixture();
  const entered = Promise.withResolvers<void>();
  const server = Deno.serve(
    { hostname: '0.0.0.0', port: 0, onListen() {} },
    () => {
      entered.resolve();
      return new Response('entered');
    },
  );
  const url = new URL(`data:application/javascript,${
    encodeURIComponent(
      `postMessage({ready:true}); onmessage = async () => { await (await fetch('http://melofon.home:${server.addr.port}/entered')).text(); };`,
    )
  }`);
  const scan = createScan(f.store, undefined, {
    state: f.state,
    tagReader: () => createTagReader(f.state, url),
  });
  let writes = 0;
  const replace = f.store.catalog.replaceCatalog;
  f.store.catalog.replaceCatalog = (...args) => {
    writes++;
    return replace(...args);
  };
  try {
    await f.state.set('scan.tagParseTimeoutSeconds', '5');
    await Deno.mkdir(`${f.dir}/music`);
    await Deno.writeTextFile(
      `${f.dir}/music/held.mp3`,
      'tag read stays pending',
    );
    await createLibraries(f.store).add('Music', `${f.dir}/music`);
    const rejected = assertRejects(() => scan.run(), DOMException);
    await waitForWorkerSignal(entered.promise, 'scan tag entry');
    await waitForWorkerSignal(scan.close(), 'scan cancellation', 1000);
    await rejected;
    await f.store.close();
    assertEquals(writes, 0);
  } finally {
    await scan.close();
    await server.shutdown();
    await f.close();
  }
});

for (const timing of ['admitted', 'late'] as const) {
  Deno.test(`HLS ${timing} segment cleanup respects cache close settlement`, async () => {
    const dir = await Deno.makeTempDir();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let armed = false, closed = false;
    const values = new Map<string, unknown>();
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
          assertEquals(closed, false, 'late cleanup cannot read settings');
          if (armed && key === 'media.hlsCacheMegabytes') {
            entered.resolve();
            await release.promise;
            return 0;
          }
          return values.get(key) as Awaited<ReturnType<State['getTyped']>>;
        },
      },
    );
    let body: ReadableStream<Uint8Array> | null = null;
    let cancel: Promise<void> | undefined;
    try {
      await Deno.writeTextFile(`${dir}/source`, 'source');
      const view = await cache.hls(`${dir}/source`, `${dir}/hls`);
      assert(view);
      body = await view.segment(0);
      assert(body);
      await view.release();
      if (timing === 'admitted') {
        armed = true;
        cancel = body.cancel();
        await entered.promise;
        const closing = cache.close().then(() => closed = true);
        await turns();
        assertEquals(closed, false, 'close must join segment eviction');
        release.resolve();
        await Promise.all([cancel, closing]);
        assertEquals([...Deno.readDirSync(`${dir}/hls`)], []);
      } else {
        await cache.close();
        closed = true;
        await body.cancel();
        assertEquals([...Deno.readDirSync(`${dir}/hls`)].length, 1);
      }
    } finally {
      release.resolve();
      await cancel;
      await body?.cancel().catch(() => {});
      await cache.close();
      await Deno.remove(dir, { recursive: true });
    }
  });
}

for (
  const change of [
    'deselect',
    'move',
    'move-back',
    'endpoint',
    'withdraw',
  ] as const
) {
  Deno.test(`speaker preflight revalidates ${change} after peer cleanup`, async () => {
    const outputs = createOutputs();
    for (const id of ['winner', 'loser']) {
      outputs.register({
        id,
        name: id,
        type: 'AirPlay',
        host: '192.0.2.1',
        selected: true,
        volume: 50,
      });
    }
    const cleanup = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    const speakers = createSpeakers({
      outputs,
      adapterView: () => ({
        preparation: { state: 'unresolved', targetRevision: 1 },
      }),
      async prepare(id, signal) {
        if (id === 'winner') return true;
        signal.addEventListener('abort', () => aborted.resolve(), {
          once: true,
        });
        await aborted.promise;
        await cleanup.promise;
        return false;
      },
    });
    const work = speakers.preparePlayback(new AbortController().signal);
    const rejected = assertRejects(() => work, PlaybackError, 'prepared');
    void rejected.catch(() => {});
    try {
      await aborted.promise;
      if (change === 'deselect') outputs.setMembers(1, ['loser']);
      if (change === 'move' || change === 'move-back') {
        outputs.setMembers(2, ['winner']);
      }
      if (change === 'move-back') outputs.setMembers(1, ['winner', 'loser']);
      if (change === 'endpoint') {
        outputs.register({ ...outputs.get('winner')!, host: '192.0.2.2' });
      }
      if (change === 'withdraw') outputs.withdraw('winner');
      cleanup.resolve();
      const error = await rejected;
      assertEquals(error.code, 'target_unavailable');
    } finally {
      cleanup.resolve();
      await work.catch(() => {});
    }
  });
}
