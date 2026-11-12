import { assert, assertEquals, assertRejects } from '@std/assert';
import { decodeBase64 } from '@std/encoding/base64';
import { createArtworkFactsHost } from '../src/artwork/facts-host.ts';
import { openStore } from '../src/store/index.ts';
import { rawSql } from '../src/store/testing.ts';
import { authFixture } from './helpers/authentication.ts';
import reference from './fixtures/thumbhash-reference.json' with {
  type: 'json',
};

const source = { width: 1, height: 1, rgba: new Uint8Array([255, 0, 0, 255]) };
const worker = (code: string) =>
  new URL(`data:application/javascript,${encodeURIComponent(code)}`);

function stateFixture() {
  const values = new Map<string, number>();
  return {
    declare(key: string, schema: unknown) {
      if (!values.has(key)) {
        values.set(key, (schema as { default: number }).default);
      }
    },
    getTyped: (key: string) => Promise.resolve(values.get(key)),
    set(key: string, value: string) {
      values.set(key, Number(value));
    },
  };
}

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

Deno.test('Artwork Worker: startup and active-call timeouts settle and terminate their Worker', async () => {
  const state = stateFixture();
  for (
    const [setting, code] of [
      ['startupSeconds', 'setInterval(() => {}, 1000);'],
      [
        'computeSeconds',
        'postMessage({ready:true}); onmessage = () => { while(true) {} };',
      ],
    ]
  ) {
    const host = createArtworkFactsHost(state, worker(code));
    try {
      await state.set(`artwork.facts.${setting}`, '0.05');
      await assertRejects(() => host.compute(source), Error, 'timed out');
    } finally {
      host.close();
    }
  }
});

Deno.test('Artwork Worker: shutdown interrupts startup and active computation without a dangling promise', async () => {
  const state = stateFixture();
  for (
    const code of [
      'setInterval(() => {}, 1000);',
      'postMessage({ready:true}); onmessage = () => { postMessage({started:true}); while(true) {} };',
    ]
  ) {
    const host = createArtworkFactsHost(state, worker(code));
    const pending = assertRejects(() => host.compute(source), Error, 'closed');
    await new Promise((resolve) => setTimeout(resolve, 100));
    host.close();
    await pending;
    await assertRejects(() => host.compute(source), Error, 'closed');
  }
});

Deno.test('Artwork Worker: uncaught errors and invalid results settle instead of hanging', async () => {
  const state = stateFixture();
  for (
    const code of [
      'throw new Error("fixture startup error");',
      'postMessage({ready:true}); onmessage = () => { throw new Error("fixture compute error"); };',
      'postMessage({ready:true}); onmessage = () => postMessage({value:{thumbHash:42}});',
    ]
  ) {
    const host = createArtworkFactsHost(state, worker(code));
    try {
      await assertRejects(() => host.compute(source));
    } finally {
      host.close();
    }
  }
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
