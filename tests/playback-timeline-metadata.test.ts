import { assert, assertEquals } from '@std/assert';
import { nativeHttpFixture } from './helpers/playback-native-http.ts';
import {
  concatenate,
  timelineControl,
  timelineLibraryProof,
  timelinePcm,
  timelineUntil,
} from './helpers/timeline-proof.ts';
import { renderScheduledAudio } from './helpers/raop-scheduled-consumer.ts';
import { icyBlock } from './helpers/http-radio.ts';

type Session = Awaited<
  ReturnType<typeof nativeHttpFixture>
>['receiver']['sessions'][number];
const decoder = new TextDecoder();
function dmap(body: Uint8Array) {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  assertEquals(decoder.decode(body.subarray(0, 4)), 'mlit');
  assertEquals(view.getUint32(4), body.length - 8);
  const tags = new Map<string, string>();
  for (let at = 8; at < body.length;) {
    const tag = decoder.decode(body.subarray(at, at + 4));
    const size = view.getUint32(at + 4);
    assert(!tags.has(tag) && at + 8 + size <= body.length);
    tags.set(tag, decoder.decode(body.subarray(at + 8, at + 8 + size)));
    at += 8 + size;
  }
  return tags;
}
function allText(session: Session) {
  return session.parameters.filter((p) =>
    p.contentType === 'application/x-dmap-tagged'
  ).map((p) => ({ ...p, tags: dmap(p.body), value: decoder.decode(p.body) }));
}
function text(session: Session) {
  // The startup snapshot carries album (even empty); the scheduled boundary
  // encoder still emits title/artist alone. A late-join replay of a boundary
  // can precede RTP too, so packet arrival time does not classify these.
  return allText(session).filter((p) => !p.tags.has('asal'));
}
function anchor(session: Session) {
  const event = session.wire.find((event) => event.kind === 'record');
  assert(event?.kind === 'record');
  return Number(/rtptime=(\d+)/.exec(event.rtpInfo)![1]);
}
function target(parameter: { rtpInfo?: string }) {
  assert(parameter.rtpInfo);
  return Number(/^rtptime=(\d+)$/.exec(parameter.rtpInfo)![1]);
}
function progressParameters(session: Session) {
  return session.parameters.map((p) => ({
    ...p,
    value: decoder.decode(p.body),
  }))
    .filter((p) => p.value.startsWith('progress:'));
}
function progresses(session: Session) {
  return progressParameters(session).filter((p) => !p.rtpInfo).map((p) =>
    p.value
  );
}
async function assertStartup(session: Session, title: string) {
  await timelineUntil(
    'first RTP after startup snapshot',
    () => session.firstRtpAtMs !== null,
  );
  const record = session.wire.find((event) => event.kind === 'record');
  assert(record?.kind === 'record');
  const snapshots = allText(session).filter((p) => p.tags.has('asal'));
  const initialProgress = progressParameters(session).filter((p) => p.rtpInfo);
  assertEquals(snapshots.length, 1, 'one startup DMAP per session');
  assertEquals(initialProgress.length, 1, 'one startup progress per session');
  const [snapshot] = snapshots, [progress] = initialProgress;
  assertEquals(snapshot.tags.get('minm'), title);
  assert(snapshot.tags.has('asar'));
  assertEquals(target(snapshot), anchor(session));
  assertEquals(target(progress), anchor(session));
  assert(record.atMs <= snapshot.atMs && snapshot.replyAtMs! <= progress.atMs);
  assert(progress.replyAtMs! <= session.firstRtpAtMs!);
}
function progressFrames(body: string) {
  const [, start, position] = /progress: (\d+)\/(\d+)\/(\d+)/.exec(body)!;
  return (Number(position) - Number(start) + 2 ** 32) % 2 ** 32;
}
function test(name: string, fn: () => Promise<void>) {
  Deno.test({
    name: `timeline metadata: ${name}`,
    sanitizeOps: false,
    sanitizeResources: false,
    fn,
  });
}

test('HTTP, OwnTone, WS and RTSP follow exact scheduled natural markers', async () => {
  const parts = [timelinePcm(4410 + 137), timelinePcm(44100 + 19, 2)];
  const f = await nativeHttpFixture({
    pcm: parts[0],
    additionalPcm: [parts[1]],
    titles: ['Marker A', 'Marker B'],
    metadata: true,
  });
  let socket: WebSocket | undefined;
  try {
    const c = await timelineControl(f);
    await c.add();
    const entries = f.playback.queueView().items;
    const events: Record<string, unknown>[] = [];
    socket = new WebSocket(
      `${f.fixture.origin.replace('http:', 'ws:')}/api/v1/events`,
      {
        headers: {
          Authorization: `Bearer ${c.credential}`,
          Origin: f.fixture.origin,
        },
      },
    );
    socket.onmessage = (event) => events.push(JSON.parse(String(event.data)));
    await timelineUntil(
      'WS hello',
      () => events.some((e) => e.type === 'hello'),
    );
    await c.command('play');
    await timelineUntil(
      'B sealed ahead',
      () => !!f.key && f.key.target === BigInt(parts[1].length / 4),
    );
    assertEquals((await c.current()).current.entryId, entries[0].id);
    assertEquals(
      text(f.receiver.sessions[0]),
      [],
      'read-ahead never publishes receiver metadata',
    );
    await timelineUntil(
      'B publicly scheduled',
      async () => (await c.current()).current?.entryId === entries[1].id,
    );
    assertEquals((await f.own('/player')).item_id, entries[1].id);
    assertEquals((await c.current()).current.song.title, 'Marker B');
    await timelineUntil(
      'B receiver marker',
      () =>
        text(f.receiver.sessions[0]).some((m) => m.value.includes('Marker B')),
    );
    const session = f.receiver.sessions[0], messages = text(session);
    const a = messages.find((m) => m.value.includes('Marker A'))!,
      b = messages.find((m) => m.value.includes('Marker B'))!;
    assertEquals(target(a), anchor(session));
    assertEquals(target(b), (anchor(session) + parts[0].length / 4) % 2 ** 32);
    const replay = renderScheduledAudio(session, f.receiver.nowMs());
    const bStart = replay.ranges.find((range) => range.timestamp >= target(b));
    assert(bStart && replay.clockUncertaintyMs !== null);
    assert(b.atMs >= bStart.atMs - replay.clockUncertaintyMs);
    assert(events.some((e) => e.type === 'changed' && e.events));
    await timelineUntil(
      'final scheduled media',
      () => f.playback.playerView().state === 'stop',
    );
    await assertStartup(session, 'Marker A');
    assertEquals(f.audio.realAudio(session), concatenate(parts));
    assertEquals(
      f.audio.scheduledRealAudio(session, f.receiver.nowMs()),
      concatenate(parts),
    );
    await timelineLibraryProof();
  } finally {
    socket?.close();
    await f.close();
  }
});

test('seek discards future metadata and binds commanded origin to a fresh RTP marker', async () => {
  const parts = [timelinePcm(88200 + 137), timelinePcm(44100, 2)];
  const f = await nativeHttpFixture({
    pcm: parts[0],
    additionalPcm: [parts[1]],
    titles: ['Seek A', 'Future B'],
    metadata: true,
  });
  try {
    const c = await timelineControl(f);
    await c.add();
    await c.command('play');
    await timelineUntil('future seal', () => !!f.key && f.key.source > 1n);
    await c.command('seek', { positionMs: 700 });
    await timelineUntil(
      'new epoch metadata',
      () =>
        text(f.receiver.sessions[0]).some((m) => m.value.includes('Seek A')),
    );
    const session = f.receiver.sessions[0];
    assertEquals(
      text(session).some((m) => m.value.includes('Future B')),
      false,
    );
    const flush = session.wire.find((e) => e.kind === 'flush');
    assert(flush?.kind === 'flush');
    assertEquals(
      target(text(session)[0]),
      Number(/rtptime=(\d+)/.exec(flush.rtpInfo)![1]),
    );
    assertEquals(progressFrames(progresses(session)[0]), 30870);
    assert((await c.current()).positionMs >= 700);
    await assertStartup(session, 'Seek A');
    await timelineLibraryProof();
  } finally {
    await f.close();
  }
});

test('repeat-single refreshes timed marker identity without resetting the session', async () => {
  const bytes = timelinePcm(4410);
  const f = await nativeHttpFixture({
    pcm: bytes,
    titles: ['Repeated source'],
    metadata: true,
  });
  try {
    const c = await timelineControl(f);
    await c.add();
    await c.modes({ repeat: 'single' });
    await c.command('play');
    const id = f.playback.queueView().items[0].id;
    await timelineUntil(
      'two repeated receiver markers',
      () =>
        !!f.receiver.sessions[0] && text(f.receiver.sessions[0]).length >= 2,
    );
    const messages = text(f.receiver.sessions[0]);
    assertEquals(
      (target(messages[1]) - target(messages[0]) + 2 ** 32) % 2 ** 32,
      bytes.length / 4,
    );
    assertEquals((await c.current()).current.entryId, id);
    assertEquals(f.receiver.sessions.length, 1);
    assertEquals(f.receiver.sessions[0].flushes, 0);
    await assertStartup(f.receiver.sessions[0], 'Repeated source');
    await timelineLibraryProof();
  } finally {
    await f.close();
  }
});

test('ICY uses observed decoded-frame boundaries rather than read-ahead time', async () => {
  const observed: { frame: bigint; title: string | null }[] = [];
  const held = Promise.withResolvers<void>();
  let sourceId: bigint | undefined;
  const f = await nativeHttpFixture({
    pcm: timelinePcm(88200 + 137),
    web: 'live',
    metadata: true,
    metadataObserved(metadata, frame) {
      if (metadata.streamTitle !== undefined) {
        observed.push({ frame, title: metadata.streamTitle });
      }
    },
    async append(request, append) {
      sourceId = request.source;
      return await append(request);
    },
    radioReply(wav) {
      const live = wav.slice();
      const header = new DataView(live.buffer);
      header.setUint32(4, 0xffffffff, true);
      header.setUint32(40, 0xffffffff, true);
      return {
        headers: { 'content-type': 'audio/wav', 'icy-metaint': '4096' },
        body: (async function* () {
          for (let at = 0; at < live.length; at += 4096) {
            const chunk = live.subarray(at, at + 4096);
            yield chunk;
            if (chunk.length === 4096) {
              yield icyBlock(
                `StreamTitle='Artist - ${
                  at < live.length / 2 ? 'Early' : 'Later'
                }';`,
              );
            }
          }
          await held.promise;
        })(),
      };
    },
  });
  try {
    const c = await timelineControl(f);
    await f.play();
    await timelineUntil(
      'observed metadata before playout',
      () => observed.length > 0 && sourceId !== undefined,
    );
    assertEquals((await c.current()).current.media.streamTitle, null);
    assertEquals(text(f.receiver.sessions[0]), []);
    assertEquals((await c.current()).current.playbackRate, 0);
    await timelineUntil(
      'scheduled broadcast title',
      async () =>
        (await c.current()).current?.media.streamTitle === 'Artist - Later',
    );
    const progress = await f.native.progress(f.native.epoch, sourceId!);
    assert(
      progress &&
        progress.sourceFrames >
          observed.find((m) => m.title === 'Artist - Later')!.frame,
    );
    assertEquals((await f.own('/queue')).items[0].album, 'Later');
    await timelineUntil(
      'scheduled ICY receiver title',
      () =>
        text(f.receiver.sessions[0]).some((m) =>
          m.value.includes('Artist - Later')
        ),
    );
    await assertStartup(f.receiver.sessions[0], '');
    await timelineLibraryProof();
  } finally {
    held.resolve();
    await f.close();
  }
});

test('late join receives current scheduled metadata instead of the read cursor', async () => {
  const parts = [timelinePcm(4410), timelinePcm(88200 + 19, 2)];
  const f = await nativeHttpFixture({
    pcm: parts[0],
    additionalPcm: [parts[1]],
    titles: ['Joined A', 'Joined B'],
    metadata: true,
    receiverCount: 2,
    receiverSelection: [true, false],
  });
  try {
    const c = await timelineControl(f);
    await c.add();
    await c.command('play');
    const bId = f.playback.queueView().items[1].id;
    await timelineUntil(
      'B scheduled',
      async () =>
        (await c.current()).current?.entryId === bId &&
        text(f.receiver.sessions[0]).some((p) => p.value.includes('Joined B')),
    );
    await f.own('/outputs/2', 'PUT', { selected: true });
    await timelineUntil(
      'joined metadata',
      () =>
        !!f.receivers[1].sessions[0] &&
        text(f.receivers[1].sessions[0]).length > 0,
    );
    const session = f.receivers[1].sessions[0];
    assert(text(session).every((p) => p.value.includes('Joined B')));
    assertEquals(
      target(text(session)[0]),
      (anchor(f.receiver.sessions[0]) + parts[0].length / 4) % 2 ** 32,
    );
    await assertStartup(f.receiver.sessions[0], 'Joined A');
    await assertStartup(session, 'Joined B');
    await timelineLibraryProof();
  } finally {
    await f.close();
  }
});

test('keepalive and OwnTone previous use frozen real-source progress during compatibility silence', async () => {
  const f = await nativeHttpFixture({
    pcm: timelinePcm(4410),
    additionalPcm: [timelinePcm(353, 2)],
    titles: ['Keepalive A', 'Keepalive B'],
    durations: [100, 60000],
    metadata: true,
  });
  try {
    const c = await timelineControl(f);
    await c.add();
    await c.command('play');
    const entries = f.playback.queueView().items;
    await timelineUntil(
      'B scheduled and frozen',
      async () =>
        (await c.current()).current?.entryId === entries[1].id &&
        (await c.current()).current.playbackRate === 0,
    );
    const session = f.receiver.sessions[0];
    await timelineUntil(
      'native keepalive progress',
      () => progresses(session).length >= 3,
      35000,
    );
    assertEquals(progressFrames(progresses(session).at(-1)!), 353);
    await assertStartup(session, 'Keepalive A');
    assertEquals((await c.current()).positionMs, 8);
    assertEquals((await f.own('/player')).item_progress_ms, 8);
    await f.own('/player/previous', 'PUT');
    assertEquals(
      (await c.current()).current.entryId,
      entries[0].id,
      'scheduled 8 ms stays below OwnTone previous 3000 ms',
    );
    await timelineLibraryProof();
  } finally {
    await f.close();
  }
});
