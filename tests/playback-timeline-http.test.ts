// Successor policy through real plain HTTP, decoder, boot and shipping FFI.
// Continuous A/B transport belongs to b08; these are the existing boundaries.
import { assert, assertEquals } from '@std/assert';
import type { PlaybackSource } from '../src/player.ts';
import { nativeHttpFixture } from './helpers/playback-native-http.ts';

async function until(predicate: () => boolean | Promise<boolean>) {
  const deadline = performance.now() + 15000;
  while (!await predicate()) {
    assert(performance.now() < deadline, 'successor outcome timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
function pcm(frames = 353) {
  const bytes = new Uint8Array(frames * 4), view = new DataView(bytes.buffer);
  for (let i = 0; i < frames; i++) {
    view.setInt16(i * 4, 1000 + i % 10000, true);
    view.setInt16(i * 4 + 2, -2000 - i % 10000, true);
  }
  return bytes;
}
async function libraryProof() {
  const path = await Deno.realPath(
    new URL('../helper/raop/libmelofon_raop.so', import.meta.url),
  );
  assertEquals(await Deno.realPath(Deno.env.get('MELOFON_RAOP_LIB')!), path);
  assert(
    (await Deno.readTextFile('/proc/self/maps')).split('\n').some((line) =>
      line.endsWith(` ${path}`)
    ),
  );
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', await Deno.readFile(path)),
  );
  console.log(
    `successor native library: ${path} sha256=${
      Array.from(digest, (v) => v.toString(16).padStart(2, '0')).join('')
    }`,
  );
}
async function control(f: Awaited<ReturnType<typeof nativeHttpFixture>>) {
  const { credential } = await f.fixture.login('bearer');
  return {
    credential,
    async command(kind: string, body: unknown = {}) {
      const r = await f.fixture.json(
        `/api/v1/players/1/${kind}`,
        'POST',
        body,
        credential,
      );
      assertEquals(r.status, 204, await r.text());
    },
    async modes(repeat: string, consume: boolean) {
      const r = await f.fixture.json('/api/v1/players/1', 'PATCH', {
        repeat,
        consume,
      }, credential);
      assertEquals(r.status, 200, await r.clone().text());
      const { player } = await r.json();
      assertEquals(player.repeat, repeat);
      assertEquals(player.consume, consume);
    },
    async current() {
      const r = await f.fixture.get('/api/v1/players/1', credential);
      assertEquals(r.status, 200);
      return (await r.json()).player;
    },
  };
}
function test(name: string, fn: () => Promise<void>) {
  Deno.test({
    name: `playback timeline HTTP: ${name}`,
    sanitizeOps: false,
    sanitizeResources: false,
    fn,
  });
}
for (const repeat of ['off', 'all', 'single'] as const) {
  for (const consume of [false, true]) {
    test(`natural ${repeat} consume=${consume} preserves duplicate occurrences and rendered tails`, async () => {
      const opened: PlaybackSource[] = [], bytes = pcm();
      const f = await nativeHttpFixture({
        pcm: bytes,
        sourceOpened: (source) => opened.push(source),
      });
      try {
        const c = await control(f);
        await f.play(false);
        await f.play(false);
        const entries = f.playback.queueView().items;
        assertEquals(entries[0].reference, entries[1].reference);
        assert(entries[0].id !== entries[1].id);
        await c.modes(repeat, consume);
        await c.command('play');
        await until(() => opened.length >= 2);
        const expected = repeat === 'single' ? entries[0].id : entries[1].id;
        assertEquals(opened[1].entryId, expected);
        assert(opened[0].signal.aborted);
        assert(opened[1].generation > opened[0].generation);
        assertEquals((await c.current()).current.entryId, expected);
        assertEquals(
          f.playback.queueView().items.map((e) => e.id),
          consume && repeat === 'off'
            ? [entries[1].id]
            : entries.map((e) => e.id),
        );
        if (repeat === 'all') {
          await until(() => opened.length >= 3);
          assertEquals(
            opened[2].entryId,
            entries[0].id,
            'natural tail wraps, unlike manual next',
          );
        } else if (repeat === 'off') {
          await until(() => f.playback.playerView().state === 'stop');
          assertEquals((await c.current()).state, 'stop');
          assertEquals(f.playback.queueView().items.length, consume ? 0 : 2);
        }
        const completed = repeat === 'single' ? 1 : 2;
        assertEquals(
          f.audio.epochs.length,
          completed,
          'one retained completion per natural boundary',
        );
        const expectedPcm = new Uint8Array(completed * bytes.length);
        for (let i = 0; i < completed; i++) {
          expectedPcm.set(bytes, i * bytes.length);
        }
        assertEquals(f.audio.realAudio(f.receiver.sessions[0]), expectedPcm);
        assertEquals(
          f.audio.scheduledRealAudio(
            f.receiver.sessions[0],
            f.receiver.nowMs(),
          ),
          expectedPcm,
        );
        await libraryProof();
      } finally {
        await f.close();
      }
    });
    test(`live failure ${repeat} consume=${consume} skips every exhausted occurrence once`, async () => {
      const opened: PlaybackSource[] = [];
      const f = await nativeHttpFixture({
        pcm: pcm(4410),
        web: 'live',
        sourceOpened: (source) => opened.push(source),
      });
      try {
        const c = await control(f);
        await f.play(false);
        await f.play(false);
        const entries = f.playback.queueView().items;
        await c.modes(repeat, consume);
        await c.command('play');
        await until(() => f.playback.playerView().state === 'stop');
        assertEquals((await c.current()).state, 'stop');
        assertEquals(
          opened.map((source) => source.entryId),
          entries.map((entry) => entry.id),
        );
        assertEquals(
          f.playback.queueView().items.map((entry) => entry.id),
          consume ? [] : entries.map((entry) => entry.id),
        );
        assert(opened.every((source) => source.signal.aborted));
        assertEquals(
          f.audio.epochs.length,
          0,
          'live EOF never becomes natural completion',
        );
        await libraryProof();
      } finally {
        await f.close();
      }
    });
  }
}
test('manual next, previous and restart remain separate under repeat-single and consume', async () => {
  const f = await nativeHttpFixture({ pcm: pcm(4410), declaredMs: 60000 });
  try {
    const c = await control(f);
    await f.play(false);
    await f.play(false);
    const entries = f.playback.queueView().items;
    await c.modes('single', true);
    await c.command('play');
    await until(() => !!f.token);
    await c.command('next');
    assertEquals((await c.current()).current.entryId, entries[1].id);
    await c.command('previous');
    assertEquals((await c.current()).current.entryId, entries[0].id);
    await c.command('next');
    await c.command('pause');
    await c.command('restart');
    const paused = await c.current();
    assertEquals(paused.state, 'pause');
    assertEquals(paused.current.entryId, entries[1].id);
    assertEquals(paused.positionMs, 0);
    await c.command('next');
    assertEquals(
      (await c.current()).state,
      'stop',
      'manual next never wraps or repeats',
    );
    assertEquals(
      f.playback.queueView().items.map((entry) => entry.id),
      entries.map((entry) => entry.id),
      'manual commands do not consume',
    );
    await libraryProof();
  } finally {
    await f.close();
  }
});

for (const edit of ['remove', 'move', 'append', 'unrelated-move'] as const) {
  test(`held read preparation reconciles ${edit} without publishing speculative current`, async () => {
    const held = Promise.withResolvers<void>(),
      entered = Promise.withResolvers<void>();
    let armed = false, waits = 0;
    const opened: PlaybackSource[] = [];
    const bytes = pcm();
    const f = await nativeHttpFixture({
      pcm: bytes,
      web: 'finite',
      sourceOpened: (source) => opened.push(source),
      async resolveSource(reference, resolve) {
        if (armed && reference.kind === 'station' && reference.id === 'B') {
          waits++;
          if (waits === 1) {
            entered.resolve();
            await held.promise;
          }
        }
        return await resolve();
      },
    });
    try {
      const c = await control(f);
      await f.play(false);
      const added = await f.fixture.json(
        '/api/v1/players/1/queue/items',
        'POST',
        {
          references: ['B', 'C', 'D'].map((id) => ({ kind: 'station', id })),
        },
        c.credential,
      );
      assertEquals(added.status, 200, await added.text());
      const entries = f.playback.queueView().items;
      assert(
        entries.slice(1).every((entry) =>
          entry.facts.kind === 'web' && entry.facts.mode === 'finite'
        ),
        'held finite sources acquire real finite facts, not unknown/live EOF failure',
      );
      armed = true;
      await c.command('play');
      await entered.promise;
      const reading = f.playback.sourcePlanView().reading!;
      const playing = f.playback.sourcePlanView().playing!;
      assertEquals(reading.entryId, entries[1].id);
      assertEquals(playing.entryId, entries[0].id);
      assert(reading !== playing && !playing.signal.aborted);
      assertEquals((await c.current()).current.entryId, entries[0].id);
      const generation = f.playback.playerView().generation;
      if (edit === 'append') await f.play(false);
      else {
        const id = edit === 'unrelated-move' ? entries[3].id : entries[1].id;
        const r = edit === 'remove'
          ? await f.fixture.request(`/api/v1/players/1/queue/items/${id}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${c.credential}` },
          })
          : await f.fixture.json(
            `/api/v1/players/1/queue/items/${id}`,
            'PATCH',
            {
              position: edit === 'unrelated-move' ? 2 : 3,
            },
            c.credential,
          );
        assertEquals(r.status, 204, await r.text());
      }
      assertEquals(f.playback.playerView().generation, generation);
      assertEquals((await c.current()).current.entryId, entries[0].id);
      const changed = edit === 'remove' || edit === 'move';
      assertEquals(reading.signal.aborted, changed);
      held.resolve();
      await until(() => opened.length >= 2);
      assertEquals(opened[1].entryId, entries[changed ? 2 : 1].id);
      if (!changed) {
        assertEquals(
          opened[1],
          reading,
          'promote the prepared incarnation, do not reopen it',
        );
      }
      assertEquals(waits, 1, 'unrelated edits never redo B acquisition');
      assertEquals((await c.current()).current.entryId, opened[1].entryId);
      assertEquals(
        f.audio.scheduledRealAudio(f.receiver.sessions[0], f.receiver.nowMs()),
        bytes,
      );
      await libraryProof();
    } finally {
      held.resolve();
      await f.close();
    }
  });
}

for (const command of ['seek', 'restart', 'stop', 'next'] as const) {
  test(`held old read cannot publish or cancel newer ${command}`, async () => {
    const held = Promise.withResolvers<void>(),
      entered = Promise.withResolvers<void>();
    let armed = false, waits = 0, settled = false;
    const f = await nativeHttpFixture({
      pcm: pcm(4410),
      web: 'finite',
      async resolveSource(reference, resolve) {
        if (armed && reference.kind === 'station' && waits++ === 0) {
          entered.resolve();
          await held.promise;
          settled = true;
        }
        return await resolve();
      },
    });
    try {
      const c = await control(f);
      await f.play(false);
      const r = await f.fixture.json('/api/v1/players/1/queue/items', 'POST', {
        references: [{ kind: 'station', id: 'B' }],
      }, c.credential);
      assertEquals(r.status, 200, await r.text());
      const entries = f.playback.queueView().items;
      armed = true;
      await c.command('play');
      await entered.promise;
      const old = f.playback.sourcePlanView().reading!;
      const playing = f.playback.sourcePlanView().playing!;
      await c.command(command, command === 'seek' ? { positionMs: 0 } : {});
      assert(old.signal.aborted);
      assert(playing.signal.aborted);
      assertEquals(
        settled,
        false,
        'cancellation is not acquisition settlement',
      );
      const before = await c.current(),
        generation = f.playback.playerView().generation;
      assertEquals(
        before.current.entryId,
        entries[command === 'next' ? 1 : 0].id,
      );
      held.resolve();
      await until(() => settled);
      await until(() => command === 'stop' || !!f.token && f.token !== playing);
      assertEquals(f.playback.playerView().generation, generation);
      assertEquals(
        (await c.current()).state,
        command === 'stop' ? 'pause' : 'play',
      );
      assertEquals((await c.current()).current.entryId, before.current.entryId);
      await libraryProof();
    } finally {
      held.resolve();
      await f.close();
    }
  });
}

test('owner close joins held read acquisition and retains the playing identity until cancellation', async () => {
  const held = Promise.withResolvers<void>(),
    entered = Promise.withResolvers<void>();
  let armed = false, acquired = false;
  const f = await nativeHttpFixture({
    pcm: pcm(4410),
    web: 'finite',
    async resolveSource(reference, resolve) {
      if (armed && reference.kind === 'station') {
        entered.resolve();
        await held.promise;
        acquired = true;
      }
      return await resolve();
    },
  });
  try {
    const c = await control(f);
    await f.play(false);
    const r = await f.fixture.json('/api/v1/players/1/queue/items', 'POST', {
      references: [{ kind: 'station', id: 'B' }],
    }, c.credential);
    assertEquals(r.status, 200, await r.text());
    const current = f.playback.queueView().items[0].id;
    armed = true;
    await c.command('play');
    await entered.promise;
    const read = f.playback.sourcePlanView().reading!, play = f.token!;
    let closed = false;
    const close = f.playback.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    assert(read.signal.aborted && play.signal.aborted);
    assertEquals(closed, false);
    assertEquals(acquired, false);
    held.resolve();
    await close;
    assert(acquired && closed);
    assertEquals((await c.current()).current.entryId, current);
    assertEquals(f.playback.sourcePlanView(), { reading: null, playing: null });
    await libraryProof();
  } finally {
    held.resolve();
    await f.close();
  }
});

test('ordinary HTTP additions retain FIFO across held source resolution', async () => {
  const held = Promise.withResolvers<void>(),
    entered = Promise.withResolvers<void>();
  const observed: string[] = [];
  const f = await nativeHttpFixture({
    pcm: pcm(),
    web: 'finite',
    async resolveSource(reference, resolve) {
      if (reference.kind === 'station') {
        observed.push(reference.id);
        if (reference.id === 'first') {
          entered.resolve();
          await held.promise;
        }
      }
      return await resolve();
    },
  });
  try {
    const c = await control(f);
    const add = (id: string) =>
      f.fixture.json('/api/v1/players/1/queue/items', 'POST', {
        references: [{ kind: 'station', id }],
      }, c.credential);
    const first = add('first');
    await entered.promise;
    const second = add('second');
    assertEquals(f.playback.queueView().items.length, 0);
    held.resolve();
    for (const response of await Promise.all([first, second])) {
      assertEquals(response.status, 200, await response.text());
    }
    assertEquals(observed, ['first', 'second']);
    const entries = f.playback.queueView().items;
    assertEquals(entries.map((entry) => entry.reference), [
      { kind: 'station', id: 'first' },
      { kind: 'station', id: 'second' },
    ]);
    assert(entries[0].id < entries[1].id);
    await c.command('play');
    await until(() => !!f.token);
    assertEquals(f.token!.entryId, entries[0].id);
    await libraryProof();
  } finally {
    held.resolve();
    await f.close();
  }
});

test('held failure successor acquisition is joined and cannot override a newer Stop', async () => {
  const held = Promise.withResolvers<void>(),
    entered = Promise.withResolvers<void>();
  let armed = false, settled = false;
  const opened: PlaybackSource[] = [];
  const f = await nativeHttpFixture({
    pcm: pcm(),
    web: 'live',
    sourceOpened: (source) => opened.push(source),
    async resolveSource(reference, resolve) {
      if (armed && reference.kind === 'station') {
        entered.resolve();
        await held.promise;
        settled = true;
      }
      return await resolve();
    },
  });
  try {
    const c = await control(f);
    await f.play(false);
    const r = await f.fixture.json('/api/v1/players/1/queue/items', 'POST', {
      references: [{ kind: 'station', id: 'B' }],
    }, c.credential);
    assertEquals(r.status, 200, await r.text());
    const entryId = f.playback.queueView().items[0].id;
    armed = true;
    await c.command('play');
    await entered.promise;
    const read = f.playback.sourcePlanView().reading!;
    assert(read && read.entryId !== entryId);
    assertEquals((await c.current()).current.entryId, entryId);
    assertEquals(
      f.audio.epochs.length,
      0,
      'failed live EOF is not a completion',
    );
    await c.command('stop');
    const generation = f.playback.playerView().generation;
    assert(read.signal.aborted);
    assertEquals(settled, false);
    held.resolve();
    await until(() => settled);
    await f.playback.close();
    assertEquals(f.playback.playerView().generation, generation);
    assertEquals((await c.current()).state, 'pause');
    assertEquals((await c.current()).current.entryId, entryId);
    assertEquals(opened.map((source) => source.entryId), [entryId]);
    await libraryProof();
  } finally {
    held.resolve();
    await f.close();
  }
});
