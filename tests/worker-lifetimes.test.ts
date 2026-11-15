import { assertEquals, assertNotEquals, assertRejects } from '@std/assert';
import { createArtworkFactsHost } from '../src/artwork/facts-host.ts';
import { createTagReader } from '../src/scan-tags.ts';
import type { State } from '../src/state.ts';
import { LookupHost } from '../src/lookups/host.ts';
import { discoverLookups } from '../src/lookups/manifest.ts';
import { createLookupNetwork } from '../src/lookups/net.ts';
import {
  artworkStateFixture,
  waitForWorkerSignal,
} from './helpers/artwork-worker.ts';
import { eventually, lookupPlugin } from './helpers/lookup.ts';

const pixels = { width: 1, height: 1, rgba: new Uint8Array([255, 0, 0, 255]) };
const moduleUrl = (code: string) =>
  new URL(`data:application/javascript,${encodeURIComponent(code)}`);
function closeHost(
  host: { close?: () => void | Promise<void>; [Symbol.dispose]?: () => void },
) {
  return host.close ? host.close() : host[Symbol.dispose]!();
}

for (const kind of ['artwork', 'tags'] as const) {
  Deno.test(`${kind} Worker ignores a previous call's late failure without stealing its successor`, async () => {
    const state = artworkStateFixture();
    const url = moduleUrl(
      `let previous; postMessage({ready:true}); onmessage = ({data}) => {
      const call = data.call ?? 'missing-call-identity';
      if (previous) postMessage({call:previous,error:'stale failure'});
      postMessage({call, value:{thumbHash:'AQ==',dominantColor:'#ff0000'}, metadata:{common:{title:data.path}}});
      previous = call;
    };`,
    );
    const host = kind === 'artwork'
      ? createArtworkFactsHost(state, url)
      : createTagReader(state as unknown as State, url);
    try {
      if ('compute' in host) {
        await host.compute(pixels);
        assertEquals((await host.compute(pixels)).dominantColor, '#ff0000');
      } else {
        await host.read('first');
        assertEquals((await host.read('second')).common.title, 'second');
      }
    } finally {
      await closeHost(host);
    }
  });

  Deno.test(`${kind} Worker close joins admitted settings acquisition and fences restart`, async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const state = artworkStateFixture();
    const settings = {
      ...state,
      async getTyped(key: string) {
        entered.resolve();
        await release.promise;
        return await state.getTyped(key);
      },
    };
    const host = kind === 'artwork'
      ? createArtworkFactsHost(settings)
      : createTagReader(settings as unknown as State);
    const run = () =>
      'compute' in host ? host.compute(pixels) : host.read('unused');
    const close = () => closeHost(host);
    const pending = assertRejects(run);
    try {
      await entered.promise;
      const closing = close();
      assertEquals(close(), closing, 'concurrent close shares settlement');
      let settled = false;
      void Promise.resolve(closing).then(() => settled = true);
      await Promise.resolve();
      assertEquals(settled, false, 'close must join the held settings read');
      release.resolve();
      await closing;
      await pending;
      await assertRejects(run, Error, 'closed');
    } finally {
      release.resolve();
      await close();
      await pending;
    }
  });

  for (const active of [false, true]) {
    Deno.test(`${kind} Worker retirement during ${active ? 'call' : 'startup'} rejects once and cannot restart`, async () => {
      const entered = Promise.withResolvers<void>();
      let starts = 0;
      const server = Deno.serve(
        { hostname: '0.0.0.0', port: 0, onListen() {} },
        () => {
          starts++;
          entered.resolve();
          return new Response('entered');
        },
      );
      const notify =
        `await (await fetch('http://melofon.home:${server.addr.port}/entered')).text();`;
      const url = moduleUrl(
        active
          ? `postMessage({ready:true}); onmessage = async () => { ${notify} await new Promise(() => {}); };`
          : `${notify} setInterval(() => {}, 1000);`,
      );
      const state = artworkStateFixture();
      const host = kind === 'artwork'
        ? createArtworkFactsHost(state, url)
        : createTagReader(state as unknown as State, url);
      const run = () =>
        'compute' in host ? host.compute(pixels) : host.read('unused');
      const close = () => closeHost(host);
      let rejections = 0;
      const pending = run().then(() => {
        throw new Error('retired call succeeded');
      }, () => {
        rejections++;
      });
      try {
        await waitForWorkerSignal(entered.promise, 'worker entry');
        await close();
        await waitForWorkerSignal(pending, 'retirement rejection', 1000);
        assertEquals(rejections, 1);
        await assertRejects(run, Error, 'closed');
        assertEquals(starts, 1);
      } finally {
        await close();
        // The production timeouts bound cleanup even against the old owner.
        await server.shutdown();
      }
    });
  }
}

Deno.test('lookup Worker stop joins parent RPC cleanup after rejecting its call', async () => {
  const dir = await Deno.makeTempDir();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  await lookupPlugin(
    `${dir}/lookups`,
    'export default { async cover(item, ctx) { await ctx.fetch("https://fixture.test/held"); return {candidates:[]}; } };',
  );
  const network = createLookupNetwork();
  const host = new LookupHost(
    (await discoverLookups(`${dir}/lookups`, `${dir}/data`))[0],
    {
      ...network,
      async fetch(_authority, _url, init) {
        entered.resolve();
        await release.promise;
        init?.signal?.throwIfAborted();
        return new Response('late');
      },
    },
  );
  await host.configure(true, ['fixture.test'], {});
  const pending = assertRejects(() =>
    host.call(host.plugin.manifest!.capabilities[0], {}, {
      timeoutMs: 10000,
      maxBytes: 1024,
    })
  );
  try {
    await waitForWorkerSignal(entered.promise, 'parent fetch');
    const closing = host.stop();
    await pending;
    let closed = false;
    void closing.then(() => closed = true);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assertEquals(closed, false);
    release.resolve();
    await closing;
    assertEquals(host.generation, undefined);
  } finally {
    release.resolve();
    await pending;
    await host.stop();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('tag Worker exclusive intake is acquired before the first settings await', async () => {
  const release = Promise.withResolvers<void>();
  const state = artworkStateFixture();
  const reader = createTagReader(
    {
      ...state,
      async getTyped(key: string) {
        await release.promise;
        return await state.getTyped(key);
      },
    } as unknown as State,
    moduleUrl(
      'postMessage({ready:true}); onmessage = ({data}) => postMessage({metadata:{common:{title:"first"}},call:data.call});',
    ),
  );
  const pending = reader.read('first');
  try {
    await waitForWorkerSignal(
      assertRejects(() => reader.read('second'), Error, 'busy').then(() => {}),
      'busy rejection',
      1000,
    );
    release.resolve();
    assertEquals((await pending).common.title, 'first');
  } finally {
    release.resolve();
    reader[Symbol.dispose]();
    await pending.catch(() => {});
  }
});

Deno.test('lookup Worker owns intake before readiness and explicit reenable waits for stop', async () => {
  const dir = await Deno.makeTempDir();
  await lookupPlugin(`${dir}/lookups`);
  const host = new LookupHost(
    (await discoverLookups(`${dir}/lookups`, `${dir}/data`))[0],
    createLookupNetwork(),
  );
  const call = () =>
    host.call(host.plugin.manifest!.capabilities[0], {}, {
      timeoutMs: 10000,
      maxBytes: 1024,
    });
  const first = call();
  try {
    await assertRejects(call, Error, 'intake is full');
    assertEquals(await first, { candidates: [] });
    const generation = host.generation;
    const stopping = host.stop();
    await host.configure(true, [], {});
    await stopping;
    assertEquals(await call(), { candidates: [] });
    assertNotEquals(host.generation, generation);
  } finally {
    await first;
    await host.stop();
    await Deno.remove(dir, { recursive: true });
  }
});

for (const active of [false, true]) {
  Deno.test(`lookup Worker stop during ${active ? 'call' : 'startup'} shares its join and requires explicit reenable`, async () => {
    const dir = await Deno.makeTempDir();
    const entered = Promise.withResolvers<void>();
    await lookupPlugin(
      `${dir}/lookups`,
      active
        ? 'export default { async cover(item, ctx) { ctx.log("entered"); await new Promise(() => {}); } };'
        : 'await new Promise(() => {}); export default { cover() { return {candidates:[]}; } };',
    );
    const host = new LookupHost(
      (await discoverLookups(`${dir}/lookups`, `${dir}/data`))[0],
      createLookupNetwork(),
      {
        heartbeatMs: 20,
        log: {
          event(event) {
            if (event === 'lookup_plugin_log') entered.resolve();
          },
        },
      },
    );
    const call = () =>
      host.call(host.plugin.manifest!.capabilities[0], {}, {
        timeoutMs: 10000,
        maxBytes: 1024,
      });
    let rejections = 0;
    const pending = call().then(() => {
      throw new Error('retired call succeeded');
    }, () => {
      rejections++;
    });
    try {
      if (active) await waitForWorkerSignal(entered.promise, 'lookup call');
      else await eventually(() => host.generation !== undefined);
      const stopping = host.stop();
      assertEquals(host.stop(), stopping);
      await stopping;
      await pending;
      assertEquals(rejections, 1);
      assertEquals(host.generation, undefined);
      assertEquals(host.state, 'disabled');
      await assertRejects(call, Error, 'disabled');
      await assertRejects(() => host.start(), Error, 'disabled');
    } finally {
      await host.stop();
      await pending;
      await Deno.remove(dir, { recursive: true });
    }
  });
}
