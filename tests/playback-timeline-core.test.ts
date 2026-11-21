// Ordered core source ownership. Production HTTP early input is enabled by b08b.
import { assert, assertEquals, assertThrows } from '@std/assert';
import {
  createPlayer,
  type PlaybackSource,
  type PlayerPersistence,
  type RepeatMode,
} from '../src/player.ts';
import { createPlayback, type PlaybackSink } from '../src/playback.ts';
import { createNotify } from '../src/notify.ts';
import type { NowPlaying } from '../src/nowplaying.ts';
import { catalogMedia, type QueueMedia } from '../src/queue-source.ts';
import type { TimelineSource } from '../src/playback-timeline.ts';
import { createMedia } from '../src/media.ts';
import { createFfiStream } from '../src/boots/raop-ffi.ts';
import { profileFromService } from '../src/boots/airplay-profile.ts';
import { startFakeRaop } from './helpers/fake-raop.ts';
import { renderScheduledAudio } from './helpers/raop-scheduled-consumer.ts';
import { traceTimelineAudio } from './helpers/raop-timeline-audio.ts';
import type { State } from '../src/state.ts';

const media: QueueMedia = {
  reference: { kind: 'url', url: 'http://media.home/finite' },
  facts: {
    kind: 'web',
    url: 'http://media.home/finite',
    title: null,
    artistName: null,
    mode: 'finite',
    durationMs: 1000,
    seekable: true,
    streamTitle: null,
    streamUrl: null,
  },
};
const sleep = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>) {
  const end = performance.now() + 15000;
  while (!await check()) {
    assert(performance.now() < end, 'ordered source outcome timed out');
    await sleep();
  }
}
function test(name: string, fn: () => Promise<void>) {
  Deno.test({
    name: `playback timeline core: ${name}`,
    sanitizeOps: false,
    sanitizeResources: false,
    fn,
  });
}
async function core(
  options: {
    repeat?: RepeatMode;
    consume?: boolean;
    sink?: PlaybackSink;
    items?: QueueMedia[];
    resolve?: () => Promise<QueueMedia | null>;
    persistence?: PlayerPersistence;
    identity?: () => { id: bigint; epoch: bigint };
    state?: Pick<State, 'declare' | 'getTyped'>;
  } = {},
) {
  const player = createPlayer(), notify = createNotify();
  const playback = createPlayback({
    player,
    notify,
    cfg: {},
    library: { getSong: () => Promise.resolve(null) },
    nowPlaying: {} as NowPlaying,
    resolveQueueReference: options.resolve,
    persistence: options.persistence,
    state: options.state,
  });
  const detach = playback.attachSink(options.sink);
  const entries = await playback.queueAddSources(
    options.items ?? [media, media, media],
  );
  await playback.setRepeat(options.repeat ?? 'off');
  await playback.setConsume(options.consume ?? false);
  await playback.play();
  const primary = playback.openSource(
    entries[0].id,
    player.status().generation,
  )!;
  const identity = options.identity ?? (() => ({ id: 1n, epoch: 1n }));
  const mapping = playback.bindSource(
    primary,
    identity().id,
    identity().epoch,
  )!;
  const next = async (after = primary) => {
    const read = await playback.prepareNextSource(after);
    assert(read);
    assert(playback.admitSource(read));
    const mapped = playback.bindSource(
      read.source,
      identity().id,
      identity().epoch,
    )!;
    assert(mapped);
    return { read, source: read.source, mapping: mapped };
  };
  const sealed = (source: PlaybackSource, frames = 353n) => {
    assert(playback.sourceAccepted(source, frames));
    assert(playback.reportSourceOutcome(source, 'eof'));
    assert(playback.sealSource(source, frames));
  };
  const complete = (
    source: PlaybackSource,
    mapped: TimelineSource,
    frames = 353n,
  ) =>
    playback.completeSource(source, {
      ...mapped,
      target: frames,
      revision: 1n,
      status: 'complete',
    });
  return {
    playback,
    player,
    notify,
    entries,
    primary,
    mapping,
    next,
    sealed,
    complete,
    async close() {
      await playback.close();
      detach();
    },
  };
}

for (const repeat of ['off', 'single', 'all'] as const) {
  for (const consume of [false, true]) {
    test(`ordered promotion ${repeat} consume=${consume} preserves later incarnations`, async () => {
      const f = await core({ repeat, consume });
      try {
        const b = await f.next(), c = await f.next(b.source);
        const initial = f.player.status().generation;
        assertEquals(f.player.status().current?.id, f.entries[0].id);
        assertEquals(f.playback.sourcePlanView().playing, f.primary);
        assertEquals(
          f.playback.sourceProgress(b.source, {
            ...b.mapping,
            capturedNs: 100n,
            sourceFrames: 100n,
            status: 'scheduled',
            error: 'none',
          }),
          true,
        );
        assertEquals(
          f.player.status().itemProgressMs,
          0,
          'future progress is private',
        );
        f.sealed(f.primary);
        f.sealed(b.source);
        f.sealed(c.source);
        const bDone = f.complete(b.source, b.mapping);
        assertEquals(
          f.player.status().generation,
          initial,
          'out-of-order future completion never publishes',
        );
        const aDone = f.complete(f.primary, f.mapping);
        await aDone;
        await bDone;
        assertEquals(f.player.status().generation, initial + 2);
        assertEquals(f.player.status().current?.id, c.source.entryId);
        assert(f.primary.signal.aborted && b.source.signal.aborted);
        assertEquals(c.source.signal.aborted, false);
        assertEquals(f.playback.sourcePlanView().playing, c.source);
        assertEquals(
          f.playback.openSource(c.source.entryId, f.player.status().generation),
          null,
          'already-admitted reader is not reopened',
        );
        assertEquals(
          f.playback.queueView().items.map((e) => e.id),
          consume && repeat === 'off'
            ? [f.entries[2].id]
            : f.entries.map((e) => e.id),
        );
        assertEquals(
          await f.complete(f.primary, f.mapping),
          false,
          'a completed incarnation cannot consume twice',
        );
      } finally {
        await f.close();
      }
    });
  }
}
test('final exhaustion waits for the final native completion, not read EOF', async () => {
  const f = await core();
  try {
    const b = await f.next(), c = await f.next(b.source);
    f.sealed(f.primary);
    f.sealed(b.source);
    f.sealed(c.source);
    assert(f.playback.finishSources(c.source));
    await f.complete(f.primary, f.mapping);
    await f.complete(b.source, b.mapping);
    assertEquals(f.player.status().current?.id, c.source.entryId);
    assertEquals(f.player.status().state, 'play');
    await f.complete(c.source, c.mapping);
    assertEquals(f.player.status().state, 'stop');
    assertEquals(f.player.status().current, null);
  } finally {
    await f.close();
  }
});
test('rejected cutoff retains the observed bookmark and allows later Play', async () => {
  const saves: { positionMs: number; position?: Promise<number> }[] = [];
  const f = await core({
    persistence: {
      saveQueue() {},
      saveState(state, position) {
        saves.push({ positionMs: state.positionMs, position });
      },
    },
    sink: { cutoff: () => Promise.reject(new Error('native cutoff fault')) },
  });
  try {
    f.playback.sourceProgress(f.primary, {
      ...f.mapping,
      capturedNs: 1n,
      sourceFrames: 13230n,
      status: 'scheduled',
      error: 'none',
    });
    f.playback.pause();
    assertEquals(await saves.at(-1)!.position, 300);
    await f.playback.play();
    assertEquals(f.playback.playerView().state, 'play');
    assertEquals(f.playback.playerView().itemProgressMs, 300);
  } finally {
    await f.close();
  }
});

test('future web retries own independent budgets retained after promotion', async () => {
  const f = await core({
    state: {
      declare() {},
      getTyped(key) {
        return Promise.resolve(
          key === 'playback.source.retryBackoffMs' ? [0] : undefined,
        );
      },
    },
  });
  try {
    const b = await f.next();
    assert(await f.playback.retrySource(b.source, 'decode-error'));
    assert(await f.playback.retrySource(f.primary, 'decode-error'));
    assertEquals(await f.playback.retrySource(b.source, 'decode-error'), false);
    f.sealed(f.primary);
    await f.complete(f.primary, f.mapping);
    assertEquals(f.playback.sourcePlanView().playing, b.source);
    assertEquals(await f.playback.retrySource(b.source, 'decode-error'), false);
  } finally {
    await f.close();
  }
});
test('pre-capture reanchor rejection settles edit saves from the observed position', async () => {
  const positions: (Promise<number> | undefined)[] = [];
  const f = await core({
    persistence: {
      saveQueue(_queue, _state, position) {
        positions.push(position);
      },
      saveState(_state, position) {
        positions.push(position);
      },
    },
    sink: {
      cutoff: () => null,
      reanchor: () => Promise.reject(new Error('pre-capture reanchor fault')),
    },
  });
  try {
    const b = await f.next();
    f.sealed(b.source);
    f.playback.sourceProgress(f.primary, {
      ...f.mapping,
      capturedNs: 1n,
      sourceFrames: 13230n,
      status: 'scheduled',
      error: 'none',
    });
    await f.playback.queueRemove(b.source.entryId);
    const captures = positions.filter((position) => position !== undefined);
    assert(captures.length > 0);
    assertEquals(await Promise.all(captures), captures.map(() => 300));
    assertEquals(f.playback.playerView().state, 'pause');
    await f.playback.play();
    assertEquals(f.playback.playerView().state, 'play');
  } finally {
    await f.close();
  }
});
test('a catalog primary does not disqualify its finite web successor retries', async () => {
  const catalog = catalogMedia({
    id: 'catalog',
    path: '/music/catalog.wav',
    fileName: 'catalog.wav',
    libraryId: null,
    libraryPath: null,
    title: 'Catalog',
    albumId: null,
    albumName: null,
    albumFolderName: null,
    artistId: null,
    artistName: null,
    track: null,
    disc: null,
    durationMs: 1000,
    size: 1,
    genre: null,
    year: null,
    firstSeenMs: null,
    isVideo: false,
    suffix: 'wav',
    contentType: 'audio/wav',
  });
  const f = await core({
    items: [catalog, media],
    state: {
      declare() {},
      getTyped(key) {
        return Promise.resolve(
          key === 'playback.source.retryBackoffMs' ? [0] : undefined,
        );
      },
    },
  });
  try {
    const b = await f.next();
    assert(await f.playback.retrySource(b.source, 'decode-error'));
    assertEquals(
      await f.playback.retrySource(f.primary, 'decode-error'),
      false,
    );
  } finally {
    await f.close();
  }
});
test('unrelated append retains accepted future source and rebases consume effects', async () => {
  const f = await core({ consume: true });
  try {
    const b = await f.next();
    f.sealed(f.primary);
    f.sealed(b.source);
    await f.playback.queueAddSources([media]);
    assertEquals(b.source.signal.aborted, false);
    await f.complete(f.primary, f.mapping);
    assertEquals(f.player.status().current?.id, b.source.entryId);
    assertEquals(f.playback.queueView().items.map((e) => e.id), [2, 3, 4]);
  } finally {
    await f.close();
  }
});
test('invalidating an unaccepted future cancels only that suffix and permits replan', async () => {
  const f = await core();
  try {
    const b = await f.next();
    const generation = f.player.status().generation;
    await f.playback.queueRemove(b.source.entryId);
    assert(b.source.signal.aborted);
    assertEquals(f.primary.signal.aborted, false);
    assertEquals(f.player.status().generation, generation);
    const c = await f.next();
    assertEquals(c.source.entryId, 3);
  } finally {
    await f.close();
  }
});
test('stale expectedVersion neither mutates nor fences accepted future input', async () => {
  const f = await core();
  try {
    const b = await f.next();
    f.sealed(b.source);
    assertThrows(() => f.playback.queueMove(b.source.entryId, 2, 0));
    assertEquals(b.source.signal.aborted, false);
    assertEquals(f.primary.signal.aborted, false);
    assertEquals(f.playback.queueView().items.map((e) => e.id), [1, 2, 3]);
  } finally {
    await f.close();
  }
});
test('future outcome failure does not cancel the healthy primary or publish early', async () => {
  const f = await core();
  try {
    const b = await f.next();
    assert(f.playback.reportSourceOutcome(b.source, 'decode-error'));
    assertEquals(f.primary.signal.aborted, false);
    assertEquals(f.player.status().current?.id, f.primary.entryId);
    assertEquals(f.player.status().state, 'play');
    f.sealed(f.primary);
    await f.complete(f.primary, f.mapping);
    await f.playback.advanceEnded();
    assertEquals(
      f.player.status().current?.id,
      3,
      'the retained failure uses existing skip policy only when due',
    );
    assert(b.source.signal.aborted);
  } finally {
    await f.close();
  }
});

test('refreshed future facts publish only with the matching scheduled incarnation', async () => {
  const resolved: QueueMedia = {
    ...media,
    facts: { ...media.facts, title: 'Resolved B' },
  };
  const f = await core({
    items: [
      media,
      { ...media, reference: { kind: 'station', id: 'B' } },
      media,
    ],
    resolve: () => Promise.resolve(resolved),
  });
  try {
    const b = await f.next();
    assert(b.read.entry.facts.kind === 'web');
    assertEquals(b.read.entry.facts.title, 'Resolved B');
    const before = f.playback.queueView().items[1];
    assert(before.facts.kind === 'web');
    assertEquals(
      before.facts.title,
      null,
      'preparation does not publish queue facts',
    );
    f.sealed(f.primary);
    await f.complete(f.primary, f.mapping);
    const current = f.player.status().current!;
    assert(current.facts.kind === 'web');
    assertEquals(current.id, b.source.entryId);
    assertEquals(current.facts.title, 'Resolved B');
  } finally {
    await f.close();
  }
});

test('future bindings cannot escape the primary stream or epoch', async () => {
  const f = await core();
  try {
    const read = await f.playback.prepareNextSource(f.primary);
    assert(read);
    assert(f.playback.admitSource(read));
    assertEquals(f.playback.bindSource(read.source, 2n, 1n), null);
    assertEquals(f.playback.bindSource(read.source, 1n, 2n), null);
    assert(f.playback.bindSource(read.source, 1n, 1n));
  } finally {
    await f.close();
  }
});

for (const edit of ['remove', 'move', 'repeat', 'consume', 'insert'] as const) {
  test(`accepted future ${edit} shares atomic cutoff and joined reanchor`, async () => {
    const captured = Promise.withResolvers<void>(),
      ready = Promise.withResolvers<void>();
    let fences = 0;
    const f = await core({
      sink: {
        cutoff: () => null,
        reanchor(mapping, commit) {
          fences++;
          return (async () => {
            await captured.promise;
            commit({
              ...mapping,
              nextEpoch: mapping.epoch + 1n,
              admittedNs: 99n,
              progress: {
                ...mapping,
                capturedNs: 99n,
                sourceFrames: 13230n,
                status: 'scheduled',
                error: 'none',
              },
            });
            await ready.promise;
          })();
        },
      },
    });
    try {
      const b = await f.next();
      f.sealed(b.source);
      const generation = f.player.status().generation;
      const result = edit === 'remove'
        ? f.playback.queueRemove(b.source.entryId)
        : edit === 'move'
        ? f.playback.queueMove(b.source.entryId, 2)
        : edit === 'repeat'
        ? f.playback.setRepeat('single')
        : edit === 'consume'
        ? f.playback.setConsume(true)
        : f.playback.queueAddSources([media], { where: 'next' });
      let settled = false;
      const mutation = Promise.resolve(result).then(() => {
        settled = true;
      });
      assertEquals(fences, 1);
      assert(b.source.signal.aborted && f.primary.signal.aborted);
      assertEquals(f.player.status().current?.id, f.primary.entryId);
      assertEquals(f.player.status().generation, generation);
      captured.resolve();
      await sleep(0);
      assertEquals(f.player.status().itemProgressMs, 300);
      assertEquals(f.player.status().state, 'play');
      assertEquals(f.player.status().generation, generation + 1);
      assertEquals(
        settled,
        false,
        'an edit joins receiver readiness, not only cutoff capture',
      );
      ready.resolve();
      await mutation;
      const resumed = f.playback.openSource(
        f.primary.entryId,
        f.player.status().generation,
      )!;
      assert(resumed);
      assertEquals(resumed.startMs, 300);
      assert(f.playback.bindSource(resumed, 1n, 2n));
      assertEquals(f.playback.sourcePlanView().playing, resumed);
    } finally {
      captured.resolve();
      ready.resolve();
      await f.close();
    }
  });
}
test('accepted-future edit save captures the same atomic bookmark promise once', async () => {
  const captured = Promise.withResolvers<void>(),
    ready = Promise.withResolvers<void>();
  const saves: { ids: number[]; position?: Promise<number> }[] = [];
  const states: { positionMs: number; position?: Promise<number> }[] = [];
  const f = await core({
    persistence: {
      saveQueue(snapshot, _state, position) {
        saves.push({ ids: snapshot.items.map((item) => item.id), position });
      },
      saveState(state, position) {
        states.push({ positionMs: state.positionMs, position });
      },
    },
    sink: {
      cutoff: () => null,
      reanchor(mapping, commit) {
        return (async () => {
          await captured.promise;
          commit({
            ...mapping,
            nextEpoch: 2n,
            admittedNs: 99n,
            progress: {
              ...mapping,
              capturedNs: 99n,
              sourceFrames: 13230n,
              status: 'scheduled',
              error: 'none',
            },
          });
          await ready.promise;
        })();
      },
    },
  });
  try {
    const b = await f.next();
    f.sealed(b.source);
    const before = saves.length;
    const editing = f.playback.queueRemove(b.source.entryId);
    assertEquals(saves.length, before + 1, 'one queue publication/save batch');
    const batch = saves.at(-1)!;
    assertEquals(batch.ids, [1, 3]);
    assert(batch.position);
    let settled = false;
    void batch.position.then(() => {
      settled = true;
    });
    await Promise.resolve();
    assertEquals(settled, false);
    captured.resolve();
    assertEquals(await batch.position, 300);
    assertEquals(f.player.status().itemProgressMs, 300);
    ready.resolve();
    await editing;
    assertEquals(
      await batch.position,
      300,
      'later readiness cannot resample the save',
    );
    assertEquals(saves.length, before + 1);
    const replacement = f.playback.openSource(
      f.primary.entryId,
      f.player.status().generation,
    )!;
    const mapping = f.playback.bindSource(replacement, 1n, 2n)!;
    assert(f.playback.sourceProgress(replacement, {
      ...mapping,
      capturedNs: 100n,
      sourceFrames: 22050n,
      status: 'scheduled',
      error: 'none',
    }));
    await until(() => states.at(-1)?.positionMs === 800);
    const latest = states.at(-1)!;
    assertEquals(
      await (latest.position ?? Promise.resolve(latest.positionMs)),
      800,
      'later periodic saves do not reuse the edit cutoff',
    );
  } finally {
    captured.resolve();
    ready.resolve();
    await f.close();
  }
});

test('late reanchor readiness cannot overwrite a newer same-entry seek', async () => {
  const ready = Promise.withResolvers<void>();
  const f = await core({
    sink: {
      cutoff: () => null,
      reanchor(mapping, commit) {
        return Promise.resolve().then(() => {
          commit({
            ...mapping,
            nextEpoch: 2n,
            admittedNs: 99n,
            progress: {
              ...mapping,
              capturedNs: 99n,
              sourceFrames: 4410n,
              status: 'scheduled',
              error: 'none',
            },
          });
          return ready.promise;
        });
      },
    },
  });
  try {
    const b = await f.next();
    f.sealed(b.source);
    const edit = f.playback.queueRemove(b.source.entryId);
    await sleep(0);
    await f.playback.seek({ positionMs: 600 });
    const generation = f.player.status().generation;
    assertEquals(f.player.status().itemProgressMs, 600);
    ready.resolve();
    await edit;
    assertEquals(f.player.status().generation, generation);
    assertEquals(f.player.status().itemProgressMs, 600);
  } finally {
    ready.resolve();
    await f.close();
  }
});

function wav(frames: number, seed: number) {
  const bytes = new Uint8Array(44 + frames * 4), v = new DataView(bytes.buffer);
  for (
    const [at, text] of [[0, 'RIFF'], [8, 'WAVEfmt '], [36, 'data']] as const
  ) bytes.set(new TextEncoder().encode(text), at);
  v.setUint32(4, bytes.length - 8, true);
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 2, true);
  v.setUint32(24, 44100, true);
  v.setUint32(28, 176400, true);
  v.setUint16(32, 4, true);
  v.setUint16(34, 16, true);
  v.setUint32(40, frames * 4, true);
  for (let i = 0; i < frames; i++) {
    v.setInt16(44 + i * 4, (i * 17 + seed) % 28000 - 14000, true);
    v.setInt16(46 + i * 4, 14000 - (i * 19 + seed) % 28000, true);
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
  const hash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', await Deno.readFile(path)),
  );
  console.log(
    `ordered core native library: ${path} sha256=${
      Array.from(hash, (v) => v.toString(16).padStart(2, '0')).join('')
    }`,
  );
}
async function native() {
  const receiver = await startFakeRaop({
    captureAudio: true,
    captureWire: true,
  });
  const trace = traceTimelineAudio(createFfiStream), stream = trace.stream();
  const attachment = stream.attach(() => {});
  const directory = await Deno.makeTempDir({ prefix: 'ordered-core-' });
  const decoder = createMedia();
  const cutoffs = [] as Awaited<ReturnType<typeof stream.cancelSource>>[];
  const sink: PlaybackSink = {
    reanchor(mapping, capture) {
      return stream.cancelSource(mapping.epoch, mapping.source, [], capture)
        .then(async (result) => {
          assertEquals(result.status, 'ready');
          cutoffs.push(result);
          await stream.ackCancel(result.epoch);
        });
    },
    cutoff(mapping, _intent, capture) {
      return this.reanchor!(mapping, capture);
    },
  };
  const f = await core({
    sink,
    identity: () => ({ id: stream.id, epoch: stream.epoch }),
  });
  const profile = profileFromService({
    name: '001122334455@Ordered._raop._tcp.local',
    host: 'fixture.local',
    address: '127.0.0.1',
    port: receiver.port,
    ttlMs: 60000,
    txt: { tp: 'UDP', am: 'AppleTV2,1' },
  });
  let segment = 0n;
  const feed = async (
    source: PlaybackSource,
    mapping: TimelineSource,
    frames: number,
    seed: number,
  ) => {
    const bytes = wav(frames, seed),
      path = `${directory}/${source.generation}.wav`;
    await Deno.writeFile(path, bytes);
    const pcm = await decoder.decodePcm(path, { startMs: source.startMs });
    assert(pcm);
    let accepted = 0n;
    for await (const chunk of pcm) {
      const currentSegment = ++segment;
      let offset = 0;
      while (offset < chunk.length) {
        const result = await stream.appendSource({
          epoch: stream.epoch,
          source: mapping.source,
          segment: currentSegment,
          pcm: chunk.subarray(offset),
        });
        assert(['accepted', 'backpressure'].includes(result.status));
        assert(f.playback.sourceAccepted(source, result.acceptedFrames));
        offset += Number(result.acceptedFrames) * 4;
        accepted += result.acceptedFrames;
        if (offset < chunk.length) await sleep();
      }
    }
    await pcm.completion;
    assertEquals(pcm.originFrame, mapping.originFrame);
    assertEquals(accepted, BigInt(frames) - pcm.originFrame);
    assert(f.playback.reportSourceOutcome(source, 'eof'));
    assert(f.playback.sealSource(source, accepted));
    const marker = await stream.seal(stream.epoch, mapping.source, accepted);
    assertEquals(marker.status, 'accepted');
    return {
      bytes: bytes.subarray(44 + Number(pcm.originFrame) * 4),
      key: {
        epoch: stream.epoch,
        source: mapping.source,
        target: accepted,
        revision: 1n,
      },
      marker,
    };
  };
  return {
    ...f,
    stream,
    trace,
    receiver,
    cutoffs,
    feed,
    start: () =>
      attachment.start(profile, {
        volume: 100,
        positionMs: 0,
        lengthMs: 1000,
        title: '',
        artist: '',
      }),
    async close() {
      await f.close();
      await stream.close();
      receiver.close();
      await Deno.remove(directory, { recursive: true });
    },
  };
}

for (
  const frames of [[353, 351], [44100 + 137, 22050 + 19], [
    1,
    351,
    353,
  ]] as const
) {
  test(`actual decode and same-epoch ordered markers ${frames.join('/')}`, async () => {
    const f = await native();
    try {
      const sources = [{ source: f.primary, mapping: f.mapping }];
      const fed = [];
      for (const [i, count] of frames.entries()) {
        if (i) sources.push(await f.next(sources[i - 1].source));
        fed.push(
          await f.feed(sources[i].source, sources[i].mapping, count, i * 500),
        );
      }
      if (frames.length === 2) {
        // Keep the unused last queue occurrence out of final exhaustion policy.
        await f.playback.queueRemove(3);
      }
      assert(f.playback.finishSources(sources.at(-1)!.source));
      const epoch = f.stream.epoch;
      assertEquals(
        (await f.stream.endStream(epoch, fed.at(-1)!.marker.inputEnd)).status,
        'accepted',
      );
      assertEquals(f.player.status().current?.id, f.primary.entryId);
      await f.start();
      await until(() => !!f.receiver.sessions[0]);
      assertEquals(
        f.player.status().itemProgressMs,
        0,
        'queued/arriving samples are not played',
      );
      const renderedFrames = frames.reduce((n, v) => n + v, 0);
      await until(() =>
        renderScheduledAudio(f.receiver.sessions[0], f.receiver.nowMs()).pcm
          .length >= renderedFrames * 4
      );
      for (let i = 0; i < sources.length; i++) {
        const { source, mapping } = sources[i];
        const progress = await f.stream.progress(epoch, mapping.source);
        assert(progress);
        assert(f.playback.sourceProgress(source, progress));
        const completed = await f.stream.waitCompletion(fed[i].key);
        assertEquals(completed.status, 'complete');
        assertEquals(f.player.status().current?.id, source.entryId);
        const committed = f.playback.completeSource(source, completed);
        await committed;
        assert(
          await f.stream.pollCompletion(fed[i].key),
          'terminal result retained until matching core publication',
        );
      }
      const expected = new Uint8Array(renderedFrames * 4);
      let at = 0;
      for (const part of fed) {
        expected.set(part.bytes, at);
        at += part.bytes.length;
      }
      const ranges = f.trace.epochs[0].ranges;
      const lastReal = ranges.findLastIndex((range) => range.kind === 'real');
      assert(
        ranges.slice(0, lastReal + 1).every((range) => range.kind === 'real'),
        'healthy adjacent sources contain no inserted transport silence',
      );
      assertEquals(
        f.trace.scheduledRealAudio(f.receiver.sessions[0], f.receiver.nowMs()),
        expected,
      );
      assertEquals(f.trace.realAudio(f.receiver.sessions[0]), expected);
      assertEquals([
        f.receiver.sessions.length,
        f.receiver.sessions[0].flushes,
        f.receiver.sessions[0].teardowns,
      ], [1, 0, 0]);
      assertEquals(f.stream.epoch, epoch);
      assertEquals(f.player.status().state, 'stop');
      for (const part of fed) await f.stream.ackCompletion(part.key);
      await libraryProof();
    } finally {
      await f.close();
    }
  });
}

for (const edit of ['remove', 'repeat'] as const) {
  test(`actual native ${edit} fences accepted future and renders the exact reanchored suffix`, async () => {
    const f = await native();
    try {
      const b = await f.next();
      const aBytes = await f.feed(f.primary, f.mapping, 44100, 100);
      const bBytes = await f.feed(b.source, b.mapping, 353, 12000);
      await f.playback.queueRemove(3);
      const epoch = f.stream.epoch;
      await f.start();
      await until(() =>
        !!f.receiver.sessions[0] &&
        renderScheduledAudio(f.receiver.sessions[0], f.receiver.nowMs()).pcm
            .length >= 4410 * 4
      );
      assertEquals(f.player.status().current?.id, f.primary.entryId);
      await (edit === 'remove'
        ? f.playback.queueRemove(b.source.entryId)
        : f.playback.setRepeat('single'));
      assertEquals(f.cutoffs.length, 1);
      const cutoff = f.cutoffs[0];
      assert(cutoff.progress);
      assert(
        cutoff.progress.sourceFrames > 0n &&
          cutoff.progress.sourceFrames < 44100n,
      );
      const bookmark = Number(cutoff.progress.sourceFrames * 1000n / 44100n);
      assertEquals(f.player.status().itemProgressMs, bookmark);
      assertEquals(f.player.status().state, 'play');
      assertEquals(f.player.status().current?.id, f.primary.entryId);
      assertEquals(f.stream.epoch, epoch + 1n);
      assert(b.source.signal.aborted && f.primary.signal.aborted);
      for (const old of [aBytes, bBytes]) {
        assertEquals(
          (await f.stream.waitCompletion(old.key)).status,
          'canceled',
        );
        await f.stream.ackCompletion(old.key);
      }
      if (edit === 'repeat') {
        await f.playback.setRepeat('off');
        await f.playback.queueRemove(b.source.entryId);
      }
      const source = f.playback.openSource(
        f.primary.entryId,
        f.player.status().generation,
      )!;
      assert(source);
      assertEquals(source.startMs, bookmark);
      const mapping = f.playback.bindSource(
        source,
        f.stream.id,
        f.stream.epoch,
      )!;
      assert(mapping);
      const resumed = await f.feed(source, mapping, 44100, 100);
      assertEquals(
        resumed.bytes,
        aBytes.bytes.subarray(Number(mapping.originFrame) * 4),
      );
      assert(f.playback.finishSources(source));
      assertEquals(
        (await f.stream.endStream(f.stream.epoch, resumed.marker.inputEnd))
          .status,
        'accepted',
      );
      const completion = await f.stream.waitCompletion(resumed.key);
      assertEquals(completion.status, 'complete');
      await until(() =>
        renderScheduledAudio(f.receiver.sessions[0], f.receiver.nowMs()).ranges
              .filter((range) => range.epoch === 2).reduce(
                (n, range) => n + range.frames,
                0,
              ) * 4 >= resumed.bytes.length
      );
      assertEquals(
        f.trace.scheduledRealAudio(
          f.receiver.sessions[0],
          f.receiver.nowMs(),
          1,
        ),
        resumed.bytes,
      );
      assertEquals(f.trace.realAudio(f.receiver.sessions[0], 1), resumed.bytes);
      // Deterministically replay old UDP arriving after RTSP FLUSH. Arrival
      // attribution must agree with the independently scheduled receiver, not
      // treat cross-socket callback order as an epoch identity.
      const session = f.receiver.sessions[0];
      const flush = session.wire.findIndex((event) => event.kind === 'flush');
      const old = session.wire.slice(0, flush).find((event) =>
        event.kind === 'audio'
      )!;
      assert(old?.kind === 'audio');
      const replay = {
        ...session,
        wire: [
          ...session.wire.slice(0, flush + 1),
          { ...old, atMs: session.wire[flush].atMs + 0.001 },
          ...session.wire.slice(flush + 1),
        ],
      };
      assertEquals(f.trace.realAudio(replay, 1), resumed.bytes);
      assertEquals(
        f.trace.scheduledRealAudio(replay, f.receiver.nowMs(), 1),
        resumed.bytes,
      );
      assertEquals([
        f.receiver.sessions.length,
        f.receiver.sessions[0].flushes,
        f.receiver.sessions[0].teardowns,
      ], [1, 1, 0]);
      await f.playback.completeSource(source, completion);
      assertEquals(f.player.status().state, 'stop');
      await f.stream.ackCompletion(resumed.key);
      await libraryProof();
    } finally {
      await f.close();
    }
  });
}
