import { assert, assertEquals, assertRejects } from '@std/assert';
import { DuckDBInstance } from '@duckdb/node-api';
import { openStore } from '../src/store/index.ts';
import { engineForTesting } from '../src/store/engine.ts';
import { createMedia, imagePixels } from '../src/media.ts';
import { observeHeartbeat } from './helpers/heartbeat.ts';
import { pixelPng } from './helpers/pixel-image.ts';

const AUDIO = 'tests/fixtures/media/clip.flac';

Deno.test('heartbeat covers native store open, migrations, overlapping owners and final queued save', async () => {
  using observed = observeHeartbeat();
  const dir = await Deno.makeTempDir({ prefix: 'heartbeat-store-' });
  const create = DuckDBInstance.create;
  DuckDBInstance.create = (...args) => {
    observed.assertActive();
    return create(...args);
  };
  try {
    const first = await openStore(`${dir}/first`);
    try {
      const second = await openStore(`${dir}/second`);
      try {
        assertEquals(observed.timers.size, 1);
        await first.close();
        await first.close();
        observed.assertActive();
        const saving = second.state.set('last', 'saved');
        const closing = second.close();
        observed.assertActive();
        await Promise.all([saving, closing]);
        assertEquals(observed.active.size, 0);
      } finally {
        await second.close();
      }
    } finally {
      await first.close();
    }
    const reopened = await openStore(`${dir}/second`);
    try {
      assertEquals(await reopened.state.get('last'), 'saved');
      await engineForTesting(reopened).exclusive(async () => {
        await assertRejects(() => reopened.close(), Error, 'inside');
        observed.assertActive();
      });
    } finally {
      await reopened.close();
    }
    assertEquals(observed.active.size, 0);
  } finally {
    DuckDBInstance.create = create;
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('heartbeat releases failed native store creation and migration', async () => {
  using observed = observeHeartbeat();
  const dir = await Deno.makeTempDir({ prefix: 'heartbeat-failed-open-' });
  const create = DuckDBInstance.create;
  try {
    for (const phase of ['create', 'connect', 'migrate']) {
      const failure = new Error(`injected ${phase}`);
      DuckDBInstance.create = async (...args) => {
        observed.assertActive();
        if (phase === 'create') throw failure;
        const instance = await create(...args);
        const connect = instance.connect.bind(instance);
        instance.connect = async () => {
          observed.assertActive();
          if (phase === 'connect') throw failure;
          const conn = await connect();
          conn.run = () => {
            observed.assertActive();
            return Promise.reject(failure);
          };
          return conn;
        };
        return instance;
      };
      assertEquals(
        await assertRejects(() => openStore(`${dir}/${phase}`)),
        failure,
      );
      assertEquals(observed.active.size, 0);
    }
  } finally {
    DuckDBInstance.create = create;
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('heartbeat covers standalone media work and releases failures', async () => {
  using observed = observeHeartbeat();
  const media = createMedia();
  assertEquals(observed.active.size, 0);
  assertEquals((await media.probe(AUDIO)).hasAudio, true);
  assertEquals(observed.timers.size, 1);
  assertEquals(observed.active.size, 0);
  assert((await media.fingerprint(AUDIO)).fingerprint);
  assertEquals(observed.timers.size, 2);
  assertEquals(observed.active.size, 0);
  const rgba = new Uint8Array([255, 0, 0, 255]);
  assertEquals(await imagePixels(pixelPng(1, 1, rgba), 1, 1), rgba);
  assertEquals(observed.timers.size, 3);
  assertEquals(observed.active.size, 0);
  await assertRejects(() => imagePixels(new Uint8Array(), 1, 1));
  assertEquals(await media.decodePcm('absent-heartbeat-fixture'), null);
  assertEquals(
    await media.transcodeAudio('absent-heartbeat-fixture', 'mp3'),
    null,
  );
  assertEquals(observed.active.size, 0);
});

Deno.test('heartbeat follows PCM ownership through iteration and return before first next', async () => {
  using observed = observeHeartbeat();
  const media = createMedia();
  for (const consume of [false, true]) {
    const pcm = await media.decodePcm(AUDIO);
    assert(pcm);
    try {
      observed.assertActive();
      if (consume) {
        let bytes = 0;
        for await (const part of pcm) bytes += part.length;
        assert(bytes > 0);
      }
    } finally {
      await pcm[Symbol.asyncIterator]().return!();
    }
    assertEquals(observed.active.size, 0);
  }
});

Deno.test('heartbeat follows core-fed PCM and transcode cancellation until native disposal', async () => {
  using observed = observeHeartbeat();
  const media = createMedia();
  const bytes = await Deno.readFile(AUDIO);
  let closed = false;
  const pcm = await media.decodeInputPcm({
    body: new Blob([bytes]).stream(),
    close() {
      observed.assertActive();
      closed = true;
      return Promise.resolve();
    },
  });
  observed.assertActive();
  await pcm.return();
  await pcm.completion;
  assert(closed);
  assertEquals(observed.active.size, 0);
  const transcode = await media.transcodeAudio(AUDIO, 'mp3');
  assert(transcode);
  observed.assertActive();
  await transcode.stream.cancel();
  await transcode.completion;
  assertEquals(observed.active.size, 0);
});
