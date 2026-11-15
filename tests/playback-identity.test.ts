import { assert, assertEquals } from '@std/assert';
import { createPlayback, type QueueCopySnapshot } from '../src/playback.ts';
import { createPlayer } from '../src/player.ts';
import { PlaybackError } from '../src/playback-errors.ts';
import type { QueueMedia } from '../src/queue-source.ts';
import type { NowPlaying } from '../src/nowplaying.ts';

const media = (id: string): QueueMedia => ({
  reference: { kind: 'station', id },
  facts: {
    kind: 'web',
    url: `http://melofon.home/${id}`,
    title: id,
    artistName: null,
    durationMs: null,
    mode: 'live',
    seekable: false,
    streamTitle: null,
    streamUrl: null,
  },
});
const snapshot = (id: string): QueueCopySnapshot => ({
  items: [media(id)],
  currentIndex: 0,
  positionMs: 0,
  repeat: 'off',
  consume: false,
});
const publish = (change: () => void) => {
  change();
  return Promise.resolve();
};
async function turns() {
  for (let n = 0; n < 30; n++) await Promise.resolve();
}
function fixture(
  overrides: Partial<Parameters<typeof createPlayback>[0]> = {},
) {
  const player = createPlayer();
  const entries = player.queueAddSources([media('first'), media('second')]);
  const playback = createPlayback({
    player,
    cfg: {},
    library: { getSong: () => Promise.resolve(null) },
    nowPlaying: {} as NowPlaying,
    ...overrides,
  });
  return { player, playback, entries };
}
function cancelled(error: unknown) {
  assert(error instanceof PlaybackError);
  assertEquals(error.code, 'playback_cancelled');
}

Deno.test('identity replacement follows a moved occurrence and never a reused position', () => {
  const player = createPlayer();
  const [first, second] = player.queueAddSources([
    media('first'),
    media('second'),
  ]);
  player.queueMove(first.id, 1);
  assert(player.replaceOccurrence(first.id, media('refreshed')));
  assertEquals(
    player.queue().items.map((entry) => [entry.id, entry.reference]),
    [
      [second.id, second.reference],
      [first.id, media('refreshed').reference],
    ],
  );
  player.playOccurrence(first.id);
  assertEquals(player.status().current?.id, first.id);
  player.queueRemove(first.id);
  const before = player.queue();
  assertEquals(player.replaceOccurrence(first.id, media('late')), false);
  assertEquals(player.queue(), before);
});

Deno.test('ordinary copy appends preserve a pending start and allocate fresh occurrence ids', async () => {
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let signal!: AbortSignal;
  const f = fixture({
    targets: {
      hasPlaybackTarget: () => true,
      async preparePlayback(s) {
        signal = s;
        entered.resolve();
        await release.promise;
      },
    },
  });
  const start = Promise.resolve(f.playback.play()).then(
    () => null,
    (error) => error,
  );
  try {
    await entered.promise;
    await f.playback.queueImport(
      snapshot('copied'),
      { mode: 'add' },
      undefined,
      publish,
    );
    assertEquals(signal.aborted, false);
    release.resolve();
    assertEquals(await start, null);
    assertEquals(f.playback.playerView().current?.id, f.entries[0].id);
    const items = f.playback.queueView().items;
    assertEquals(items.length, 3);
    assert(!f.entries.some((entry) => entry.id === items[2].id));
  } finally {
    release.resolve();
    await start;
    await f.playback.close();
  }
});

Deno.test('mixed ordinary additions and copies share FIFO without borrowing command authority', async () => {
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const f = fixture({
    resolveQueueReference: async () => {
      entered.resolve();
      await release.promise;
      return media('append');
    },
  });
  const append = f.playback.queueAddReferences([{
    kind: 'station',
    id: 'append',
  }]);
  let copying: Promise<void> | undefined;
  try {
    await entered.promise;
    copying = f.playback.queueImport(
      snapshot('copy'),
      { mode: 'add' },
      undefined,
      publish,
    );
    f.playback.pause();
    await turns();
    assertEquals(f.playback.queueView().items.length, 2);
    release.resolve();
    await Promise.all([append, copying]);
    assertEquals(
      f.playback.queueView().items.map((entry) => entry.reference),
      ['first', 'second', 'append', 'copy'].map((id) => media(id).reference),
    );
  } finally {
    release.resolve();
    await Promise.allSettled([append, copying]);
    await f.playback.close();
  }
});

for (const command of ['play', 'pause', 'stop'] as const) {
  Deno.test(`delayed replacement publication cannot overwrite newer ${command} intent`, async () => {
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const f = fixture();
    const copy = f.playback.queueImport(
      snapshot('obsolete'),
      { mode: 'replace' },
      undefined,
      async (change) => {
        entered.resolve();
        await release.promise;
        change();
      },
    )
      .then(() => null, (error) => error);
    try {
      await entered.promise;
      await f.playback[command]();
      const before = f.playback.queueView(), last = f.playback.lastCommand();
      release.resolve();
      cancelled(await copy);
      assertEquals(f.playback.queueView(), before);
      assertEquals(f.playback.lastCommand(), last);
      assertEquals(
        f.playback.playerView().state,
        command === 'play' ? 'play' : 'stop',
      );
    } finally {
      release.resolve();
      await copy;
      await f.playback.close();
    }
  });
}

for (const phase of ['resolve', 'allocate'] as const) {
  Deno.test(`submitted add-and-play held in ${phase} cannot revoke its successor`, async () => {
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const target = Promise.withResolvers<void>(),
      finishTarget = Promise.withResolvers<void>();
    let signal!: AbortSignal;
    const f = fixture({
      resolveQueueReference: async (reference) => {
        if (
          phase === 'resolve' && reference.kind === 'station' &&
          reference.id === 'old'
        ) {
          entered.resolve();
          await release.promise;
        }
        return media(reference.kind === 'station' ? reference.id : 'old');
      },
      reserveQueueIds: async () => {
        if (phase === 'allocate') {
          entered.resolve();
          await release.promise;
        }
        return 20;
      },
      targets: {
        hasPlaybackTarget: () => true,
        async preparePlayback(s) {
          signal = s;
          target.resolve();
          await finishTarget.promise;
        },
      },
    });
    const old = f.playback.queueAddReferences(
      [{ kind: 'station', id: 'old' }],
      { play: true },
    )
      .then(() => null, (error) => error);
    let newer: Promise<unknown> | undefined;
    try {
      await entered.promise;
      // Use a source with captured authority as the boot resume consumer does.
      const boot = new AbortController();
      newer = Promise.resolve(
        f.playback.play(undefined, {
          signal: boot.signal,
          isCurrent: () => true,
        }),
      );
      await target.promise;
      release.resolve();
      cancelled(await old);
      assertEquals(signal.aborted, false);
      finishTarget.resolve();
      await newer;
      assertEquals(f.playback.playerView().current?.id, f.entries[0].id);
      assertEquals(f.playback.queueView().items.length, 2);
    } finally {
      release.resolve();
      finishTarget.resolve();
      await Promise.allSettled([old, newer]);
      await f.playback.close();
    }
  });
}

Deno.test('held volume publication and an ordinary append survive newer playback intent', async () => {
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const f = fixture({
    persistence: {
      saveQueue() {},
      saveState() {},
      async changeVolume(change) {
        entered.resolve();
        await release.promise;
        change();
      },
    },
  });
  const volume = f.playback.setVolume({ volume: 73 });
  try {
    await entered.promise;
    await f.playback.play();
    await f.playback.queueAddSources([media('append')]);
    f.playback.pause();
    release.resolve();
    await volume;
    assertEquals(f.playback.playerView().volume, 73);
    assertEquals(f.playback.playerView().state, 'pause');
    assertEquals(f.playback.queueView().items.length, 3);
  } finally {
    release.resolve();
    await volume;
    await f.playback.close();
  }
});

for (const mutation of ['insert', 'move'] as const) {
  Deno.test(`prepared existing occurrence is validated before publication after ${mutation}`, async () => {
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const f = fixture({
      resolveQueueReference: async () => {
        entered.resolve();
        await release.promise;
        return media('refreshed');
      },
    });
    const start = Promise.resolve(f.playback.play()).then(
      () => null,
      (error) => error,
    );
    try {
      await entered.promise;
      if (mutation === 'insert') {
        await f.playback.queueAddSources([media('inserted')], { position: 0 });
      } else f.player.queueMove(f.entries[0].id, 1);
      const before = f.playback.queueView();
      release.resolve();
      cancelled(await start);
      assertEquals(f.playback.queueView(), before);
      assertEquals(f.playback.playerView().state, 'stop');
    } finally {
      release.resolve();
      await start;
      await f.playback.close();
    }
  });
}

Deno.test('prepared new media selects its newly minted occurrence when an earlier candidate is missing', async () => {
  const f = fixture({
    resolveQueueReference: (reference) =>
      Promise.resolve(
        reference.kind === 'station' && reference.id === 'missing'
          ? null
          : media('refreshed'),
      ),
  });
  try {
    const added = await f.playback.queueAddSources([
      media('missing'),
      media('new'),
    ], { clear: true, play: true });
    assertEquals(f.playback.playerView().current?.id, added[1].id);
    assertEquals(
      f.playback.playerView().current?.reference,
      media('refreshed').reference,
    );
    assert(!f.entries.some((entry) => entry.id === added[1].id));
  } finally {
    await f.playback.close();
  }
});
