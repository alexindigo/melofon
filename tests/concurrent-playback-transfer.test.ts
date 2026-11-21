import { assert, assertEquals, assertRejects } from '@std/assert';
import {
  concurrentFixture,
  exact,
  until,
} from './helpers/concurrent-playback.ts';
import { renderScheduledAudio } from './helpers/raop-scheduled-consumer.ts';
import type { FakeRaopSession } from './helpers/fake-raop.ts';
import type { AirplayRangeSnapshot } from '../src/boots/airplay-profile.ts';
import { faultChild } from './helpers/raop-isolation.ts';

function test(name: string, fn: () => Promise<void>) {
  Deno.test({
    name: `concurrent transfer: ${name}`,
    sanitizeOps: false,
    sanitizeResources: false,
    fn,
  });
}

/** Locate the join in the original stream's RTP coordinate, then account for
 * every scheduled frame against real-source or explicit zero transport ranges. */
function scheduledSuffix(
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
    const bytes = new Uint8Array(packet.pcm.length);
    const coverage = new Uint8Array(packet.frames);
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
      const sourceOffset = Number(range.sourceOffset) + low - start;
      if (first === undefined) first = next = sourceOffset;
      assertEquals(
        sourceOffset,
        next,
        'joined source suffix has no hole or repeated prefix',
      );
      next += high - low;
      bytes.set(
        expected.subarray(sourceOffset * 4, next * 4),
        (low - offset) * 4,
      );
    }
    assert(
      coverage.every((v) => v === 1),
      'every received frame has a declared native range',
    );
    exact(packet.pcm, bytes);
  }
  assert(
    first !== undefined && first > 0,
    'late join never claims the missed prefix',
  );
  const joinedRecord = joined.wire.find((event) => event.kind === 'record');
  assert(joinedRecord?.kind === 'record');
  const transportStart =
    (Number(/rtptime=(\d+)/.exec(joinedRecord.rtpInfo)![1]) - anchor +
      2 ** 32) % 2 ** 32;
  const firstRange = ranges.find((range) =>
    range.kind === 'real' &&
    range.transportStart + range.frames > BigInt(transportStart)
  );
  assert(firstRange);
  assertEquals(
    first,
    Number(firstRange.sourceOffset) +
      Math.max(0, transportStart - Number(firstRange.transportStart)),
    'the complete real suffix starts at the receiver RECORD anchor',
  );
  assertEquals(
    next,
    expected.length / 4,
    'the complete remaining real suffix renders',
  );
}

for (const sealed of [false, true]) {
  test(`${sealed ? 'sealed' : 'unsealed'} A -> B transfer joins only B suffix after proven old release`, async () => {
    const f = await concurrentFixture(
      sealed ? undefined : [44100 * 6 + 353, 44100 * 8 + 351],
    );
    const release = Promise.withResolvers<void>();
    try {
      await f.initialize();
      const batches: Parameters<
        typeof f.server.f.store.players.saveChanges
      >[0][] = [];
      const save = f.server.f.store.players.saveChanges;
      f.server.f.store.players.saveChanges = async (batch) => {
        batches.push(structuredClone(batch));
        await save(batch);
      };
      await Promise.all(
        [1, 2].map((id) => f.server.call(`/players/${id}/play`, 'POST', {})),
      );
      await until(() =>
        f.receivers.every((r) => (r.sessions[0]?.audioPackets ?? 0) >= 50)
      );
      // Cached, not-yet-presented audio is recoverable at RECORD. Exercise an
      // actually missed prefix, not just a later local packet submission.
      await until(() =>
        [1, 2].every((id) => f.players.get(id).playerView().itemProgressMs > 0)
      );
      const a = f.traces.find((t) => t.ports.has(f.receivers[1].port))!;
      const b = f.traces.find((t) => t.ports.has(f.receivers[2].port))!;
      assertEquals(a.seals.length > 0, sealed);
      assertEquals(b.seals.length > 0, sealed);
      const epoch = b.native.epoch, id = b.native.id;
      const current =
        (await f.server.call('/players/2')).player.current.entryId;
      const old = f.receivers[0].sessions[0], peer = f.receivers[2].sessions[0];
      const held = { wait: release.promise, entered: false };
      f.closeGates.set(f.receivers[0].port, held);
      await f.server.call('/players/2/speakers/1', 'PUT', {});
      await until(() => held.entered && old.closedAtMs !== null);
      assert(
        old.closedAtMs !== null,
        'real native receiver close has completed',
      );
      assertEquals(
        f.receivers[0].sessions.length,
        1,
        'replacement cannot bypass the release receipt',
      );
      const packets = peer.audioPackets;
      await until(() => peer.audioPackets > packets);
      assertEquals(f.receivers[0].sessions.length, 1);
      release.resolve();
      await until(() =>
        f.receivers[0].sessions.length === 2 &&
        f.receivers[0].sessions[1].audioPackets > 0
      );
      const joined = f.receivers[0].sessions[1];
      const record = joined.wire.find((e) => e.kind === 'record');
      assert(record && record.atMs >= old.closedAtMs!);
      assertEquals([b.native.id, b.native.epoch], [id, epoch]);
      assertEquals(
        (await f.server.call('/players/2')).player.current.entryId,
        current,
      );
      assertEquals([peer.flushes, peer.teardowns, peer.closedAtMs], [
        0,
        0,
        null,
      ]);
      const levels = async (wanted: number[]) => {
        await until(() =>
          [joined, f.receivers[1].sessions[0], peer].every((s, i) => {
            const text = s.volumeParams.at(-1);
            return text !== undefined &&
              Math.abs(Number(text.split(':')[1]) - (wanted[i] * 0.3 - 30)) <
                0.001;
          })
        );
      };
      await levels([80, 80, 80]);
      await f.server.call('/players/2/volume', 'PUT', { volume: 60 });
      await levels([90, 80, 90]);
      await f.server.call('/players/2/speakers/1', 'PATCH', { linked: false });
      await f.server.call('/players/2/volume', 'PUT', { volume: 50 });
      await levels([90, 80, 80]);
      await f.persistence.drain();
      assertEquals(
        (await f.server.f.store.speakers.loadMemberships()).map((
          r,
        ) => [r.speakerId, r.playerId]),
        [['1', 2], ['2', 1], ['3', 2]],
      );
      assert(
        batches.some((batch) =>
          batch.outputs?.some((row) => row.id === '1' && row.playerId === 2) &&
          [1, 2].every((id) =>
            batch.players?.some((row) => row.playerId === id)
          )
        ),
        'membership and both player checkpoints share an atomic save batch',
      );
      assert(
        batches.some((batch) =>
          batch.players?.some((row) =>
            row.playerId === 2 && row.volume === 60
          ) && ['1', '3'].every((id) =>
            batch.outputs?.some((row) =>
              row.id === id && row.volume === 90
            )
          )
        ),
        'linked volume and physical levels share an atomic save batch',
      );
      await until(() =>
        [1, 2].every((id) => f.players.get(id).playerView().state === 'stop')
      );
      exact(
        a.audio.scheduledRealAudio(
          f.receivers[1].sessions[0],
          f.receivers[1].nowMs(),
        ),
        f.waves[0].subarray(44),
      );
      exact(
        b.audio.scheduledRealAudio(peer, f.receivers[2].nowMs()),
        f.waves[1].subarray(44),
      );
      scheduledSuffix(
        peer,
        joined,
        b.audio.epochs[0].ranges,
        f.waves[1].subarray(44),
        f.receivers[0].nowMs(),
      );
      const complete = a.completions.findLast((c) => c.status === 'complete')!;
      assertEquals(complete.required, 1n);
      assertEquals(
        complete.attachments.filter((p) => !p.excluded).map((p) => p.outcome),
        ['complete'],
      );
      if (sealed) {
        assert(
          complete.attachments.some((p) =>
            p.excluded && p.outcome === 'withdrawn'
          ),
        );
      }
      const metadata = joined.parameters.filter((p) =>
        p.contentType === 'application/x-dmap-tagged'
      ).map((p) => new TextDecoder().decode(p.body));
      assert(
        metadata.some((v) => v.includes('Player B')) &&
          metadata.every((v) => !v.includes('Player A')),
      );
      await f.libraryProof();
    } finally {
      release.resolve();
      await f.close();
    }
  });
}

function causes(error: unknown): string {
  return error instanceof AggregateError
    ? `${error.message} ${error.errors.map(causes).join(' ')}`
    : error instanceof Error
    ? `${error.message} ${causes(error.cause)}`
    : '';
}
const failedFree =
  'failed native A free fences its stream/receiver while B renders its full schedule';
test(failedFree, async () => {
  if (
    await faultChild(
      `concurrent transfer: ${failedFree}`,
      new URL(import.meta.url).pathname,
    )
  ) return;
  const f = await concurrentFixture([44100 * 5 + 353, 44100 * 8 + 351]);
  let armed = false;
  try {
    await f.initialize();
    await Promise.all(
      [1, 2].map((id) => f.server.call(`/players/${id}/play`, 'POST', {})),
    );
    await until(() =>
      f.receivers.every((r) => (r.sessions[0]?.audioPackets ?? 0) >= 20)
    );
    const b = f.traces.find((t) => t.ports.has(f.receivers[2].port))!;
    const epoch = b.native.epoch, session = f.receivers[2].sessions[0];
    await Deno.writeTextFile(
      Deno.env.get('RAOP_FI_FREE_ALLOC_ARM_FILE')!,
      'arm',
    );
    armed = true;
    await f.server.call('/players/1/stop', 'POST', {});
    await until(() =>
      ['1', '2'].some((id) =>
        f.devices.describe(id).session?.connection === 'failed'
      )
    );
    const failed = ['1', '2'].find((id) =>
      f.devices.describe(id).session?.connection === 'failed'
    )!;
    const receiver = f.receivers[Number(failed) - 1],
      sessions = receiver.sessions.length;
    assertEquals((await f.server.call('/players/1')).player.state, 'pause');
    await assertRejects(
      () => f.boots.get(1)!.close(),
      AggregateError,
      'stream release failed',
    );
    await f.server.call(`/players/2/speakers/${failed}`, 'PUT', {});
    await until(() =>
      f.devices.describe(failed).session?.connection === 'failed'
    );
    assertEquals(
      receiver.sessions.length,
      sessions,
      'failed old release cannot admit a replacement',
    );
    assertEquals(b.native.epoch, epoch);
    assertEquals([session.flushes, session.teardowns, session.closedAtMs], [
      0,
      0,
      null,
    ]);
    assertEquals((await f.server.call('/players/2')).player.state, 'play');
    await until(() => f.players.get(2).playerView().state === 'stop');
    exact(
      b.audio.scheduledRealAudio(session, f.receivers[2].nowMs()),
      f.waves[1].subarray(44),
    );
    assertEquals(receiver.sessions.length, sessions);
    await f.libraryProof();
  } finally {
    if (armed) {
      const error = await assertRejects(
        () => f.close(),
        AggregateError,
        'Concurrent household fixture release failed',
      );
      assert(
        causes(error).includes('raop_free failed: native cleanup not proven'),
        'the real shipping free failure remains quarantined',
      );
    } else await f.close();
    // Quarantined native storage is never retried/reset; only this test child exits.
  }
});
