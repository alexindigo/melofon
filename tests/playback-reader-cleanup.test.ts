import { assert, assertEquals, assertRejects } from '@std/assert';
import { createPlaybackReader } from '../src/playback-reader.ts';
import type { Playback } from '../src/playback.ts';
import type { PlaybackPcm } from '../src/playback-source.ts';
import type {
  TimelineCompletion,
  TimelineSource,
  TimelineWriter,
} from '../src/playback-timeline.ts';

Deno.test('reader rejection joins its outstanding completion ACK before settling', async () => {
  const controller = new AbortController();
  const source = {
    entryId: 1,
    generation: 1,
    startMs: 0,
    signal: controller.signal,
  };
  const mapping: TimelineSource = {
    streamId: 1n,
    epoch: 1n,
    source: 1n,
    entryId: 1,
    generation: 1,
    originMs: 0,
    originFrame: 0n,
  };
  const completion = Promise.withResolvers<TimelineCompletion>();
  const fault = new Error('decoder return fault');
  let emitted = false, failed = false, acknowledged = false, settled = false;
  const pcm: PlaybackPcm = {
    originFrame: 0n,
    acceptedFrames: 0n,
    eof: true,
    completion: Promise.resolve(),
    accept() {},
    [Symbol.asyncIterator]() {
      return this;
    },
    next() {
      if (emitted) return Promise.resolve({ done: true, value: undefined });
      emitted = true;
      return Promise.resolve({ done: false, value: new Uint8Array(4) });
    },
    return() {
      return Promise.reject(fault);
    },
  };
  const playback = {
    bindSource: () => mapping,
    sourcePlanView: () => ({ playing: source, reading: null }),
    prepareNextSource: () => null,
    beginSourceInput: () => () => {},
    sourceAccepted: () => true,
    sourceAudio() {},
    reportSourceOutcome: () => true,
    sealSource: () => true,
    cancelSource: () => controller.abort(),
  } as unknown as Playback;
  const sink: TimelineWriter = {
    metadata: () => Promise.resolve('accepted'),
    appendSource: () =>
      Promise.resolve({ acceptedFrames: 1n, status: 'accepted' }),
    seal: () => Promise.resolve({ status: 'accepted', inputEnd: 1n }),
    endStream: () => Promise.resolve({ status: 'accepted' }),
    waitDrain: () => Promise.resolve(),
    compatibilitySilence: () => Promise.resolve(),
    progress: () => Promise.resolve(null),
    waitCompletion: () => completion.promise,
    reviseCompletion: (key) => Promise.resolve(key),
    ackCompletion() {
      acknowledged = true;
      return Promise.resolve();
    },
  };
  const reader = createPlaybackReader({
    playback,
    sources: {
      open: () => Promise.resolve(pcm),
    },
    sink,
    streamId: 1n,
    epoch: 1n,
    initial: {
      source,
      entry: {
        id: 1,
        reference: { kind: 'url', url: 'http://media.home/source' },
        facts: {
          kind: 'web',
          url: 'http://media.home/source',
          title: null,
          artistName: null,
          mode: 'finite',
          durationMs: 1,
          seekable: true,
          streamTitle: null,
          streamUrl: null,
        },
      },
    },
    current: () => true,
    segment: () => 1n,
    mapping() {},
    admitted() {},
    transportFailed() {
      failed = true;
      controller.abort();
    },
    contentFailed() {
      controller.abort();
      throw fault;
    },
    retirementFailed(error) {
      throw error;
    },
    sourceCleanupFailed(_entry, error) {
      throw error;
    },
  });
  const result = reader.settled.finally(() => {
    settled = true;
  });
  void result.catch(() => {});
  try {
    const deadline = performance.now() + 1000;
    while (!failed) {
      assert(performance.now() < deadline, 'writer rejection was not observed');
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    assertEquals(
      settled,
      false,
      'writer rejection cannot abandon completion ownership',
    );
    completion.resolve({
      ...mapping,
      target: 1n,
      revision: 1n,
      status: 'canceled',
    });
    await assertRejects(() => result, Error, fault.message);
    assert(acknowledged);
  } finally {
    controller.abort();
    completion.resolve({
      ...mapping,
      target: 1n,
      revision: 1n,
      status: 'canceled',
    });
    await reader.close();
    await result.catch(() => {});
  }
});
