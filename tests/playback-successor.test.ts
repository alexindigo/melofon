import { assert, assertEquals } from '@std/assert';
import { planPlaybackSuccessor } from '../src/playback-successor.ts';
import { planSourceFailure } from '../src/source-recovery.ts';
import { createPlayer, type RepeatMode } from '../src/player.ts';
import type { QueueMedia } from '../src/queue-source.ts';
import { createPlayback } from '../src/playback.ts';
import type { NowPlaying } from '../src/nowplaying.ts';
import { createNotify } from '../src/notify.ts';

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
