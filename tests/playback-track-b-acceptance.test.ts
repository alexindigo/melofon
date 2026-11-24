// Track B acceptance: cold plain non-loopback HTTP, actual household
// owners/decoder/shipping library, and independently scheduled ALAC receivers.
import { assert, assertEquals, assertRejects } from '@std/assert';
import {
  concurrentFixture,
  exact,
  until,
} from './helpers/concurrent-playback.ts';
import { crossfadeReference } from './helpers/crossfade-proof.ts';
import {
  decodeSourceReference,
  writeEncodedTone,
} from './helpers/encoded-playback-source.ts';
import { concatenate, timelineUntil } from './helpers/timeline-proof.ts';
import { renderScheduledAudio } from './helpers/raop-scheduled-consumer.ts';
import type { FakeRaopSession } from './helpers/fake-raop.ts';
import type { AirplayRangeSnapshot } from '../src/boots/airplay-profile.ts';
import type { CrossfadeRecord } from '../src/playback-mix.ts';
import { queueDuration } from '../src/queue-source.ts';

type Fixture = Awaited<ReturnType<typeof concurrentFixture>>;
function test(name: string, fn: () => Promise<void>) {
  Deno.test({
    name: `Track B acceptance: ${name}`,
    sanitizeOps: false,
    sanitizeResources: false,
    fn,
  });
}
async function requirePlainHttp(f: Fixture) {
  const ips = await Deno.resolveDns('melofon.home', 'A');
  assert(ips.length > 0 && ips.every((ip) => !ip.startsWith('127.')));
  assert(f.server.f.origin.startsWith('http://melofon.home:'));
}
async function start(f: Fixture) {
  await requirePlainHttp(f);
  const previous = f.receivers.map((r) => r.sessions.length);
  await Promise.all(
    [1, 2].map((id) => f.server.call(`/players/${id}/play`, 'POST', {})),
  );
  await until(() =>
    f.receivers.every((r, i) => r.sessions[previous[i]]?.audioPackets > 0)
  );
}
async function appendOther(f: Fixture, id: number) {
  const reference =
    f.players.get(id === 1 ? 2 : 1).queueView().items[0].reference;
  await f.server.call(`/players/${id}/queue/items`, 'POST', {
    references: [reference],
  });
}
function trace(f: Fixture, receiver: number) {
  const found = f.traces.findLast((t) =>
    t.ports.has(f.receivers[receiver].port)
  );
  assert(found, 'a real fixed-player native stream owns the receiver');
  return found;
}
async function stopped(f: Fixture) {
  await until(() =>
    [1, 2].every((id) => f.players.get(id).playerView().state === 'stop')
  );
}
function complete(
  f: Fixture,
  receiver: number,
  expected: Uint8Array,
  firstEpoch = 0,
) {
  const r = f.receivers[receiver], session = r.sessions.at(-1)!;
  const audio = trace(f, receiver).audio;
  exact(audio.realAudio(session, firstEpoch), expected);
  exact(audio.scheduledRealAudio(session, r.nowMs(), firstEpoch), expected);
  const replay = renderScheduledAudio(session, r.nowMs());
  assertEquals(replay.issues, []);
  return session;
}

test('A fans out a persisted natural fade while B stays gapless, through both final tails', async () => {
  const records: { playerId: number; frames: bigint }[] = [];
  const f = await concurrentFixture([22050 + 137, 22050 + 351], {
    crossfadeObserved(playerId, record) {
      records.push({ playerId, frames: record.appliedFrames });
    },
  });
  try {
    await f.initialize();
    await appendOther(f, 1);
    await appendOther(f, 2);
    await f.server.call('/players/1', 'PATCH', {
      crossfadeMs: 100,
      consume: true,
    });
    const current = [1, 2].map((id) =>
      f.players.get(id).queueView().items[0].id
    );
    await start(f);
    await until(() =>
      f.traces.length === 2 && f.traces.every((t) => t.seals.length === 2)
    );
    const reference = f.players.get(2).queueView().items[0].reference;
    assert(reference.kind === 'song');
    assertEquals(
      await f.server.call('/me/playback', 'POST', {
        songId: reference.id,
        run: 1,
        sequence: 0,
        state: 'playing',
        positionMs: 17,
      }),
      { accepted: true },
    );
    const rows: { kind: string; appPlayerId?: number }[] =
      (await f.server.call('/now-playing')).nowPlaying;
    assertEquals(rows.filter((r) => r.kind === 'server').length, 2);
    assertEquals(rows.filter((r) => r.kind === 'app').length, 1);
    assert(
      rows.filter((r) => r.kind === 'server').every((r) =>
        r.appPlayerId === undefined
      ),
    );
    for (const id of [1, 2]) {
      const { player } = await f.server.call(`/players/${id}`);
      assertEquals(
        player.current.entryId,
        current[id - 1],
        'read-ahead is not the playing cursor',
      );
    }
    await stopped(f);
    const a = crossfadeReference(f.waves.map((w) => w.subarray(44)), 4410).pcm;
    const b = concatenate([f.waves[1].subarray(44), f.waves[0].subarray(44)]);
    for (const [i, expected] of [[0, a], [1, a], [2, b]] as const) {
      const session = complete(f, i, expected);
      assertEquals(f.receivers[i].sessions.length, 1);
      assertEquals(
        session.flushes,
        0,
        'natural succession has no discontinuity',
      );
      let end = 0n;
      for (
        const range of trace(f, i).audio.epochs[0].ranges.filter((r) =>
          r.kind === 'real'
        )
      ) {
        assertEquals(range.transportStart, end, 'no inter-item silence');
        end += range.frames;
      }
      assertEquals(end, BigInt(expected.length / 4));
    }
    assertEquals(records, [{ playerId: 1, frames: 4410n }]);
    assertEquals(
      f.players.get(1).queueView().items,
      [],
      'consume commits both scheduled boundaries once',
    );
    assertEquals(f.players.get(2).queueView().items.length, 2);
    await f.persistence.drain();
    assertEquals(
      (await f.server.f.store.players.list()).map((p) => p.crossfadeMs),
      [100, 0],
    );
    await f.libraryProof();
  } finally {
    await f.close();
  }
});

test('long MP3 sources crossfade naturally with exact scheduled PCM through the final tail', async () => {
  const outgoingSeconds = 90, incomingSeconds = 60;
  const crossfadeMs = 100, overlap = Math.floor(crossfadeMs * 44100 / 1000);
  const fades: CrossfadeRecord[] = [];
  const f = await concurrentFixture(undefined, {
    async writeMedia(dir) {
      const a = `${dir}/A.mp3`, b = `${dir}/B.mp3`;
      // With no Xing/LAME trim metadata, the catalog and decoder both count
      // the encoded padding. Row 21 forbids fading across compatibility silence.
      await writeEncodedTone(a, 'mp3-no-xing', outgoingSeconds, 440);
      await writeEncodedTone(b, 'mp3-no-xing', incomingSeconds, 660);
      return [a, b];
    },
    crossfadeObserved(playerId, record) {
      if (playerId === 1) fades.push(record);
    },
  });
  try {
    const parts = [];
    for (const [i, path] of f.paths.entries()) {
      const { pcm, chunkFrames } = await decodeSourceReference(path);
      assert(
        chunkFrames.filter((n) => n === 1152).length >=
          Math.floor([outgoingSeconds, incomingSeconds][i] * 44100 / 1152),
        'each MP3 decodes to thousands of real 1152-frame chunks',
      );
      parts.push(pcm);
    }
    const expected = crossfadeReference(parts, overlap).pcm;
    await f.initialize();
    await requirePlainHttp(f);
    await appendOther(f, 1);
    await f.server.call('/players/1', 'PATCH', { crossfadeMs });
    const player = f.players.get(1);
    const entries = player.queueView().items;
    const [outgoingEntryId, incomingEntryId] = entries.map((e) => e.id);
    assertEquals(
      entries.map(queueDuration),
      parts.map((pcm) => Math.round(pcm.length / 4 * 1000 / 44100)),
      'catalog duration matches decoded PCM: no compatibility silence',
    );
    await f.server.call('/players/1/play', 'POST', {});
    await timelineUntil(
      'long source renders past 256 MP3 chunks',
      () => player.playerView().itemProgressMs >= 10000,
    );
    await timelineUntil(
      'natural MP3 succession',
      () => player.sourcePlanView().playing?.entryId === incomingEntryId,
      outgoingSeconds * 1000 + 10000,
    );
    await timelineUntil(
      'successor renders past 256 MP3 chunks',
      () => player.playerView().itemProgressMs >= 10000,
    );
    await timelineUntil(
      'both long sources stop naturally',
      () => player.playerView().state === 'stop',
      incomingSeconds * 1000 + 10000,
    );

    assertEquals(fades, [{
      outgoingEntryId,
      incomingEntryId,
      requestedFrames: BigInt(overlap),
      appliedFrames: BigInt(overlap),
      reason: 'applied',
    }]);
    const a = trace(f, 0);
    assertEquals(a.audio.epochs.length, 1);
    assertEquals(a.seals.length, 2);
    assert(a.completions.every((r) => r.status === 'complete'));
    // Reader and publication observers can receive the same native receipt.
    const completed = new Map(a.completions.map((r) => [r.source, r]));
    assertEquals(completed.size, 2);
    for (const [i, seal] of a.seals.entries()) {
      const receipt = completed.get(seal.source);
      assert(receipt, `source ${i + 1} has a native completion receipt`);
      // The incoming head was already submitted as part of A's mixed tail.
      const ownFrames = parts[i].length / 4 - (i === 1 ? overlap : 0);
      assertEquals(receipt.target, BigInt(ownFrames));
    }
    let end = 0n;
    for (const range of a.audio.epochs[0].ranges) {
      if (range.kind !== 'real') continue;
      assertEquals(range.transportStart, end, 'no inter-source silence');
      end += range.frames;
    }
    assertEquals(end, BigInt(expected.length / 4), 'complete real final tail');
    const r = f.receivers[0];
    assertEquals(r.sessions.length, 1);
    const session = r.sessions[0];
    assertEquals(session.flushes, 0);
    exact(a.audio.scheduledRealAudio(session, r.nowMs()), expected);
    await f.libraryProof();
  } finally {
    await f.close();
  }
});

test('manual Next discards an accepted overlap without fading or losing the replacement prefix or B', async () => {
  const f = await concurrentFixture([44100 + 353, 44100 * 5 + 351]);
  try {
    await f.initialize();
    await appendOther(f, 1);
    await f.server.call('/players/1', 'PATCH', { crossfadeMs: 100 });
    await start(f);
    await until(() =>
      trace(f, 0).seals.length >= 1 &&
      f.receivers[2].sessions[0]?.audioPackets > 0
    );
    const a = trace(f, 0), b = trace(f, 2), epoch = b.native.epoch;
    await until(async () =>
      (await a.native.source(a.native.epoch, 2n))?.acceptedFrames! > 0n
    );
    const replacement = f.players.get(1).queueView().items[1].id;
    await f.server.call('/players/1/next', 'POST', {});
    assertEquals(
      (await f.server.call('/players/1')).player.current.entryId,
      replacement,
    );
    assertEquals(b.native.epoch, epoch);
    await stopped(f);
    for (const i of [0, 1]) {
      const session = complete(f, i, f.waves[1].subarray(44), 1);
      assertEquals(session.flushes, 1);
    }
    complete(f, 2, f.waves[1].subarray(44));
    assertEquals(f.receivers[2].sessions.length, 1);
    assertEquals(f.receivers[2].sessions[0].flushes, 0);
    await f.libraryProof();
  } finally {
    await f.close();
  }
});

test('Stop saves actual native cutoffs and a cold graph restores independent exact origins with crossfade retained', async () => {
  const f = await concurrentFixture([44100 * 3 + 353, 44100 * 4 + 351]);
  try {
    await f.initialize();
    await appendOther(f, 1);
    await f.server.call('/players/1', 'PATCH', { crossfadeMs: 100 });
    await start(f);
    await until(() =>
      [1, 2].every((id) => f.players.get(id).playerView().itemProgressMs > 200)
    );
    const old = [trace(f, 0), trace(f, 2)];
    const bookmarks: number[] = [];
    for (const id of [1, 2]) {
      await f.server.call(`/players/${id}/stop`, 'POST', {});
      await until(() => old[id - 1].cutoffs.length > 0);
      const cutoff = old[id - 1].cutoffs.at(-1)!;
      assert(cutoff.progress && cutoff.progress.sourceFrames > 0n);
      const expected = Math.floor(
        Number(cutoff.progress.sourceFrames) * 1000 / 44100,
      );
      const { player } = await f.server.call(`/players/${id}`);
      assertEquals([player.state, player.positionMs], ['pause', expected]);
      bookmarks.push(expected);
    }
    await f.persistence.drain();
    for (const id of [1, 2]) {
      assertEquals(
        (await f.server.f.store.playback.loadPlayerState(id))!.positionMs,
        bookmarks[id - 1],
      );
    }
    await f.restart();
    for (const id of [1, 2]) {
      const { player } = await f.server.call(`/players/${id}`);
      assertEquals([player.state, player.positionMs, player.crossfadeMs], [
        'pause',
        bookmarks[id - 1],
        id === 1 ? 100 : 0,
      ]);
    }
    await start(f);
    await stopped(f);
    for (const i of [0, 1, 2]) {
      const id = i === 2 ? 2 : 1;
      const resumed = f.waves[id - 1].subarray(
        44 + Math.round(bookmarks[id - 1] * 44100 / 1000) * 4,
      );
      complete(
        f,
        i,
        id === 1
          ? crossfadeReference([resumed, f.waves[1].subarray(44)], 4410).pcm
          : resumed,
      );
      assertEquals(
        f.receivers[i].sessions.length,
        2,
        'new graph has a fresh native session',
      );
    }
    await f.libraryProof();
  } finally {
    await f.close();
  }
});

// Match the joined receiver's RTP coordinate against every declared native
// range. This proves the suffix and zeros, never an arbitrary allowed tail.
function suffix(
  original: FakeRaopSession,
  joined: FakeRaopSession,
  ranges: readonly AirplayRangeSnapshot[],
  expected: Uint8Array,
  now: number,
) {
  const record = original.wire.find((e) => e.kind === 'record');
  assert(record?.kind === 'record');
  const anchor = Number(/rtptime=(\d+)/.exec(record.rtpInfo)![1]);
  const replay = renderScheduledAudio(joined, now);
  assertEquals(replay.issues, []);
  let first: number | undefined, next = 0;
  for (const packet of replay.ranges) {
    const offset = (packet.timestamp - anchor + 2 ** 32) % 2 ** 32;
    const bytes = new Uint8Array(packet.pcm.length),
      coverage = new Uint8Array(packet.frames);
    for (const range of ranges) {
      const start = Number(range.transportStart),
        end = start + Number(range.frames);
      const low = Math.max(start, offset),
        high = Math.min(end, offset + packet.frames);
      if (high <= low) continue;
      assert(
        coverage.subarray(low - offset, high - offset).every((v) => v === 0),
      );
      coverage.fill(1, low - offset, high - offset);
      if (range.kind !== 'real') continue;
      const source = Number(range.sourceOffset) + low - start;
      if (first === undefined) first = next = source;
      assertEquals(
        source,
        next,
        'no missing or duplicated joined source frame',
      );
      next += high - low;
      bytes.set(expected.subarray(source * 4, next * 4), (low - offset) * 4);
    }
    assert(
      coverage.every((v) => v === 1),
      'every extra frame is declared zero silence',
    );
    exact(packet.pcm, bytes);
  }
  assert(
    first !== undefined && first > 0,
    'joined stream cannot claim its missed prefix',
  );
  assertEquals(
    next,
    expected.length / 4,
    'joined stream renders its exact final tail',
  );
}

test('transfer during accepted crossfade preserves healthy A mix and the independent B suffix', async () => {
  const f = await concurrentFixture([44100 + 353, 44100 * 6 + 351]);
  const release = Promise.withResolvers<void>();
  try {
    await f.initialize();
    await appendOther(f, 1);
    await f.server.call('/players/1', 'PATCH', { crossfadeMs: 100 });
    await start(f);
    await until(() => f.players.get(1).playerView().itemProgressMs > 100);
    const a = trace(f, 1), b = trace(f, 2), epoch = b.native.epoch;
    await until(async () =>
      (await a.native.source(a.native.epoch, 2n))?.acceptedFrames! > 0n
    );
    const old = f.receivers[0].sessions[0], peer = f.receivers[2].sessions[0];
    const held = { wait: release.promise, entered: false };
    f.closeGates.set(f.receivers[0].port, held);
    await f.server.call('/players/2/speakers/1', 'PUT', {});
    await until(() => held.entered);
    assert(old.closedAtMs !== null);
    assertEquals(
      f.receivers[0].sessions.length,
      1,
      'replacement waits for proven old release',
    );
    const packets = peer.audioPackets;
    await until(() => peer.audioPackets > packets);
    assertEquals(f.receivers[0].sessions.length, 1);
    release.resolve();
    await until(() => f.receivers[0].sessions[1]?.audioPackets > 0);
    assertEquals(b.native.epoch, epoch);
    await stopped(f);
    complete(
      f,
      1,
      crossfadeReference(f.waves.map((w) => w.subarray(44)), 4410).pcm,
    );
    complete(f, 2, f.waves[1].subarray(44));
    const joined = f.receivers[0].sessions[1];
    suffix(
      peer,
      joined,
      b.audio.epochs[0].ranges,
      f.waves[1].subarray(44),
      f.receivers[0].nowMs(),
    );
    const metadata = joined.parameters.filter((p) =>
      p.contentType === 'application/x-dmap-tagged'
    ).map((p) => new TextDecoder().decode(p.body));
    assert(
      metadata.some((v) => v.includes('Player B')) &&
        metadata.every((v) => !v.includes('Player A')),
    );
    assertEquals(f.receivers[1].sessions.length, 1);
    assertEquals(f.receivers[1].sessions[0].flushes, 0);
    assertEquals(peer.flushes, 0);
    await f.libraryProof();
  } finally {
    release.resolve();
    await f.close();
  }
});

test('speculative failure never turns healthy A tail into a fade or disturbs B', async () => {
  let failed = false;
  const f = await concurrentFixture([44100 + 353, 44100 * 4 + 351], {
    decodePcm(id, path, _options, decode) {
      if (id === 1 && path.endsWith('B.wav')) {
        failed = true;
        return Promise.reject(
          new Error('acceptance speculative decoder failure'),
        );
      }
      return decode();
    },
  });
  try {
    await f.initialize();
    await appendOther(f, 1);
    await f.server.call('/players/1', 'PATCH', {
      crossfadeMs: 100,
      consume: true,
    });
    const entries = f.players.get(1).queueView().items.map((e) => e.id);
    await start(f);
    await until(() => failed);
    assertEquals(
      (await f.server.call('/players/1')).player.current.entryId,
      entries[0],
    );
    await until(() => f.players.get(1).playerView().state === 'pause');
    assertEquals(
      f.players.get(1).queueView().items.map((e) => e.id),
      entries.slice(1),
    );
    assertEquals((await f.server.call('/players/1')).player.positionMs, 0);
    for (const i of [0, 1]) complete(f, i, f.waves[0].subarray(44));
    assertEquals((await f.server.call('/players/2')).player.state, 'play');
    await until(() => f.players.get(2).playerView().state === 'stop');
    complete(f, 2, f.waves[1].subarray(44));
    assertEquals(f.receivers[2].sessions.length, 1);
    assertEquals(f.receivers[2].sessions[0].flushes, 0);
    await f.libraryProof();
  } finally {
    await f.close();
  }
});

test('a failed receiver during crossfade cannot truncate the healthy peer or independent B', async () => {
  const f = await concurrentFixture([44100 + 353, 44100 * 3 + 351]);
  try {
    await f.initialize();
    await appendOther(f, 1);
    await f.server.call('/players/1', 'PATCH', { crossfadeMs: 100 });
    await start(f);
    const a = trace(f, 1), b = trace(f, 2), epoch = b.native.epoch;
    await until(async () =>
      (await a.native.source(a.native.epoch, 2n))?.acceptedFrames! > 0n
    );
    await until(() => f.players.get(1).playerView().itemProgressMs > 100);
    f.receivers[0].close();
    await stopped(f);
    complete(
      f,
      1,
      crossfadeReference(f.waves.map((w) => w.subarray(44)), 4410).pcm,
    );
    complete(f, 2, f.waves[1].subarray(44));
    assertEquals(b.native.epoch, epoch);
    assertEquals(f.receivers[1].sessions.length, 1);
    assertEquals(f.receivers[2].sessions.length, 1);
    assert(
      a.completions.some((c) =>
        c.status === 'complete' &&
        c.attachments.some((p) => p.excluded && p.outcome === 'failed')
      ),
      'failed attachment is explicitly excluded, not credited successful',
    );
    await f.libraryProof();
  } finally {
    await f.close();
  }
});

for (const rejectCleanup of [false, true]) {
  test(`shutdown joins pending read-ahead before store close${rejectCleanup ? ' and reports failed release' : ''}`, async () => {
    const release = Promise.withResolvers<void>();
    let entered = false, aborted = false, settled = false, storeClosed = false;
    const f = await concurrentFixture([44100 * 4 + 353, 44100 * 6 + 351], {
      async decodePcm(id, path, options, decode) {
        if (id !== 1 || !path.endsWith('B.wav')) return decode();
        entered = true;
        const signal = options?.signal;
        assert(signal);
        await new Promise<void>((resolve) => {
          const abort = () => {
            aborted = true;
            resolve();
          };
          if (signal.aborted) abort();
          else signal.addEventListener('abort', abort, { once: true });
        });
        await release.promise;
        settled = true;
        signal.throwIfAborted();
        return decode();
      },
      async closeStream(close) {
        await close();
        if (rejectCleanup) throw new Error('acceptance close receipt failed');
      },
    });
    let closing: ReturnType<Fixture['server']['close']> | undefined;
    try {
      await f.initialize();
      await appendOther(f, 1);
      await f.server.call('/players/1', 'PATCH', { crossfadeMs: 100 });
      await start(f);
      await until(() =>
        entered && f.receivers.every((r) => r.sessions[0]?.audioPackets > 0)
      );
      const storeClose = f.server.f.store.close;
      f.server.f.store.close = async () => {
        try {
          assert(
            settled,
            'C1 successor acquisition must join before store close',
          );
        } finally {
          storeClosed = true;
          await storeClose();
        }
      };
      await f.libraryProof();
      closing = f.server.close();
      // Observe the rejection immediately, but assert it below only after joining.
      void closing.catch(() => {});
      await until(() => aborted);
      assertEquals([settled, storeClosed], [false, false]);
      release.resolve();
      if (rejectCleanup) {
        const error = await assertRejects(
          () => closing!,
          AggregateError,
          'Concurrent household fixture release failed',
        );
        const messages = (error: unknown): string =>
          error instanceof AggregateError
            ? error.errors.map(messages).join(' ')
            : error instanceof Error
            ? `${error.message} ${messages(error.cause)}`
            : '';
        assert(messages(error).includes('acceptance close receipt failed'));
      } else await closing;
      assertEquals([settled, storeClosed], [true, true]);
      assert(
        f.receivers.every((r) =>
          r.sessions.every((s) => s.closedAtMs !== null)
        ),
      );
      assert(
        f.traces.every((t) =>
          t.completions.every((c) => c.status !== 'complete')
        ),
        'shutdown cannot invent natural completion',
      );
    } finally {
      release.resolve();
      if (closing) {
        await closing.catch(() => {}); // the expected outcome was asserted above
        for (const r of f.receivers) r.close();
        await Deno.remove(f.dir, { recursive: true });
      } else await f.close();
    }
  });
}
