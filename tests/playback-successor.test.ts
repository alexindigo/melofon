import { assert, assertEquals } from '@std/assert';
import {
  planPlaybackSuccessor,
  reconcilePlaybackSuccessor,
} from '../src/playback-successor.ts';
import { planSourceFailure } from '../src/source-recovery.ts';
import { createPlayer, type RepeatMode } from '../src/player.ts';
import type { QueueMedia } from '../src/queue-source.ts';
import { createPlayback } from '../src/playback.ts';
import type { NowPlaying } from '../src/nowplaying.ts';
import { createNotify } from '../src/notify.ts';
import { createSourcePlanOwner } from '../src/playback-source-plan.ts';
import { createCommandLane } from '../src/command-authority.ts';

const media: QueueMedia = {
  reference: { kind: 'url', url: 'http://radio.home/duplicate' },
  facts: {
    kind: 'web',
    url: 'http://radio.home/duplicate',
    title: null,
    artistName: null,
    durationMs: 10,
    mode: 'finite',
    seekable: true,
    streamTitle: null,
    streamUrl: null,
  },
};
function fixture(repeat: RepeatMode, consume: boolean, at: number) {
  let time = 0;
  const player = createPlayer({ now: () => time, monotonicNow: () => time });
  player.queueAddSources([media, media, media]);
  player.setRepeat(repeat);
  player.setConsume(consume);
  player.play(at);
  time = 10;
  const plan = (reason: 'natural' | 'failure', failed = new Set<number>()) =>
    planPlaybackSuccessor({
      reason,
      revision: player.queue().version,
      items: player.queue().items,
      currentEntryId: player.status().current?.id,
      repeat,
      consume,
      failed,
    });
  return { player, plan };
}

for (
  const edit of [
    'append',
    'unrelated-move',
    'remove',
    'move',
    'insert',
  ] as const
) {
  Deno.test(`successor reconciliation reads occurrence relationships: ${edit}`, () => {
    const { player, plan } = fixture('off', false, 0);
    const captured = plan('natural');
    if (edit === 'append') player.queueAddSources([media]);
    if (edit === 'unrelated-move') {
      player.queueAddSources([media]);
      player.queueMove(4, 2);
    }
    if (edit === 'remove') player.queueRemove(2);
    if (edit === 'move') player.queueMove(2, 2);
    if (edit === 'insert') player.queueAddSources([media], 1);
    const current = plan('natural');
    const rebased = reconcilePlaybackSuccessor(captured, current, 2);
    if (edit === 'append' || edit === 'unrelated-move') {
      assertEquals(rebased, current);
      assertEquals(player.applySuccessor(rebased!), 'player');
      assertEquals(player.status().current?.id, 2);
    } else assertEquals(rebased, null);
  });
}

Deno.test('source records reserve and promote a repeat without replacing playing authority early', () => {
  let time = 0;
  const player = createPlayer({ now: () => time, monotonicNow: () => time });
  const [entry] = player.queueAddSources([media]);
  player.setRepeat('single');
  player.play();
  const generation = player.status().generation;
  const playing = player.openSource(entry.id, generation)!;
  const reading = player.prepareSource(entry.id, generation)!;
  const unused = player.prepareSource(entry.id, generation)!;
  assert(reading !== playing && reading.generation > playing.generation);
  assertEquals(player.status().generation, generation);
  assertEquals(player.sourceOutcome(reading, 'eof'), false);
  assertEquals(player.sourcePosition(reading, 1000, 1), false);
  assertEquals(player.sourceComplete(reading), false);
  assert(player.sourceOutcome(playing, 'eof'));
  time = 10;
  const plan = planPlaybackSuccessor({
    reason: 'natural',
    revision: player.queue().version,
    items: player.queue().items,
    currentEntryId: entry.id,
    repeat: 'single',
    consume: false,
  });
  assertEquals(player.applySuccessor(plan, entry.id, reading), 'player');
  assert(playing.signal.aborted && unused.signal.aborted);
  assertEquals(reading.signal.aborted, false);
  assertEquals(
    player.openSource(entry.id, player.status().generation),
    reading,
  );
  assertEquals(player.openSource(entry.id, player.status().generation), null);
  player.pause();
  assert(reading.signal.aborted);
});

Deno.test('source plan close joins obsolete acquisition before settlement and cannot cancel newer authority', async () => {
  const player = createPlayer();
  const held = Promise.withResolvers<void>(),
    entered = Promise.withResolvers<void>();
  let hold = false, finished = false;
  const playback = createPlayback({
    player,
    cfg: {},
    library: { getSong: () => Promise.resolve(null) },
    nowPlaying: {} as NowPlaying,
    async resolveQueueReference() {
      if (hold) {
        entered.resolve();
        await held.promise;
        finished = true;
      }
      return media;
    },
  });
  try {
    const entries = await playback.queueAddSources([
      media,
      { reference: { kind: 'station', id: 'held' }, facts: media.facts },
    ]);
    await playback.play();
    const source = playback.openSource(
      entries[0].id,
      player.status().generation,
    )!;
    hold = true;
    await playback.advanceEnded(); // speculative preparation, not natural completion
    await entered.promise;
    const reading = playback.sourcePlanView().reading!;
    assert(reading && reading !== source);
    assertEquals(playback.sourcePlanView().playing, source);
    assertEquals(player.status().current?.id, entries[0].id);
    playback.pause();
    const generation = player.status().generation;
    let closed = false;
    const close = playback.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    assert(reading.signal.aborted);
    assertEquals(closed, false);
    assertEquals(finished, false);
    held.resolve();
    await close;
    assert(finished && closed);
    assertEquals(player.status().generation, generation);
    assertEquals(player.status().state, 'pause');
  } finally {
    held.resolve();
    await playback.close();
  }
});

Deno.test('replacement source preparation joins a revoked acquisition before opening another', async () => {
  const { player, plan } = fixture('off', false, 0);
  const playing = player.openSource(1, player.status().generation)!;
  const held = Promise.withResolvers<void>(),
    entered = Promise.withResolvers<void>();
  let calls = 0;
  const owner = createSourcePlanOwner({
    player,
    current: plan,
    async resolve() {
      calls++;
      entered.resolve();
      await held.promise;
      return media;
    },
  });
  const command = createCommandLane().submit();
  try {
    owner.playingSource(playing);
    const old = owner.prepare(plan('natural'), command);
    await entered.promise;
    player.queueMove(2, 2);
    owner.reconcile();
    const next = owner.prepare(plan('natural'), command);
    await Promise.resolve();
    assert(old.source!.signal.aborted);
    assertEquals(next.source, null);
    assertEquals(calls, 1);
    assertEquals(owner.playing, playing);
    assertEquals(command.isCurrent(), true);
    let closed = false;
    const close = owner.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    assertEquals(closed, false);
    held.resolve();
    await close;
    await Promise.allSettled([old.ready, next.ready]);
    assertEquals(calls, 1);
    assertEquals(closed, true);
    assertEquals(playing.signal.aborted, false);
  } finally {
    held.resolve();
    await owner.close();
    player.pause();
  }
});

Deno.test('source plan no-I/O readiness stays synchronous across completed acquisitions', async () => {
  const { player, plan } = fixture('off', false, 0);
  const owner = createSourcePlanOwner({
    player,
    current: plan,
    resolve: (item) => item,
  });
  const command = createCommandLane().submit();
  try {
    const first = owner.prepare(plan('natural'), command);
    assert(!(first.ready instanceof Promise));
    assertEquals(first.ready?.source.entryId, 2);
    owner.cancel(first);
    const second = owner.prepare(plan('natural'), command);
    assert(
      !(second.ready instanceof Promise),
      'a settled acquisition adds no await',
    );
    assertEquals(second.ready?.source.entryId, 2);
    assertEquals(player.status().current?.id, 1);
  } finally {
    await owner.close();
    player.pause();
  }
});

for (const reason of ['natural', 'failure'] as const) {
  Deno.test(`source plan ${reason} no-I/O publication preserves the synchronous engine boundary`, async () => {
    let time = 0;
    const player = createPlayer({ now: () => time, monotonicNow: () => time });
    const playback = createPlayback({
      player,
      cfg: {},
      library: { getSong: () => Promise.resolve(null) },
      nowPlaying: {} as NowPlaying,
    });
    try {
      const entries = await playback.queueAddSources([media, media]);
      await playback.play();
      const source = playback.openSource(
        entries[0].id,
        player.status().generation,
      )!;
      if (reason === 'natural') {
        assert(playback.reportSourceOutcome(source, 'eof'));
        time = 10;
        const work = playback.advanceEnded();
        assertEquals(player.status().current?.id, entries[1].id);
        await work;
      } else {
        assert(playback.reportSourceOutcome(source, 'transport-error'));
        assertEquals(player.status().current?.id, entries[1].id);
        await playback.advanceEnded();
      }
      assert(source.signal.aborted);
    } finally {
      await playback.close();
    }
  });
}

Deno.test('empty source plan revalidates an appended occurrence on the same command before exhaustion', async () => {
  const player = createPlayer();
  const [entry] = player.queueAddSources([media]);
  player.play();
  const plan = () =>
    planPlaybackSuccessor({
      reason: 'natural',
      revision: player.queue().version,
      items: player.queue().items,
      currentEntryId: entry.id,
      repeat: 'off',
      consume: false,
    });
  const owner = createSourcePlanOwner({
    player,
    current: plan,
    resolve: (item) => item,
  });
  const command = createCommandLane().submit();
  try {
    const empty = owner.prepare(plan(), command);
    assertEquals(await empty.ready, null);
    const [appended] = player.queueAddSources([media]);
    owner.reconcile();
    assertEquals(owner.validate(empty), null);
    const replacement = owner.prepare(plan(), command);
    assertEquals((await replacement.ready)?.source.entryId, appended.id);
    assertEquals(replacement.command, command);
    assert(command.isCurrent());
    assertEquals(player.status().current?.id, entry.id);
  } finally {
    await owner.close();
    player.pause();
  }
});

Deno.test('source-less engine callers keep advancing without an unclaimed reader gate', async () => {
  let time = 0;
  const player = createPlayer({ now: () => time, monotonicNow: () => time });
  const playback = createPlayback({
    player,
    cfg: {},
    library: { getSong: () => Promise.resolve(null) },
    nowPlaying: {} as NowPlaying,
  });
  try {
    const entries = await playback.queueAddSources([media, media, media]);
    await playback.play();
    for (let i = 1; i < entries.length; i++) {
      time += 10;
      await playback.advanceEnded();
      assertEquals(player.status().current?.id, entries[i].id);
      assertEquals(playback.sourcePlanView(), { reading: null, playing: null });
    }
    time += 10;
    await playback.advanceEnded();
    assertEquals(player.status().state, 'stop');
  } finally {
    await playback.close();
  }
});

Deno.test('source failure tick joins already-admitted preparation through publication', async () => {
  const player = createPlayer();
  const held = Promise.withResolvers<void>(),
    entered = Promise.withResolvers<void>();
  const playback = createPlayback({
    player,
    cfg: {},
    library: { getSong: () => Promise.resolve(null) },
    nowPlaying: {} as NowPlaying,
    async resolveQueueReference() {
      entered.resolve();
      await held.promise;
      return media;
    },
  });
  try {
    const entries = await playback.queueAddSources([
      {
        ...media,
        facts: { ...media.facts, mode: 'live', durationMs: null },
      } as QueueMedia,
      { reference: { kind: 'station', id: 'next' }, facts: media.facts },
    ]);
    await playback.play();
    const playing = playback.openSource(
      entries[0].id,
      player.status().generation,
    )!;
    assert(playback.reportSourceOutcome(playing, 'transport-error'));
    await entered.promise;
    let published = false;
    const tick = Promise.resolve(playback.advanceEnded()).then(() => {
      published = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    assertEquals(
      published,
      false,
      'pending authority does not mean completed work',
    );
    assertEquals(player.status().current?.id, entries[0].id);
    held.resolve();
    await tick;
    assertEquals(published, true);
    assertEquals(player.status().current?.id, entries[1].id);
    assert(playing.signal.aborted);
  } finally {
    held.resolve();
    await playback.close();
  }
});

for (const repeat of ['off', 'all', 'single'] as const) {
  for (const consume of [false, true]) {
    for (const at of [0, 1, 2]) {
      Deno.test(`successor natural: ${repeat} consume=${consume} at=${at}`, () => {
        const f = fixture(repeat, consume, at);
        const original = f.player.queue();
        const plan = f.plan('natural');
        const next = repeat === 'single'
          ? at
          : repeat === 'all'
          ? (at + 1) % 3
          : at + 1;
        assertEquals(plan.entryId, original.items[next]?.id ?? null);
        assertEquals(
          plan.removedEntryId,
          consume && repeat === 'off' ? at + 1 : null,
        );
        assertEquals(plan.revision, original.version);
        assertEquals(
          f.player.queue(),
          original,
          'planning has no queue side effect',
        );
        assert(Object.isFrozen(plan));
        assert(Object.isFrozen(plan.candidates));
        assertEquals(
          f.player.applySuccessor(plan),
          plan.removedEntryId === null ? 'player' : 'player+queue',
        );
        assertEquals(f.player.status().current?.id ?? null, plan.entryId);
        assertEquals(
          f.player.queue().items.map((item) => item.id),
          plan.items.map((item) => item.id),
        );
        assertEquals(
          f.player.applySuccessor(plan),
          'none',
          'one captured boundary cannot consume twice',
        );
        const legacy = fixture(repeat, consume, at).player;
        legacy.advanceEnded();
        assertEquals(
          legacy.status().current?.id,
          f.player.status().current?.id,
        );
        assertEquals(legacy.queue(), f.player.queue());
      });
    }
    Deno.test(`successor failure: ${repeat} consume=${consume} skips failed occurrences`, () => {
      const f = fixture(repeat, consume, 1);
      const failed = new Set([2, 3]);
      const plan = f.plan('failure', failed);
      assertEquals(plan.entryId, repeat === 'all' ? 1 : null);
      assertEquals(plan.removedEntryId, consume ? 2 : null);
      assertEquals(plan.candidates, repeat === 'all' ? [1] : []);
      assertEquals(
        plan,
        planSourceFailure(
          f.player.queue().items,
          2,
          failed,
          repeat,
          consume,
          f.player.queue().version,
        ),
      );
      failed.clear();
      assertEquals(plan.excluded, [2, 3], 'failure facts belong to this plan');
      const legacy = fixture(repeat, consume, 1).player;
      legacy.advanceFailed(new Set([2, 3]));
      f.player.applySuccessor(plan);
      assertEquals(f.player.status().current?.id, legacy.status().current?.id);
      assertEquals(f.player.queue(), legacy.queue());
    });
  }
}

Deno.test('successor plans fence revisions, current occurrence and modes before mutation', () => {
  for (
    const edit of ['append', 'move', 'current', 'repeat', 'consume'] as const
  ) {
    const { player, plan } = fixture('off', true, 0);
    const captured = plan('natural');
    if (edit === 'append') player.queueAddSources([media]);
    if (edit === 'move') player.queueMove(2, 2);
    if (edit === 'current') player.playOccurrence(2);
    if (edit === 'repeat') player.setRepeat('single');
    if (edit === 'consume') player.setConsume(false);
    const before = player.queue(), status = player.status();
    assertEquals(player.applySuccessor(captured), 'none', edit);
    assertEquals(player.queue(), before);
    assertEquals(player.status(), status);
  }
});

Deno.test('successor uses duplicate occurrence identity and one chosen resolution fallback', () => {
  const { player, plan } = fixture('all', true, 0);
  const captured = plan('natural');
  assertEquals(captured.candidates, [2, 3, 1]);
  assertEquals(
    new Set(captured.items.map((item) => JSON.stringify(item.reference))).size,
    1,
  );
  const generation = player.status().generation;
  assertEquals(player.applySuccessor(captured, 3), 'player');
  assertEquals(player.status().current?.id, 3);
  assertEquals(
    player.status().generation,
    generation + 1,
    'one source transition, not advance then skip',
  );
  assertEquals(player.queue().items.length, 3, 'repeat still outranks consume');
});

Deno.test('successor excludes every failed occurrence without wrapping forever', () => {
  const { player, plan } = fixture('all', true, 0);
  const captured = plan('failure', new Set([1, 2, 3]));
  assertEquals(captured.candidates, []);
  assertEquals(player.applySuccessor(captured), 'player+queue');
  assertEquals(player.status().state, 'stop');
  assertEquals(player.queue().items.map((item) => item.id), [2, 3]);
});

Deno.test('successor empty or missing anchors never invent a destination', () => {
  for (const items of [[], fixture('off', false, 0).player.queue().items]) {
    const plan = planPlaybackSuccessor({
      reason: 'failure',
      revision: 7,
      items,
      currentEntryId: undefined,
      repeat: 'all',
      consume: true,
    });
    assertEquals(plan.entryId, null);
    assertEquals(plan.removedEntryId, null);
    assertEquals(plan.candidates, []);
  }
});

Deno.test('successor repeats retain occurrence identity but open fresh source incarnations', () => {
  let time = 0;
  const player = createPlayer({ now: () => time, monotonicNow: () => time });
  const [entry] = player.queueAddSources([media]);
  player.setRepeat('single');
  player.play();
  const first = player.openSource(entry.id, player.status().generation)!;
  assert(player.sourceOutcome(first, 'eof'));
  time = 10;
  assertEquals(player.advanceEnded(), 'player');
  const second = player.openSource(entry.id, player.status().generation)!;
  assert(first.signal.aborted);
  assert(second !== first && second.generation > first.generation);
  assertEquals(second.entryId, first.entryId);
  assertEquals(player.sourceOutcome(first, 'eof'), false);
});

for (const reason of ['natural', 'failure'] as const) {
  Deno.test(`successor ${reason} preparation applies its resolved fallback in one transition`, async () => {
    let time = 0;
    const player = createPlayer({ now: () => time, monotonicNow: () => time });
    const resolved: string[] = [];
    const notify = createNotify();
    const playback = createPlayback({
      player,
      notify,
      cfg: {},
      library: { getSong: () => Promise.resolve(null) },
      nowPlaying: {} as NowPlaying,
      resolveQueueReference(reference) {
        assert(reference.kind === 'station');
        resolved.push(reference.id);
        return Promise.resolve(null);
      },
    });
    try {
      const entries = await playback.queueAddSources([
        media,
        { reference: { kind: 'station', id: 'removed' }, facts: media.facts },
        media,
      ]);
      await playback.play();
      const generation = player.status().generation;
      const source = playback.openSource(entries[0].id, generation)!;
      // reportSourceOutcome starts failure work itself. A concurrent tick can
      // deliberately return without joining that pending start, so observe
      // actual publication rather than assuming the tick is its receipt.
      const published = Promise.withResolvers<void>();
      const unsubscribe = notify.subscribe(() => {
        if (player.status().current?.id === entries[2].id) {
          unsubscribe();
          published.resolve();
        }
      });
      assert(
        playback.reportSourceOutcome(
          source,
          reason === 'natural' ? 'eof' : 'transport-error',
        ),
      );
      time = 10;
      await playback.advanceEnded();
      await published.promise;
      assertEquals(resolved, ['removed']);
      assertEquals(player.status().current?.id, entries[2].id);
      assertEquals(player.status().generation, generation + 1);
      assert(source.signal.aborted);
      assertEquals(
        playback.queueView().items.map((entry) => entry.id),
        entries.map((entry) => entry.id),
      );
    } finally {
      await playback.close();
    }
  });
}
