import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertThrows,
} from '@std/assert';
import { LookupHost, parseResult } from '../src/lookups/host.ts';
import { discoverLookups } from '../src/lookups/manifest.ts';
import { createLookupNetwork } from '../src/lookups/net.ts';
import { eventually, lookupManifest, lookupPlugin } from './helpers/lookup.ts';

Deno.test('lookup worker-options are enabled under the direct test gate', async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/index.js`, 'postMessage("ready");');
    const worker = new Worker(new URL(`file://${dir}/index.js`).href, {
      type: 'module',
      deno: { permissions: { net: false, read: [dir] } },
    });
    try {
      const ready = await new Promise((resolve, reject) => {
        worker.onmessage = (event) => resolve(event.data);
        worker.onerror = (event) => {
          event.preventDefault();
          reject(new Error(event.message));
        };
      });
      assertEquals(ready, 'ready');
    } finally {
      worker.terminate();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

async function withHost(
  code: string,
  fn: (host: LookupHost, dir: string) => void | Promise<void>,
  timing = {},
) {
  const dir = await Deno.makeTempDir();
  await lookupPlugin(`${dir}/lookups`, code);
  const plugin = (await discoverLookups(`${dir}/lookups`, `${dir}/data`))[0];
  const host = new LookupHost(plugin, createLookupNetwork(), {
    heartbeatMs: 20,
    livenessMs: 200,
    ...timing,
  });
  try {
    await fn(host, dir);
  } finally {
    await host.stop();
    await Deno.remove(dir, { recursive: true });
  }
}
const call = (host: LookupHost, item: unknown = {}, timeoutMs = 1000) =>
  host.call(host.plugin.manifest!.capabilities[0], item, {
    timeoutMs,
    maxBytes: 1024,
  });

Deno.test('lookup Worker sandbox denies outside reads, writes, env, ffi, run, sys, imports and unapproved network', async () => {
  await withHost(
    `export default { async cover(item, ctx) {
    const denied = {};
    for (const [key, operation] of Object.entries({
      outside: () => Deno.readTextFile(item.outside),
      write: () => Deno.writeTextFile(item.inside, 'bad'),
      env: () => Deno.env.get('HOME'),
      ffi: () => Deno.dlopen(item.inside, {}),
      run: () => new Deno.Command('/usr/bin/true').output(),
      sys: () => Deno.hostname(),
      network: () => fetch('http://127.0.0.1:1/'),
      import: () => import('https://forbidden.test/code.ts'),
    })) { try { await operation(); denied[key] = false; } catch { denied[key] = true; } }
    const own = await Deno.readTextFile(item.inside);
    let rpcDenied = false;
    try { await ctx.fetch('https://forbidden.test/image'); } catch { rpcDenied = true; }
    return { candidates: [{ target:{type:'album', id:'album'}, confidence:'strong', values:{'album.image.front':{url:'https://fixture.test/image'}}, evidence:{denied,own,rpcDenied} }] };
  } };`,
    async (host, dir) => {
      await Deno.writeTextFile(`${dir}/outside`, 'secret');
      await Deno.writeTextFile(`${host.plugin.dir}/inside`, 'own');
      const result = await call(host, {
        outside: `${dir}/outside`,
        inside: `${host.plugin.dir}/inside`,
      });
      assert('candidates' in result);
      assertEquals(result.candidates[0].evidence, {
        denied: {
          outside: true,
          write: true,
          env: true,
          ffi: true,
          run: true,
          sys: true,
          network: true,
          import: true,
        },
        own: 'own',
        rpcDenied: true,
      });
    },
  );
});
Deno.test('lookup granted hosts remain RPC-only: native fetch and sockets are denied while ctx.fetch uses the network service', async () => {
  const dir = await Deno.makeTempDir();
  const hits: { path: string; userAgent: string | null }[] = [];
  const logs: unknown[] = [];
  const server = Deno.serve(
    { port: 0, hostname: '127.0.0.1', onListen() {} },
    (request) => {
      hits.push({
        path: new URL(request.url).pathname,
        userAgent: request.headers.get('user-agent'),
      });
      return new Response('fixture RPC');
    },
  );
  let host: LookupHost | undefined;
  try {
    await lookupPlugin(
      `${dir}/lookups`,
      `export default { async cover(item, ctx) {
        const denied = {};
        for (const [name, operation] of Object.entries({
          fetch: async () => { const response = await fetch(item.direct); await response.text(); },
          socket: async () => { const connection = await Deno.connect({hostname:'127.0.0.1', port:item.port}); connection.close(); },
        })) {
          try { await operation(); denied[name] = false; }
          catch (error) { denied[name] = error instanceof Deno.errors.NotCapable || error instanceof Deno.errors.PermissionDenied; }
        }
        const body = await (await ctx.fetch('http://127.0.0.1/rpc')).text();
        return {candidates:[{target:{type:'album',id:'album'},confidence:'strong',values:{'album.image.front':{url:'http://127.0.0.1/image'}},evidence:{denied,body}}]};
      } };`,
      'fixture',
      lookupManifest({
        network: { hosts: ['127.0.0.1'], ratePerMinute: 600000 },
      }),
    );
    const network = createLookupNetwork({
      fixtures: { '127.0.0.1': `http://127.0.0.1:${server.addr.port}` },
      log: {
        event(event, facts) {
          if (event === 'lookup_request') logs.push(facts);
        },
      },
    });
    host = new LookupHost(
      (await discoverLookups(`${dir}/lookups`, `${dir}/data`))[0],
      network,
    );
    await host.configure(true, ['127.0.0.1'], {});
    const result = await call(host, {
      direct: `http://127.0.0.1:${server.addr.port}/direct`,
      port: server.addr.port,
    });
    assert('candidates' in result);
    assertEquals(result.candidates[0].evidence, {
      denied: { fetch: true, socket: true },
      body: 'fixture RPC',
    });
    assertEquals(hits, [{
      path: '/rpc',
      userAgent: 'Melofon/0.1.0 (+https://github.com/alexindigo/melofon)',
    }]);
    assertEquals(logs, [{ plugin: 'fixture', host: '127.0.0.1', status: 200 }]);
  } finally {
    await host?.stop();
    await server.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
});
Deno.test('lookup read authority refuses escaping data symlinks added after discovery', async () => {
  await withHost(
    `export default { cover() { return {candidates:[]}; } };`,
    async (host, dir) => {
      await Deno.writeTextFile(`${dir}/secret`, 'outside');
      await Deno.symlink(`${dir}/secret`, `${host.plugin.dir}/escape`);
      await assertRejects(() => host.start(), Error, 'escapes plugin folder');
      assertEquals(host.generation, undefined);
    },
  );
});
Deno.test('lookup grant shrink terminates pending work and replaces the generation without replay', async () => {
  await withHost(
    `export default { async cover(item, ctx) { await new Promise(r => ctx.signal.addEventListener('abort', r)); return {candidates:[]}; } };`,
    async (host) => {
      await host.configure(true, ['fixture.test'], {});
      await host.start();
      const generation = host.generation;
      const pending = call(host);
      const rejected = assertRejects(() => pending);
      await new Promise((resolve) => setTimeout(resolve, 30));
      host.revoke('grant shrank');
      assertEquals(host.generation, undefined);
      await rejected;
      await host.configure(true, [], {});
      await host.start();
      assertNotEquals(host.generation, generation);
      assertEquals(host.authority.hosts, []);
    },
  );
});
Deno.test('lookup approved wildcard network grants start independently from forbidden imports', async () => {
  await withHost(
    `export default { cover(){return {candidates:[]};} };`,
    async (host) => {
      await host.configure(true, ['*.images.test'], {});
      await host.start();
      assertEquals(host.authority.hosts, ['*.images.test']);
      assertEquals(await call(host), { candidates: [] });
    },
  );
});
Deno.test('lookup disable revokes intake and runs disposers in reverse even after an error', async () => {
  const events: unknown[] = [];
  const dir = await Deno.makeTempDir();
  try {
    await lookupPlugin(
      `${dir}/lookups`,
      `export default { cover(item, ctx) { ctx.onDispose(() => ctx.log('first')); ctx.onDispose(() => { ctx.log('second'); throw Error('dispose failed'); }); return {candidates:[]}; } };`,
    );
    const host = new LookupHost(
      (await discoverLookups(`${dir}/lookups`, `${dir}/data`))[0],
      createLookupNetwork(),
      {
        log: {
          event(event, facts) {
            if (event === 'lookup_plugin_log') events.push(facts);
          },
        },
      },
    );
    await call(host);
    await host.configure(false, [], {});
    assertEquals(host.state, 'disabled');
    await assertRejects(() => call(host), Error, 'disabled');
    assertEquals(events.map((v) => (v as { payload: string[] }).payload[0]), [
      'second',
      'Error: dispose failed',
      'first',
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
Deno.test('lookup missing heartbeats fail isolated CPU-bound Workers and bounded calls time out', async () => {
  await withHost(
    `export default { cover() { while(true) {} } };`,
    async (host) => {
      await host.start();
      await assertRejects(() => call(host, {}, 2000), Error, 'heartbeat');
      assertEquals(host.state, 'failed');
    },
  );
  await withHost(
    `export default { cover() { return new Promise(() => {}); } };`,
    async (host) => {
      await assertRejects(() => call(host, {}, 30), Error, 'timed out');
      assertEquals(host.generation, undefined);
    },
  );
});
Deno.test('lookup initialization failures are visible and do not prevent another Worker becoming ready', async () => {
  await withHost(`throw Error('broken initialization');`, async (host) => {
    await assertRejects(() => host.start(), Error, 'broken initialization');
    assertEquals(host.state, 'failed');
  });
  await withHost(
    `export default { cover() { return {candidates:[]}; } };`,
    async (host) => {
      assertEquals(await call(host), { candidates: [] });
      await eventually(() => host.state === 'ready');
    },
  );
});
Deno.test('lookup results reject undeclared values, unsupported targets and malformed outcomes', async () => {
  await withHost(
    `export default { cover() { return {candidates:[]}; } };`,
    (host) => {
      const capability = host.plugin.manifest!.capabilities[0];
      const candidate = {
        target: { type: 'album', id: 'a' },
        confidence: 'strong',
        values: { 'album.image.front': { url: 'https://fixture.test/image' } },
      };
      assertThrows(() =>
        parseResult({
          candidates: [{ ...candidate, target: { type: 'song', id: 'a' } }],
        }, capability)
      );
      assertThrows(() =>
        parseResult({
          candidates: [{ ...candidate, values: { 'album.name': 'bad' } }],
        }, capability)
      );
      assertThrows(() =>
        parseResult({ retryAfter: -1, reason: 'bad' }, capability)
      );
      assertThrows(() =>
        parseResult(
          { candidates: [], retryAfter: 1, reason: 'bad' },
          capability,
        )
      );
    },
  );
});
