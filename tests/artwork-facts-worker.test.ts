import { assert, assertEquals, assertRejects } from '@std/assert';
import { decodeBase64 } from '@std/encoding/base64';
import { createArtworkFactsHost } from '../src/artwork/facts-host.ts';
import { openStore } from '../src/store/index.ts';
import { rawSql } from '../src/store/testing.ts';
import { authFixture } from './helpers/authentication.ts';
import {
  artworkStateFixture as stateFixture,
  waitForWorkerSignal,
} from './helpers/artwork-worker.ts';
import reference from './fixtures/thumbhash-reference.json' with {
  type: 'json',
};

const source = { width: 1, height: 1, rgba: new Uint8Array([255, 0, 0, 255]) };
const worker = (code: string) =>
  new URL(`data:application/javascript,${encodeURIComponent(code)}`);

Deno.test('Artwork Worker: exact existing ThumbHash vectors and recovery after a failed computation', async () => {
  const state = stateFixture();
  const host = createArtworkFactsHost(state);
  try {
    for (const vector of reference.vectors) {
      const result = await host.compute({
        width: vector.w,
        height: vector.h,
        rgba: decodeBase64(vector.rgba),
      });
      assertEquals(result.thumbHash, vector.hash);
    }
    await assertRejects(() => host.compute({ ...source, width: 101 }));
    assertEquals((await host.compute(source)).dominantColor, '#ff0000');
  } finally {
    host.close();
  }
});

Deno.test('Artwork Worker: overlapping calls are refused without stealing the active result', async () => {
  const state = stateFixture();
  const settings = Promise.withResolvers<void>();
  const computing = Promise.withResolvers<void>();
  const gate = new Int32Array(new SharedArrayBuffer(4));
  let firstRead = true;
  const host = createArtworkFactsHost(
    {
      ...state,
      async getTyped(key: string) {
        if (firstRead) {
          firstRead = false;
          await settings.promise;
        }
        return await state.getTyped(key);
      },
    },
    new URL('./fixtures/artwork-gated-worker.ts', import.meta.url),
    () => computing.resolve(),
  );
  const black = reference.vectors.find((v) => v.name === 'one-black')!;
  const other = {
    width: black.w,
    height: black.h,
    rgba: decodeBase64(black.rgba),
  };
  const pixels = { ...source, gate: gate.buffer };
  const pending = host.compute(pixels);
  const settled = pending.catch(() => {});
  try {
    // The first call owns the host before even its initial settings read ends.
    await assertRejects(
      () => host.compute(other),
      Error,
      'Artwork Worker busy',
    );
    settings.resolve();
    await waitForWorkerSignal(computing.promise, 'computation start');
    await assertRejects(
      () => host.compute(other),
      Error,
      'Artwork Worker busy',
    );
    Atomics.store(gate, 0, 1);
    Atomics.notify(gate, 0);
    assertEquals(await pending, {
      thumbHash: reference.vectors.find((v) => v.name === 'one-red')!.hash,
      dominantColor: '#ff0000',
    });
    // A refused caller can retry once the active call has released ownership.
    assertEquals(await host.compute(other), {
      thumbHash: black.hash,
      dominantColor: '#000000',
    });
  } finally {
    settings.resolve();
    Atomics.store(gate, 0, 1);
    Atomics.notify(gate, 0);
    host.close();
    await settled;
  }
});

Deno.test('Artwork Worker: failed settings acquisition releases call ownership', async () => {
  const state = stateFixture();
  let failRead = true;
  const host = createArtworkFactsHost({
    ...state,
    getTyped(key: string) {
      if (failRead) {
        failRead = false;
        return Promise.reject(new Error('fixture settings failure'));
      }
      return state.getTyped(key);
    },
  });
  try {
    await assertRejects(
      () => host.compute(source),
      Error,
      'fixture settings failure',
    );
    assertEquals((await host.compute(source)).dominantColor, '#ff0000');
  } finally {
    host.close();
  }
});

Deno.test('Artwork Worker: startup and active-call timeouts settle and terminate their Worker', async () => {
  for (
    const [setting, code, error] of [
      [
        'startupSeconds',
        'setInterval(() => {}, 1000);',
        'Artwork Worker startup timed out',
      ],
      [
        'computeSeconds',
        'setTimeout(() => postMessage({ready:true}), 150); onmessage = () => { while(true) {} };',
        'Artwork computation timed out',
      ],
    ]
  ) {
    const state = stateFixture();
    const host = createArtworkFactsHost(state, worker(code));
    try {
      await state.set(`artwork.facts.${setting}`, '0.05');
      await assertRejects(() => host.compute(source), Error, error);
    } finally {
      host.close();
    }
  }
});

Deno.test('Artwork Worker: shutdown interrupts startup and active computation without a dangling promise', async () => {
  const starting = Promise.withResolvers<void>();
  const server = Deno.serve(
    { hostname: '0.0.0.0', port: 0, onListen() {} },
    () => {
      starting.resolve();
      return new Response('started');
    },
  );
  try {
    for (const active of [false, true]) {
      const computing = Promise.withResolvers<void>();
      const code = active
        ? 'postMessage({ready:true}); onmessage = () => { postMessage({started:true}); while(true) {} };'
        : `await fetch('http://melofon.home:${server.addr.port}/starting'); setInterval(() => {}, 1000);`;
      const host = createArtworkFactsHost(
        stateFixture(),
        worker(code),
        () => computing.resolve(),
      );
      const pending = assertRejects(
        () => host.compute(source),
        Error,
        'closed',
      );
      try {
        await waitForWorkerSignal(
          active ? computing.promise : starting.promise,
          active ? 'computation start' : 'startup entry',
        );
        host.close();
        await pending;
        await assertRejects(() => host.compute(source), Error, 'closed');
      } finally {
        host.close();
        await pending;
      }
    }
  } finally {
    await server.shutdown();
  }
});

Deno.test('Artwork Worker: transition waits fail on a missing signal and clear their timer on success', async () => {
  await assertRejects(
    () => waitForWorkerSignal(new Promise(() => {}), 'missing transition', 1),
    Error,
    'Artwork Worker did not report missing transition',
  );
  await waitForWorkerSignal(Promise.resolve(), 'immediate transition');
});

Deno.test('Artwork Worker: uncaught errors and invalid results settle instead of hanging', async () => {
  // Deno prints terminal Worker errors before the parent's onerror callback.
  // Capture at the process boundary so even a regression cannot corrupt this
  // test's reporter output, then assert that the owner prevented that output.
  const output = await new Deno.Command(Deno.execPath(), {
    args: [
      'run',
      '--frozen',
      '--cached-only',
      '--node-modules-dir=manual',
      '--allow-read',
      new URL('./fixtures/artwork-worker-errors.ts', import.meta.url).pathname,
    ],
    stdout: 'piped',
    stderr: 'piped',
    signal: AbortSignal.timeout(30_000),
  }).output();
  const stderr = new TextDecoder().decode(output.stderr);
  assertEquals(output.code, 0, stderr);
  assertEquals(stderr, '', 'Worker failures must not escape to runtime stderr');
  assertEquals(JSON.parse(new TextDecoder().decode(output.stdout)), [
    'Error: fixture startup error',
    'Error: fixture compute error',
    'Error: fixture async error',
    'Invalid artwork Worker result',
  ]);
});

Deno.test('Artwork migration: drops only old native global facts and preserves other private data on upgrade', async () => {
  const f = await authFixture();
  const directory = f.dir;
  let store = f.store;
  try {
    await store.hatData.put({
      hat: 'melofon',
      ownerScope: '',
      key: 'artwork-facts/v1/old',
      kind: 'data',
      payload: '{}',
    });
    await store.hatData.put({
      hat: 'melofon',
      ownerScope: '',
      key: 'artwork-facts/v2/old',
      kind: 'data',
      payload: '{}',
    });
    const preserved = [
      {
        hat: 'melofon',
        ownerScope: '',
        key: 'other',
        kind: 'data' as const,
        payload: 'unchanged',
      },
      {
        hat: 'other',
        ownerScope: '',
        key: 'artwork-facts/v2/old',
        kind: 'data' as const,
        payload: 'unchanged',
      },
      {
        hat: 'melofon',
        ownerScope: f.admin.id,
        key: 'artwork-facts/v2/old',
        kind: 'data' as const,
        payload: 'unchanged',
      },
      {
        hat: 'melofon',
        ownerScope: '',
        key: 'artwork-facts/v2/credential',
        kind: 'credential' as const,
        payload: 'unchanged',
      },
    ];
    for (const row of preserved) await store.hatData.put(row);
    await rawSql(store).run(
      "DELETE FROM migrations WHERE id = 'artwork-facts-001'",
    );
    await rawSql(store).run('DROP TABLE artwork_previews');
    await store.close();
    store = await openStore(directory);
    assertEquals(await store.artwork.preview('new'), null);
    await store.artwork.savePreview('new', {
      thumbHash: 'AQ==',
      dominantColor: null,
    });
    assertEquals(
      await store.hatData.get('melofon', '', 'artwork-facts/v1/old'),
      null,
    );
    assertEquals(
      await store.hatData.get('melofon', '', 'artwork-facts/v2/old'),
      null,
    );
    for (const row of preserved) {
      assertEquals(
        await store.hatData.get(row.hat, row.ownerScope, row.key),
        row,
      );
    }
    await store.close();
    store = await openStore(directory);
    assertEquals(await store.artwork.preview('new'), {
      thumbHash: 'AQ==',
      dominantColor: null,
    });
    assert(
      (await rawSql(store).all(
        "SELECT id FROM migrations WHERE id = 'artwork-facts-001'",
      )).length === 1,
    );
  } finally {
    await store.close();
    await Deno.remove(directory, { recursive: true });
  }
});
