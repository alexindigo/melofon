// Core and real lazy device owner -> shipping native timeline -> independent
// scheduled UDP/ALAC consumer, including public position and command bookmarks.
import { assert, assertEquals, assertRejects, assertThrows } from '@std/assert';
import { createPlaybackTimeline } from '../src/playback-timeline.ts';
import { createAirplayDevices } from '../src/boots/airplay-device.ts';
import { createFfiStream, raopFfiInternals } from '../src/boots/raop-ffi.ts';
import type {
  AirplayCompletionKey,
  AirplaySourceCutoff,
  AirplayTimelineStream,
  AirplayTransport,
} from '../src/boots/airplay-profile.ts';
import { createOutputs } from '../src/player.ts';
import { startFakeRaop } from './helpers/fake-raop.ts';
import { renderScheduledAudio } from './helpers/raop-scheduled-consumer.ts';
import { nativeHttpFixture } from './helpers/playback-native-http.ts';

const sleep = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(
  what: string,
  predicate: () => boolean | Promise<boolean>,
) {
  const deadline = performance.now() + 15000;
  while (!await predicate()) {
    if (performance.now() > deadline) throw new Error(`timed out: ${what}`);
    await sleep();
  }
}
function pcm(frames: number, seed = 1) {
  const bytes = new Uint8Array(frames * 4), view = new DataView(bytes.buffer);
  for (let i = 0; i < frames; i++) {
    view.setInt16(i * 4, 500 + (i * 17 + seed) % 11000, true);
    view.setInt16(i * 4 + 2, -600 - (i * 19 + seed) % 12000, true);
  }
  return bytes;
}
function test(name: string, fn: () => Promise<void> | void) {
  Deno.test({
    name: `playback native position: ${name}`,
    sanitizeOps: false,
    sanitizeResources: false,
    fn,
  });
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
    `position native library: ${path} sha256=${
      Array.from(digest, (v) => v.toString(16).padStart(2, '0')).join('')
    }`,
  );
}
async function fixture(
  options: Parameters<typeof startFakeRaop>[0] = {},
  peers = 1,
) {
  const receivers = await Promise.all(
    Array.from(
      { length: peers },
      () =>
        startFakeRaop({ captureAudio: true, captureWire: true, ...options }),
    ),
  );
  const outputs = createOutputs();
  for (const [i, receiver] of receivers.entries()) {
    outputs.register({
      id: String(i + 1),
      name: `Position ${i + 1}`,
      type: 'AirPlay',
      host: '127.0.0.1',
      port: receiver.port,
      selected: true,
      volume: 50,
    });
  }
  let native: AirplayTimelineStream | undefined;
  let allocations = 0;
  const devices = createAirplayDevices({
    outputs,
    stream() {
      allocations++;
      return native = createFfiStream();
    },
    resolver: {
      resolve(_host, port) {
        const i = receivers.findIndex((r) => r.port === port);
        return Promise.resolve({
          name: `00112233440${i}@Position._raop._tcp.local`,
          host: 'fixture.local',
          address: '127.0.0.1',
          port: port!,
          ttlMs: 60000,
          txt: { tp: 'UDP', am: 'AppleTV2,1' },
        });
      },
      close() {},
    },
  });
  const stream = devices.createStream();
  const activate = async (i = 0, expectConnected = true) => {
    const prepared = await devices.protocol.prepare({
      id: String(i + 1),
      stream,
      targetRevision: devices.admission.describe(String(i + 1)).targetRevision,
      signal: new AbortController().signal,
      isCurrent: () => true,
    });
    assert(prepared.ok, prepared.ok ? '' : prepared.error.message);
    let state = '';
    const result = await devices.protocol.activate(prepared.value, {
      volume: 50,
      positionMs: 0,
      lengthMs: 10000,
      title: '',
      artist: '',
    }, {
      publish() {},
      onEvent(event) {
        if (event.event === 'state') state = event.value ?? '';
      },
    });
    assert(result.ok, result.ok ? '' : result.error.message);
    await until(
      'native attachment outcome',
      () => expectConnected ? state === 'connected' : state === 'failed',
    );
    return result.value;
  };
  return {
    stream,
    devices,
    receivers,
    activate,
    get native() {
      assert(native);
      return native;
    },
    get allocations() {
      return allocations;
    },
    async close() {
      await stream.close();
      devices.close();
      receivers.forEach((r) => r.close());
    },
  };
}
function identity(
  epoch: bigint,
  source: bigint,
  target: bigint,
): AirplayCompletionKey {
  return { epoch, source, target, revision: 1n };
}
const origin = {
  streamId: 2n,
  epoch: 1n,
  entryId: 10,
  generation: 4,
  originMs: 5000,
};

function renderedRealFrames(
  f: Awaited<ReturnType<typeof nativeHttpFixture>>,
  at = f.receiver.nowMs(),
) {
  const replay = renderScheduledAudio(f.receiver.sessions[0], at);
  assertEquals(replay.issues, []);
  const v = new DataView(
    replay.pcm.buffer,
    replay.pcm.byteOffset,
    replay.pcm.byteLength,
  );
  let frames = 0;
  for (let i = 0; i < replay.pcm.length; i += 4) {
    if (v.getInt16(i, true) || v.getInt16(i + 2, true)) frames++;
  }
  return { frames, uncertainty: replay.clockUncertaintyMs ?? 0 };
}

test('cold HTTP position and reports hold the origin through delayed acquisition', async () => {
  const acquisition = Promise.withResolvers<void>();
  const f = await nativeHttpFixture({
    pcm: pcm(44100 * 5),
    acquisition: acquisition.promise,
  });
  try {
    await f.play();
    await until('reader acquisition', () => f.opens === 1);
    await sleep(600);
    const own = await f.own('/player');
    assertEquals(own.item_progress_ms, 0);
    assertEquals(f.playback.serverNowPlayingView()!.playbackRate, 0);
    const { credential } = await f.fixture.login('bearer');
    const response = await f.fixture.get('/api/v1/players/1', credential);
    assertEquals(response.status, 200);
    const { player: native } = await response.json();
    assertEquals(native.positionMs, 0);
    assertEquals(native.current.playbackRate, 0);
    acquisition.resolve();
    await until(
      'first scheduled source position',
      () => f.playback.playerView().itemProgressMs > 50,
    );
    const view = await f.own('/player');
    const rendered = renderedRealFrames(f);
    assert(
      view.item_progress_ms <=
        rendered.frames * 1000 / 44100 + rendered.uncertainty,
    );
    assert(
      view.item_progress_ms < 1000,
      'preparation/receiver lead is not media progress',
    );
    await libraryProof();
  } finally {
    acquisition.resolve();
    await f.close();
  }
});

test('cold HTTP starvation freezes public progress and playbackRate at rendered real frames', async () => {
  const afterFirstChunk = Promise.withResolvers<void>();
  const f = await nativeHttpFixture({
    pcm: pcm(44100 * 5),
    afterFirstChunk: afterFirstChunk.promise,
  });
  try {
    await f.play();
    await until('scheduled first real chunk', () => {
      if (!f.native || !f.token) return false;
      const p = f.playback.playerView();
      return p.itemProgressMs > 0 && p.playbackRate === 0;
    });
    const first = await f.own('/player');
    await sleep(500);
    const second = await f.own('/player');
    assertEquals(second.item_progress_ms, first.item_progress_ms);
    assertEquals(f.playback.serverNowPlayingView()!.playbackRate, 0);
    const rendered = renderedRealFrames(f);
    assertEquals(
      second.item_progress_ms,
      Math.floor(rendered.frames * 1000 / 44100),
    );
    afterFirstChunk.resolve();
    await until(
      'real progress resumes',
      () => f.playback.playerView().itemProgressMs > second.item_progress_ms,
    );
    await libraryProof();
  } finally {
    afterFirstChunk.resolve();
    await f.close();
  }
});

test('cold HTTP Stop saves the atomic scheduled cutoff, releases speakers and Play restores the bookmark', async () => {
  const f = await nativeHttpFixture({ pcm: pcm(44100 * 10), persist: true });
  try {
    await f.play();
    await until(
      'audible prefix',
      () => f.playback.playerView().itemProgressMs > 250,
    );
    const before = f.playback.playerView().itemProgressMs;
    await f.own('/player/stop', 'PUT');
    assertEquals(f.playback.playerView().state, 'pause');
    await until(
      'source cutoff and speaker release',
      () =>
        f.cutoffs.length === 1 && f.receiver.sessions[0].closedAtMs !== null,
    );
    const cutoff = f.cutoffs[0];
    assert(cutoff.progress);
    const expected = Math.floor(
      Number(cutoff.progress.sourceFrames) * 1000 / 44100,
    );
    assert(
      expected >= before && expected < 1500,
      'accepted/read frames are not the bookmark',
    );
    assertEquals(f.playback.playerView().itemProgressMs, expected);
    assertEquals((await f.saved())!.positionMs, expected);
    await sleep(300);
    assertEquals((await f.own('/player')).item_progress_ms, expected);
    const rendered = renderedRealFrames(f);
    const { before: lowAt, after: highAt } = f.cancelTimes[0];
    const low = renderedRealFrames(f, lowAt - rendered.uncertainty).frames;
    const high = renderedRealFrames(f, highAt + rendered.uncertainty).frames;
    assert(
      Number(cutoff.progress.sourceFrames) >= low &&
        Number(cutoff.progress.sourceFrames) <= high,
      `cutoff agrees with independently rendered wire schedule ${low}..${high}`,
    );
    await f.own('/player/play', 'PUT');
    await until('reopened source at bookmark', () => f.origins.length === 2);
    assertEquals(f.origins[1], expected);
    assertEquals((await f.own('/player')).item_progress_ms, expected);
    await libraryProof();
  } finally {
    await f.close();
  }
});

test('cold HTTP held Pause commits admission cutoff before save, not delayed FLUSH readiness', async () => {
  const flush = Promise.withResolvers<void>();
  const f = await nativeHttpFixture({
    pcm: pcm(44100 * 10),
    persist: true,
    receiver: { beforeFlushReply: () => flush.promise },
  });
  try {
    await f.play();
    await until(
      'scheduled prefix',
      () => f.playback.playerView().itemProgressMs > 100,
    );
    await f.own('/player/pause', 'PUT');
    assertEquals(f.playback.playerView().state, 'pause');
    await until('FLUSH held', () => f.receiver.sessions[0].flushes === 1);
    const provisional = f.playback.playerView().itemProgressMs;
    await until(
      'cutoff captured before readiness',
      () => f.capturedCutoffs.length === 1,
    );
    const cutoff = f.capturedCutoffs[0];
    const expected = Math.floor(
      Number(cutoff.progress.sourceFrames) * 1000 / 44100,
    );
    await sleep(350);
    assertEquals(f.cutoffs.length, 0);
    assertEquals(f.cancelAcks.length, 0);
    assertEquals(f.playback.playerView().itemProgressMs, expected);
    await f.saved();
    const stored = await f.fixture.store.playback.loadPlayerState(1);
    assertEquals(
      stored!.state,
      'pause',
      'atomic cutoff saves without waiting for remote readiness',
    );
    assertEquals(stored!.positionMs, expected);
    flush.resolve();
    await until('ready cancellation', () => f.cutoffs.length === 1);
    const saved = await f.saved();
    assertEquals(f.cutoffs[0].progress, cutoff.progress);
    assertEquals(saved!.positionMs, expected);
    assertEquals(saved!.state, 'pause');
    assertEquals((await f.own('/player')).item_progress_ms, expected);
    assert(
      expected < provisional + 350,
      'held readiness cannot advance the bookmark',
    );
    await f.own('/player/play', 'PUT');
    await until('resume source', () => f.origins.length === 2);
    assertEquals(f.origins[1], expected);
    await libraryProof();
  } finally {
    flush.resolve();
    await f.close();
  }
});

test('cold HTTP native previous and restart remain distinct from OwnTone scheduled threshold', async () => {
  const f = await nativeHttpFixture({ pcm: pcm(44100 * 10) });
  try {
    await f.play();
    await f.play(false);
    const { credential } = await f.fixture.login('bearer');
    const command = async (kind: string, body: unknown = {}) => {
      const r = await f.fixture.json(
        `/api/v1/players/1/${kind}`,
        'POST',
        body,
        credential,
      );
      assertEquals(r.status, 204, await r.text());
    };
    const entries = f.playback.queueView().items;
    await command('next');
    await command('seek', { positionMs: 4000 });
    assertEquals(f.playback.playerView().current!.id, entries[1].id);
    await command('previous');
    assertEquals(f.playback.playerView().current!.id, entries[0].id);
    await command('next');
    await command('seek', { positionMs: 4000 });
    await f.own('/player/previous', 'PUT');
    assertEquals(
      f.playback.playerView().current!.id,
      entries[1].id,
      'OwnTone >3000 restarts current',
    );
    assertEquals(f.playback.playerView().itemProgressMs, 0);
    await f.own('/player/previous', 'PUT');
    assertEquals(
      f.playback.playerView().current!.id,
      entries[0].id,
      'OwnTone <=3000 moves to previous',
    );
    await command('pause');
    await command('restart');
    assertEquals(f.playback.playerView().state, 'pause');
    assertEquals(f.playback.playerView().itemProgressMs, 0);
    await libraryProof();
  } finally {
    await f.close();
  }
});

test('cold HTTP last-target loss uses the same atomic scheduled bookmark as Pause', async () => {
  const f = await nativeHttpFixture({
    pcm: pcm(44100 * 10),
    persist: true,
    targetChecks: true,
  });
  try {
    await f.play();
    await until(
      'scheduled prefix before target loss',
      () => f.playback.playerView().itemProgressMs > 100,
    );
    await f.own('/outputs/1', 'PUT', { selected: false });
    assertEquals(f.playback.playerView().state, 'pause');
    await until('target-loss cutoff', () => f.cutoffs.length === 1);
    const saved = await f.saved(), cutoff = f.cutoffs[0];
    assert(cutoff.progress);
    const expected = Math.floor(
      Number(cutoff.progress.sourceFrames) * 1000 / 44100,
    );
    assertEquals(saved!.positionMs, expected);
    assertEquals((await f.own('/player')).item_progress_ms, expected);
    assertEquals(f.playback.lastCommand()!.source.via, 'playback-target-loss');
    await libraryProof();
  } finally {
    await f.close();
  }
});

test('cold HTTP newer same-entry seek supersedes a command waiting on an old Pause cutoff', async () => {
  const flush = Promise.withResolvers<void>();
  const capture = Promise.withResolvers<void>();
  let latestAdmitted = false;
  const f = await nativeHttpFixture({
    pcm: pcm(44100 * 12),
    persist: true,
    cutoffCapture: capture.promise,
    seekAdmitted: (positionMs) => {
      if (positionMs === 6000) latestAdmitted = true;
    },
    receiver: { beforeFlushReply: () => flush.promise },
  });
  try {
    await f.play();
    await until(
      'scheduled prefix before seek race',
      () => f.playback.playerView().itemProgressMs > 100,
    );
    await f.own('/player/pause', 'PUT');
    await until(
      'old source FLUSH held',
      () => f.receiver.sessions[0].flushes === 1,
    );
    await until('old atomic cutoff held', () => f.capturedCutoffs.length === 1);
    const entry = f.playback.playerView().current!.id;
    let oldSettled = false;
    const stale = Promise.resolve(f.playback.seek({ positionMs: 4000 })).then(
      () => 'published',
      () => 'canceled',
    ).finally(() => oldSettled = true);
    const latest = f.own('/player/seek?position_ms=6000', 'PUT');
    await until('newer HTTP seek admitted', () => latestAdmitted);
    assertEquals(
      oldSettled,
      false,
      'older seek is still waiting on its captured bookmark',
    );
    capture.resolve();
    flush.resolve();
    await latest;
    assertEquals(await stale, 'canceled');
    await until(
      'new source starts at latest origin',
      () => f.origins.length === 2,
    );
    assertEquals(f.origins[1], 6000);
    assertEquals(f.playback.playerView().current!.id, entry);
    assertEquals((await f.own('/player')).item_progress_ms, 6000);
    assertEquals((await f.saved())!.positionMs, 6000);
    await sleep(200);
    assertEquals(
      (await f.own('/player')).item_progress_ms,
      6000,
      'old receipt cannot change a same-entry new incarnation',
    );
    await libraryProof();
  } finally {
    capture.resolve();
    flush.resolve();
    await f.close();
  }
});

test('membership save batch retains its atomic source cutoff through a failed save and retry', async () => {
  const flush = Promise.withResolvers<void>();
  const f = await nativeHttpFixture({
    pcm: pcm(44100 * 10),
    persist: true,
    targetChecks: true,
    receiver: { beforeFlushReply: () => flush.promise },
  });
  const original = f.fixture.store.players.saveChanges;
  try {
    await f.play();
    await until(
      'source before membership publication',
      () => f.playback.playerView().itemProgressMs > 100,
    );
    await f.saved();
    let fail = true;
    const attempts: number[] = [];
    f.fixture.store.players.saveChanges = (changes) => {
      if (changes.outputs?.length && changes.players?.some((p) => p.state)) {
        attempts.push(changes.players.find((p) => p.state)!.state!.positionMs);
        if (fail) {
          fail = false;
          return Promise.reject(new Error('injected membership save failure'));
        }
      }
      return original(changes);
    };
    const receipt = f.publish(() => {
      f.outputs.setEnabled([]);
      f.playback.checkpoint();
    });
    assertEquals(f.playback.playerView().state, 'pause');
    await until(
      'membership cutoff FLUSH held',
      () => f.receiver.sessions[0].flushes === 1,
    );
    await receipt.command;
    // Deselection may establish readiness by local session destruction even
    // while the old FLUSH reply is held. Atomic saving does not depend on it.
    assertEquals(
      (await f.fixture.store.playback.loadPlayerState(1))!.state,
      'play',
    );
    assertEquals(
      (await f.fixture.store.playback.loadOutputs())[0].selected,
      true,
    );
    assertEquals(attempts.length, 1);
    const cutoff = f.capturedCutoffs[0];
    assert(cutoff.progress);
    const expected = Math.floor(
      Number(cutoff.progress.sourceFrames) * 1000 / 44100,
    );
    assertEquals(attempts, [expected]);
    assertEquals(
      (await f.fixture.store.playback.loadPlayerState(1))!.state,
      'play',
      'failed transaction did not half-publish membership or bookmark',
    );
    const saved = await f.saved();
    await receipt.saved;
    assertEquals(
      attempts,
      [expected, expected],
      'retry keeps the same cutoff instead of re-reading a live clock',
    );
    assertEquals(saved!.positionMs, expected);
    assertEquals(saved!.state, 'pause');
    assertEquals(
      (await f.fixture.store.playback.loadOutputs())[0].selected,
      false,
    );
    flush.resolve();
    await libraryProof();
  } finally {
    f.fixture.store.players.saveChanges = original;
    flush.resolve();
    await f.close();
  }
});

test('cold HTTP reader cleanup cannot retire an accepted source bookmark or leave reports extrapolating', async () => {
  const f = await nativeHttpFixture({ pcm: pcm(44100 * 10), persist: true });
  try {
    await f.play();
    await until(
      'real scheduled prefix before reader cleanup',
      () => f.playback.playerView().itemProgressMs > 100,
    );
    const position = f.playback.playerView().itemProgressMs;
    f.playback.cancelSource(f.token!);
    await sleep(100);
    assertEquals(f.playback.serverNowPlayingView()!.playbackRate, 0);
    assertEquals(f.playback.playerView().itemProgressMs, position);
    await f.own('/player/stop', 'PUT');
    const saved = await f.saved();
    assert(f.capturedCutoffs[0].progress);
    assertEquals(
      saved!.positionMs,
      Math.floor(
        Number(f.capturedCutoffs[0].progress.sourceFrames) * 1000 / 44100,
      ),
    );
    assert(saved!.positionMs >= position);
    await libraryProof();
  } finally {
    await f.close();
  }
});

test('lazy atomic cutoff is observable before FLUSH readiness without permitting replacement or ACK', async () => {
  const flush = Promise.withResolvers<void>();
  const f = await fixture({ beforeFlushReply: () => flush.promise });
  try {
    await f.activate();
    const epoch = f.stream.epoch!, source = 91n;
    const bytes = pcm(44100);
    const accepted = await f.stream.appendSource({
      epoch,
      source,
      segment: 1n,
      pcm: bytes,
    });
    assertEquals(accepted.acceptedFrames, 44100n);
    await until(
      'scheduled source prefix',
      async () => (await f.stream.progress(epoch, source))!.sourceFrames > 441n,
    );
    const captures: AirplaySourceCutoff[] = [];
    let ready = false;
    const pending = f.stream.cancelSource(
      epoch,
      source,
      [],
      (cutoff) => captures.push(cutoff),
    );
    void pending.then(() => ready = true);
    await until(
      'immutable cutoff before held FLUSH',
      () => captures.length === 1,
    );
    const cutoff = captures[0];
    assert(Object.isFrozen(cutoff) && Object.isFrozen(cutoff.progress));
    const frozen = structuredClone(cutoff);
    await sleep(100);
    assertEquals(ready, false);
    assertEquals(captures, [frozen]);
    await assertRejects(
      () => f.stream.ackCancel(epoch),
      Error,
      'pending or absent',
    );
    const replacement = {
      epoch: epoch + 1n,
      source: source + 1n,
      segment: 2n,
      pcm: pcm(351, 9),
    };
    assertEquals(
      (await f.stream.appendSource(replacement)).status,
      'not-ready',
    );
    flush.resolve();
    const result = await pending;
    assertEquals(result.progress, cutoff.progress);
    assertEquals(captures.length, 1);
    assertEquals(
      (await f.stream.appendSource(replacement)).acceptedFrames,
      351n,
    );
    await f.stream.ackCancel(epoch);
    await libraryProof();
  } finally {
    flush.resolve();
    await f.close();
  }
});

test('cold HTTP process restart restores the exact Stop cutoff without a live clock', async () => {
  const phase = Deno.env.get('MELOFON_POSITION_RESTART_PHASE');
  if (!phase) {
    const directory = await Deno.makeTempDir({ prefix: 'position-restart-' });
    try {
      for (const phase of ['save', 'restore']) {
        const child = await new Deno.Command(Deno.execPath(), {
          args: [
            'test',
            '--frozen',
            '--cached-only',
            '--node-modules-dir=manual',
            '-A',
            '--filter=cold HTTP process restart restores',
            new URL(import.meta.url).pathname,
          ],
          env: {
            MELOFON_POSITION_RESTART_PHASE: phase,
            MELOFON_POSITION_RESTART_DIR: directory,
          },
        }).output();
        await Deno.writeFile(`${directory}/${phase}.stdout`, child.stdout);
        await Deno.writeFile(`${directory}/${phase}.stderr`, child.stderr);
        assertEquals(
          child.code,
          0,
          new TextDecoder().decode(child.stdout) +
            new TextDecoder().decode(child.stderr),
        );
        const proof = new TextDecoder().decode(child.stdout).split('\n').find((
          line,
        ) => line.startsWith('position native library:'));
        assert(proof, 'child exercised this exact production library');
        console.log(`restart ${phase} ${proof}`);
      }
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
    return;
  }
  const directory = Deno.env.get('MELOFON_POSITION_RESTART_DIR')!;
  const f = await nativeHttpFixture({
    pcm: pcm(44100 * 10),
    persist: true,
    directory,
    storeDir: `${directory}/store`,
    restore: phase === 'restore',
  });
  try {
    if (phase === 'save') {
      await f.play();
      await until(
        'first process plays source',
        () => f.playback.playerView().itemProgressMs > 200,
      );
      await f.own('/player/stop', 'PUT');
      const saved = await f.saved();
      assert(saved!.positionMs > 0 && saved!.positionMs < 2000);
      await Deno.writeTextFile(
        `${directory}/bookmark.json`,
        JSON.stringify(saved),
      );
    } else {
      const saved = JSON.parse(
        await Deno.readTextFile(`${directory}/bookmark.json`),
      );
      const restored = await f.own('/player');
      assertEquals(restored.state, 'pause');
      assertEquals(restored.item_progress_ms, saved.positionMs);
      assertEquals(
        f.receiver.sessions.length,
        0,
        'restoring Stop never seizes the speaker',
      );
      await sleep(300);
      assertEquals((await f.own('/player')).item_progress_ms, saved.positionMs);
      await f.own('/player/play', 'PUT');
      await until(
        'second process opens saved origin',
        () => f.origins.length === 1,
      );
      assertEquals(f.origins[0], saved.positionMs);
      assertEquals((await f.own('/player')).item_progress_ms, saved.positionMs);
      await until(
        'second process scheduled source',
        () => f.playback.playerView().itemProgressMs > saved.positionMs + 50,
      );
      const view = await f.own('/player'), rendered = renderedRealFrames(f);
      assert(
        view.item_progress_ms <=
          saved.positionMs + rendered.frames * 1000 / 44100 +
            rendered.uncertainty,
      );
    }
    await libraryProof();
  } finally {
    await f.close();
  }
});

test('cold HTTP natural stop waits for scheduled final PCM after late acquisition', async () => {
  const acquisition = Promise.withResolvers<void>(), bytes = pcm(44100 + 353);
  const f = await nativeHttpFixture({
    pcm: bytes,
    acquisition: acquisition.promise,
  });
  try {
    await f.play();
    await until('reader starts acquisition', () => f.opens === 1);
    await sleep(1300);
    assertEquals((await f.own('/player')).state, 'play');
    assertEquals(f.receiver.sessions[0].audioPayloads.length, 0);
    acquisition.resolve();
    await until(
      'natural terminal outcome',
      () => f.playback.playerView().state === 'stop',
    );
    const replay = renderScheduledAudio(
      f.receiver.sessions[0],
      f.receiver.nowMs(),
    );
    assertEquals(replay.issues, []);
    assert(
      replay.pcm.length >= bytes.length,
      `scheduled ${replay.pcm.length / 4} of ${
        bytes.length / 4
      } real frames before stop`,
    );
    assertEquals(
      replay.pcm.subarray(0, bytes.length),
      bytes,
      'every real source frame is scheduled before natural stop can flush',
    );
    assertEquals(
      replay.pcm.subarray(bytes.length),
      new Uint8Array(replay.pcm.length - bytes.length),
    );
    assertEquals(f.opens, 1);
    await libraryProof();
  } finally {
    acquisition.resolve();
    await f.close();
  }
});

for (
  const [name, declaredMs, frames] of [
    ['shorter decode paces labelled compatibility silence', 4000, 4410],
    ['longer decode plays beyond the catalog duration', 10, 22050 + 353],
  ] as const
) {
  test(`cold HTTP ${name}`, async () => {
    const bytes = pcm(frames),
      f = await nativeHttpFixture({ pcm: bytes, declaredMs });
    try {
      await f.play();
      if (declaredMs === 4000) {
        await until('sealed shorter source', () => !!f.key);
        await sleep(2800);
        assertEquals((await f.own('/player')).state, 'play');
        assertEquals(f.ackStates.length, 0);
        assertEquals(
          (await f.native.progress(f.key!.epoch, f.key!.source))!.sourceFrames,
          BigInt(frames),
        );
      }
      await until(
        'catalog natural stop',
        () => f.playback.playerView().state === 'stop',
      );
      assertEquals(f.audio.realAudio(f.receiver.sessions[0]), bytes);
      assertEquals(
        f.audio.scheduledRealAudio(f.receiver.sessions[0], f.receiver.nowMs()),
        bytes,
      );
      if (declaredMs === 4000) {
        assert(
          f.audio.epochs[0].ranges.some((r) => r.kind === 'compatibility'),
        );
      }
      await until('ack after committed stop', () => f.ackStates.length === 1);
      assertEquals(f.ackStates[0].state, 'stop');
      await libraryProof();
    } finally {
      await f.close();
    }
  });
}

for (const declaredMs of [null, 0]) {
  test(`cold HTTP catalog duration ${declaredMs} retains completed sink authority until Stop`, async () => {
    const terminalProgress = Promise.withResolvers<void>();
    let progressHeld = false;
    const bytes = pcm(353),
      f = await nativeHttpFixture({
        pcm: bytes,
        declaredMs,
        completionProgress: () => {
          progressHeld = true;
          return terminalProgress.promise;
        },
      });
    try {
      await f.play();
      await f.own('/player/consume?state=true', 'PUT');
      await until(
        'native completion retained',
        async () =>
          !!f.key &&
          (await f.native.pollCompletion(f.key))?.status === 'complete',
      );
      await until(
        'reader completion observed without ack',
        () => f.audio.epochs.length === 1,
      );
      await until(
        'terminal progress held after completion',
        () => progressHeld,
      );
      assertEquals((await f.own('/player')).state, 'play');
      assertEquals(f.playback.queueView().items.length, 1);
      assertEquals(f.ackStates, []);
      assertEquals(
        f.audio.scheduledRealAudio(f.receiver.sessions[0], f.receiver.nowMs()),
        bytes,
      );
      await f.own('/player/stop', 'PUT');
      assertEquals((await f.own('/player')).state, 'pause');
      await until(
        'source cancellation acknowledged',
        () => f.cancelAcks.length === 1,
      );
      assertEquals(
        f.ackStates,
        [],
        'held source cleanup is not yet acknowledged',
      );
      terminalProgress.resolve();
      await until(
        'retained result ack after explicit Stop',
        () => f.ackStates.length === 1,
      );
      assertEquals(f.ackStates[0].state, 'pause');
      assertEquals(
        f.playback.queueView().items.length,
        1,
        'Stop does not consume',
      );
      await libraryProof();
    } finally {
      terminalProgress.resolve();
      await f.close();
    }
  });
}

test('cold HTTP losing a reader cannot fall through to catalog clock completion', async () => {
  const gate = Promise.withResolvers<void>();
  const f = await nativeHttpFixture({
    pcm: pcm(4410),
    acquisition: gate.promise,
  });
  try {
    await f.play();
    await until('reader acquired', () => !!f.token);
    f.playback.cancelSource(f.token!);
    gate.resolve();
    await sleep(350);
    await f.playback.advanceEnded();
    assertEquals((await f.own('/player')).state, 'play');
    assertEquals(
      f.key,
      undefined,
      'cleaned-up reader never sealed a native source',
    );
    assertEquals(f.receiver.sessions[0].audioPayloads.length, 0);
    assertEquals(f.ackStates, []);
    await libraryProof();
  } finally {
    gate.resolve();
    await f.close();
  }
});

test('cold HTTP starvation holds EOF gate and preserves real PCM around labelled silence', async () => {
  const gate = Promise.withResolvers<void>(), bytes = pcm(22050 + 353);
  const f = await nativeHttpFixture({
    pcm: bytes,
    declaredMs: 10,
    afterFirstChunk: gate.promise,
  });
  try {
    await f.play();
    await until('first native frames', async () =>
      !!f.token &&
      (await f.native.progress(f.native.epoch, 1n))?.sourceFrames! > 0n);
    await sleep(2700);
    assertEquals((await f.own('/player')).state, 'play');
    assertEquals(f.key, undefined, 'starvation is not source EOF');
    gate.resolve();
    await until(
      'starved tail renders then stops',
      () => f.playback.playerView().state === 'stop',
    );
    assertEquals(f.audio.realAudio(f.receiver.sessions[0]), bytes);
    assertEquals(
      f.audio.scheduledRealAudio(f.receiver.sessions[0], f.receiver.nowMs()),
      bytes,
    );
    assert(f.audio.epochs[0].ranges.some((r) => r.kind === 'underrun'));
    await libraryProof();
  } finally {
    gate.resolve();
    await f.close();
  }
});

test('cold HTTP finite web EOF needs matching scheduled completion', async () => {
  const bytes = pcm(4410 + 353),
    f = await nativeHttpFixture({ pcm: bytes, web: 'finite' });
  try {
    await f.play();
    await until(
      'finite web natural stop',
      () => f.playback.playerView().state === 'stop',
    );
    assertEquals(f.audio.realAudio(f.receiver.sessions[0]), bytes);
    assertEquals(
      f.audio.scheduledRealAudio(f.receiver.sessions[0], f.receiver.nowMs()),
      bytes,
    );
    await until('finite ack', () => f.ackStates.length === 1);
    await libraryProof();
  } finally {
    await f.close();
  }
});

test('cold HTTP live EOF remains a source failure and never seals a natural completion', async () => {
  const f = await nativeHttpFixture({ pcm: pcm(4410), web: 'live' });
  try {
    await f.play();
    await until(
      'exhausted live source stops',
      () => f.playback.playerView().state === 'stop',
    );
    assertEquals(f.playback.lastCommand()?.kind, 'sourceSkip');
    assertEquals(f.key, undefined);
    assertEquals(f.ackStates, []);
    await libraryProof();
  } finally {
    await f.close();
  }
});

test('core source identities hold the origin and only project matching scheduled facts', () => {
  const timeline = createPlaybackTimeline();
  const a = timeline.begin(origin);
  assertEquals(timeline.position(a)!.positionMs, 5000);
  assertEquals(timeline.position(a)!.capturedNs, null);
  const fact = {
    ...a,
    capturedNs: 100n,
    sourceFrames: 441n,
    status: 'scheduled' as const,
    error: 'none',
  };
  for (const bad of [{ streamId: 3n }, { epoch: 2n }, { source: 99n }]) {
    assertEquals(timeline.observe(a, { ...fact, ...bad }), false);
  }
  assertEquals(
    timeline.observe({ ...a }, fact),
    false,
    'copied token has no source authority',
  );
  assert(timeline.observe(a, fact));
  assertEquals(timeline.position(a)!.positionMs, 5010);
  assertEquals(
    timeline.observe(a, { ...fact, capturedNs: 99n, sourceFrames: 882n }),
    false,
  );
  assert(timeline.observe(a, { ...fact, capturedNs: 200n }));
  assertEquals(
    timeline.position(a)!.positionMs,
    5010,
    'later starvation observation cannot invent elapsed media',
  );
  assert(Object.isFrozen(a) && Object.isFrozen(timeline.position(a)));
});

test('core end authority requires its own sealed target and matching terminal completion', () => {
  const timeline = createPlaybackTimeline(), source = timeline.begin(origin);
  const result = {
    ...source,
    target: 353n,
    revision: 1n,
    status: 'complete' as const,
  };
  assertEquals(
    timeline.complete(source, result),
    false,
    'EOF without a seal is not native completion',
  );
  assert(timeline.seal(source, 353n));
  assertEquals(timeline.seal(source, 354n), false);
  for (
    const change of [
      { epoch: 2n },
      { streamId: 3n },
      { source: 999n },
      { target: 352n },
      { revision: 2n },
      { status: 'failed' as const },
      { status: 'canceled' as const },
      { status: 'pending' as const },
    ]
  ) {
    assertEquals(timeline.complete(source, { ...result, ...change }), false);
  }
  assertEquals(
    timeline.complete({ ...source }, result),
    false,
    'copied identity has no authority',
  );
  assert(timeline.complete(source, result));
  assertEquals(
    timeline.complete(source, result),
    false,
    'one committed outcome',
  );
  timeline.retire(source);
  assertEquals(timeline.complete(source, result), false);
});

test('core commits the atomic old cutoff and rejects delayed old facts after repeat or seek', () => {
  const timeline = createPlaybackTimeline(), a = timeline.begin(origin);
  const fact = {
    ...a,
    capturedNs: 100n,
    sourceFrames: 441n,
    status: 'scheduled' as const,
    error: 'none',
  };
  const cutoff = {
    ...a,
    nextEpoch: 2n,
    admittedNs: 110n,
    progress: { ...fact, capturedNs: 110n, sourceFrames: 882n },
  };
  assertEquals(timeline.cancel(a, { ...cutoff, progress: null }), false);
  assertEquals(timeline.cancel(a, { ...cutoff, epoch: 9n }), false);
  assertEquals(timeline.cancel(a, { ...cutoff, admittedNs: 111n }), false);
  assert(timeline.cancel(a, cutoff));
  assertEquals(timeline.position(a)!.positionMs, 5020);
  assert(timeline.position(a)!.canceled);
  assertEquals(
    timeline.observe(a, { ...fact, capturedNs: 999n, sourceFrames: 999n }),
    false,
  );
  assertThrows(() => timeline.begin(origin), RangeError);
  const repeated = timeline.begin({ ...origin, epoch: 2n });
  assert(repeated.source !== a.source);
  assertEquals(timeline.observe(repeated, fact), false);
  assertEquals(timeline.cancel(repeated, cutoff), false);
  assertEquals(timeline.position(repeated)!.positionMs, 5000);
});

test('core retires mappings without reusing source identities and rejects unrepresentable positions', () => {
  const timeline = createPlaybackTimeline(), a = timeline.begin(origin);
  timeline.retire(a);
  assertEquals(timeline.position(a), null);
  const b = timeline.begin(origin);
  assert(b.source > a.source);
  const fact = {
    ...b,
    capturedNs: 10n,
    sourceFrames: -1n,
    status: 'scheduled' as const,
    error: 'none',
  };
  assertThrows(() => timeline.observe(b, fact), RangeError);
  assertThrows(
    () => timeline.observe(b, { ...fact, sourceFrames: 0xffffffffffffffffn }),
    RangeError,
  );
  assertThrows(
    () => timeline.begin({ ...origin, originMs: Number.MAX_SAFE_INTEGER + 1 }),
    RangeError,
  );
  timeline.close();
  assertEquals(timeline.position(b), null);
  assertThrows(() => timeline.begin(origin), Error, 'closed');
});

test('lazy bridge renders adjacent sealed sources and retains completion until exact ack', async () => {
  const f = await fixture();
  const a = pcm(353), b = pcm(351, 900), expected = new Uint8Array(704 * 4);
  expected.set(a);
  expected.set(b, a.length);
  try {
    assertEquals([f.stream.id, f.stream.epoch, f.allocations], [null, null, 0]);
    const attachment = await f.activate();
    const epoch = f.stream.epoch!;
    assertEquals(f.allocations, 1);
    assertEquals(
      (await f.stream.appendSource({ epoch, source: 1n, segment: 1n, pcm: a }))
        .acceptedFrames,
      353n,
    );
    const first = await f.stream.seal(epoch, 1n, 353n);
    assertEquals([first.status, first.inputEnd], ['accepted', 353n]);
    assertEquals(
      (await f.stream.appendSource({ epoch, source: 2n, segment: 2n, pcm: b }))
        .sourceOffset,
      0n,
    );
    assertEquals((await f.stream.seal(epoch, 2n, 351n)).inputEnd, 704n);
    assertEquals((await f.stream.endStream(epoch, 704n)).status, 'accepted');
    assertEquals(
      (await f.stream.pollCompletion(identity(epoch, 2n, 351n)))!.status,
      'pending',
    );
    await assertRejects(
      () => f.stream.ackCompletion(identity(epoch, 2n, 351n)),
      Error,
      'pending',
    );
    for (const key of [identity(epoch, 1n, 353n), identity(epoch, 2n, 351n)]) {
      const completion = await f.stream.waitCompletion(key);
      assertEquals([completion.status, completion.attachments[0].outcome], [
        'complete',
        'complete',
      ]);
      await until(
        'independent receiver renders complete source',
        () =>
          renderScheduledAudio(
            f.receivers[0].sessions[0],
            f.receivers[0].nowMs(),
          ).pcm.length >= expected.length,
      );
      const replay = renderScheduledAudio(
        f.receivers[0].sessions[0],
        f.receivers[0].nowMs(),
      );
      assertEquals(replay.issues, []);
      assertEquals(replay.pcm.subarray(0, expected.length), expected);
      assertEquals(
        replay.pcm.subarray(expected.length),
        new Uint8Array(replay.pcm.length - expected.length),
      );
      assertEquals(
        (await f.stream.progress(epoch, key.source))!.sourceFrames,
        key.target,
      );
      assertEquals(
        (await f.stream.source(epoch, key.source))!.target,
        key.target,
      );
      assertEquals(await f.stream.pollCompletion(key), completion);
      await f.stream.ackCompletion(key);
      assertEquals(await f.stream.pollCompletion(key), null);
      assertEquals(await f.stream.source(epoch, key.source), null);
    }
    assertEquals(await f.stream.range(epoch, 0n), null);
    assertEquals([
      f.receivers[0].sessions.length,
      f.receivers[0].sessions[0].flushes,
    ], [1, 0]);
    await assertRejects(() => attachment.pcm(pcm(1)), Error, 'belongs');
    await libraryProof();
  } finally {
    await f.close();
  }
});

test('atomic source cutoff excludes underrun and survives held FLUSH plus replacement', async () => {
  const flush = Promise.withResolvers<void>(),
    f = await fixture({ beforeFlushReply: () => flush.promise });
  const timeline = createPlaybackTimeline();
  try {
    await f.activate();
    const a = timeline.begin({
      ...origin,
      streamId: f.stream.id!,
      epoch: f.stream.epoch!,
    });
    const bytes = pcm(353);
    await f.stream.appendSource({ ...a, segment: 1n, pcm: bytes });
    await until('source scheduled plus real underrun', async () => {
      const p = await f.stream.progress(a.epoch, a.source);
      return !!p && p.sourceFrames === 353n && p.silenceFrames > 4410n;
    });
    const old = (await f.stream.progress(a.epoch, a.source))!;
    assert(timeline.observe(a, old));
    const pending = f.stream.cancelSource(a.epoch, a.source);
    assertEquals(
      f.stream.epoch,
      a.epoch + 1n,
      'cancellation fences before first await',
    );
    let settled = false;
    void pending.then(() => settled = true);
    await until(
      'held native FLUSH',
      () => f.receivers[0].sessions[0].flushes === 1,
    );
    await sleep(100);
    assertEquals(settled, false);
    assertEquals(
      (await f.stream.appendSource({
        epoch: f.stream.epoch!,
        source: 99n,
        segment: 2n,
        pcm: pcm(351),
      })).status,
      'not-ready',
    );
    assertEquals(await f.stream.progress(a.epoch, a.source), null);
    assertEquals(await f.stream.source(a.epoch, a.source), null);
    flush.resolve();
    const cutoff = await pending;
    assert(cutoff.progress);
    assertEquals([
      cutoff.source,
      cutoff.progress.sourceFrames,
      cutoff.progress.capturedNs,
    ], [a.source, 353n, cutoff.admittedNs]);
    assert(cutoff.cutoffFrames! > cutoff.progress.sourceFrames);
    assert(cutoff.progress.silenceFrames > 4410n);
    assert(timeline.cancel(a, cutoff));
    assertEquals(timeline.position(a)!.positionMs, 5008);
    const frozen = timeline.position(a);
    assertEquals(timeline.observe(a, old), false);
    assertEquals(timeline.position(a), frozen);
    const renderedOld = renderScheduledAudio(
      f.receivers[0].sessions[0],
      f.receivers[0].nowMs(),
    );
    assertEquals(renderedOld.issues, []);
    assertEquals(renderedOld.pcm.subarray(0, bytes.length), bytes);
    assertEquals(
      renderedOld.pcm.subarray(bytes.length),
      new Uint8Array(renderedOld.pcm.length - bytes.length),
    );
    const b = timeline.begin({
      ...origin,
      streamId: a.streamId,
      epoch: f.stream.epoch!,
      originMs: frozen!.positionMs,
    });
    const replacement = pcm(351, 9000);
    await f.stream.appendSource({ ...b, segment: 2n, pcm: replacement });
    await f.stream.seal(b.epoch, b.source, 351n);
    await f.stream.endStream(b.epoch, 351n);
    assertEquals(
      (await f.stream.waitCompletion(identity(b.epoch, b.source, 351n))).status,
      'complete',
    );
    await until(
      'independent replacement renders',
      () =>
        renderScheduledAudio(f.receivers[0].sessions[0], f.receivers[0].nowMs())
          .ranges.some((r) => r.epoch === Number(b.epoch)),
    );
    const replay = renderScheduledAudio(
      f.receivers[0].sessions[0],
      f.receivers[0].nowMs(),
    );
    const replacementRanges = replay.ranges.filter((r) =>
      r.epoch === Number(b.epoch)
    );
    const actual = new Uint8Array(
      replacementRanges.reduce((n, r) => n + r.pcm.length, 0),
    );
    let offset = 0;
    for (const r of replacementRanges) {
      actual.set(r.pcm, offset);
      offset += r.pcm.length;
    }
    assertEquals(actual.subarray(0, replacement.length), replacement);
    assertEquals(
      actual.subarray(replacement.length),
      new Uint8Array(actual.length - replacement.length),
    );
    assertEquals(replay.issues, []);
    await f.stream.ackCancel(a.epoch);
    await f.stream.ackCompletion(identity(b.epoch, b.source, 351n));
    await libraryProof();
  } finally {
    flush.resolve();
    await f.close();
    timeline.close();
  }
});

for (const timingReplyDelayMs of [0, 20]) {
  test(`mid-source cutoff matches the independent schedule at cancel admission not delayed readiness (timing delay ${timingReplyDelayMs} ms)`, async () => {
    const flush = Promise.withResolvers<void>(),
      f = await fixture({
        beforeFlushReply: () => flush.promise,
        timingReplyDelayMs,
      });
    const bytes = pcm(44100);
    try {
      await f.activate();
      const epoch = f.stream.epoch!;
      await f.stream.appendSource({
        epoch,
        source: 7n,
        segment: 1n,
        pcm: bytes,
      });
      await until(
        'mid-source scheduled watermark',
        async () => (await f.stream.progress(epoch, 7n))!.sourceFrames > 4410n,
      );
      const receiver = f.receivers[0], before = receiver.nowMs();
      const pending = f.stream.cancelSource(epoch, 7n);
      const after = receiver.nowMs();
      await until('held FLUSH', () => receiver.sessions[0].flushes === 1);
      await sleep(300);
      flush.resolve();
      const cutoff = await pending;
      assert(cutoff.progress && cutoff.progress.sourceFrames < 44100n);
      const replay = renderScheduledAudio(receiver.sessions[0], after);
      assert(replay.clockUncertaintyMs !== null);
      // Bound the schedule at admission, not the later control history. A FLUSH
      // inside the timing-error interval must not clip its upper endpoint.
      const admitted = {
        ...receiver.sessions[0],
        wire: receiver.sessions[0].wire.filter((event) => event.atMs <= after),
      };
      const low = renderScheduledAudio(
        admitted,
        Math.max(0, before - replay.clockUncertaintyMs),
      ).pcm.length / 4;
      const high = renderScheduledAudio(
        admitted,
        after + replay.clockUncertaintyMs,
      ).pcm.length / 4;
      assert(
        Number(cutoff.progress.sourceFrames) >= low &&
          Number(cutoff.progress.sourceFrames) <= high,
        `atomic source cutoff ${cutoff.progress.sourceFrames} lies in independent schedule ${low}..${high}`,
      );
      assertEquals(replay.pcm, bytes.subarray(0, replay.pcm.length));
      await f.stream.ackCancel(epoch);
      await libraryProof();
    } finally {
      flush.resolve();
      await f.close();
    }
  });
}

async function cohortPacerChild(
  filter = 'lazy completion cohort revision',
  extra: Record<string, string> = {},
) {
  const directory = await Deno.makeTempDir({ prefix: 'playback-cohort-' });
  const helper = new URL('../helper/raop/', import.meta.url).pathname;
  const interposer = `${directory}/progress.so`;
  const build = await new Deno.Command('cc', {
    args: [
      '-shared',
      '-fPIC',
      '-I',
      `${helper}stub`,
      '-I',
      `${helper}vendor`,
      '-o',
      interposer,
      `${helper}test/progress-faultinject.c`,
      '-ldl',
    ],
  }).output();
  assertEquals(build.code, 0, new TextDecoder().decode(build.stderr));
  const child = await new Deno.Command(Deno.execPath(), {
    args: [
      'test',
      '--frozen',
      '--cached-only',
      '--node-modules-dir=manual',
      '-A',
      `--filter=${filter}`,
      new URL(import.meta.url).pathname,
    ],
    env: {
      LD_PRELOAD: interposer,
      MELOFON_COHORT_CASE: 'held-pacer',
      RAOP_PROGRESS_HOLD: `${directory}/hold`,
      RAOP_PROGRESS_ARM: `${directory}/arm`,
      ...extra,
    },
  }).output();
  await Deno.writeFile(`${directory}/child.stdout`, child.stdout);
  await Deno.writeFile(`${directory}/child.stderr`, child.stderr);
  const stdout = new TextDecoder().decode(child.stdout);
  assertEquals(child.code, 0, stdout + new TextDecoder().decode(child.stderr));
  assert(/1 passed.*0 failed/.test(stdout));
  for (const line of stdout.split('\n')) {
    if (line.startsWith('position native library:')) console.log(line);
  }
}

test('cold HTTP held native emission cannot consume or release accepted EOF', async () => {
  if (Deno.env.get('MELOFON_HTTP_PACER_CASE') !== 'held') {
    return await cohortPacerChild('cold HTTP held native emission', {
      MELOFON_HTTP_PACER_CASE: 'held',
    });
  }
  const hold = Deno.env.get('RAOP_PROGRESS_HOLD')!;
  await Deno.writeTextFile(hold, 'hold accepted EOF before actual emission');
  const bytes = pcm(4410 + 353), f = await nativeHttpFixture({ pcm: bytes });
  try {
    await f.play();
    await f.own('/player/consume?state=true', 'PUT');
    await until('source sealed behind accepted EOF', () => !!f.key);
    await sleep(1200);
    assertEquals((await f.own('/player')).state, 'play');
    assertEquals((await f.own('/player')).item_progress_ms, 0);
    assertEquals(f.playback.serverNowPlayingView()!.playbackRate, 0);
    assertEquals(f.playback.queueView().items.length, 1);
    assertEquals(f.ackStates, []);
    assertEquals(
      (await f.native.source(f.key!.epoch, f.key!.source))!.fedFrames,
      0n,
    );
    assertEquals((await f.native.pollCompletion(f.key!))!.status, 'pending');
    assertEquals(f.receiver.sessions[0].audioPayloads.length, 0);
    assert(
      !f.receiver.sessions[0].wire.some((e) =>
        e.kind === 'flush' || e.kind === 'teardown'
      ),
    );
    await Deno.remove(hold);
    await until(
      'single natural consume after native rendering',
      () => f.playback.playerView().state === 'stop',
    );
    assertEquals(f.playback.queueView().items, []);
    assertEquals(f.audio.realAudio(f.receiver.sessions[0]), bytes);
    assertEquals(
      f.audio.scheduledRealAudio(f.receiver.sessions[0], f.receiver.nowMs()),
      bytes,
    );
    await until(
      'ack follows committed consume',
      () => f.ackStates.length === 1,
    );
    assertEquals(f.ackStates[0].state, 'stop');
    await libraryProof();
  } finally {
    await Deno.remove(hold).catch(() => {});
    await f.close();
  }
});

test('cold HTTP native encoding failure cannot complete or consume sealed EOF', async () => {
  if (Deno.env.get('MELOFON_HTTP_PACER_CASE') !== 'encoder') {
    return await cohortPacerChild('cold HTTP native encoding failure', {
      MELOFON_HTTP_PACER_CASE: 'encoder',
      RAOP_PROGRESS_FAULT: 'encoder',
    });
  }
  const hold = Deno.env.get('RAOP_PROGRESS_HOLD')!,
    arm = Deno.env.get('RAOP_PROGRESS_ARM')!;
  await Deno.writeTextFile(hold, 'seal before native failure');
  const f = await nativeHttpFixture({ pcm: pcm(4410 + 353) });
  try {
    await f.play();
    await f.own('/player/consume?state=true', 'PUT');
    await until('failed source sealed', () => !!f.key);
    await Deno.writeTextFile(arm, 'fail the actual encoder');
    await Deno.remove(hold);
    await until(
      'failed native source pauses',
      () => f.playback.playerView().state === 'pause',
    );
    assertEquals((await f.own('/player')).state, 'pause');
    assertEquals(f.playback.queueView().items.length, 1);
    assertEquals(
      f.audio.epochs,
      [],
      'failed result never credited as complete',
    );
    assertEquals(f.receiver.sessions[0].audioPayloads.length, 0);
    await libraryProof();
  } finally {
    await Deno.remove(hold).catch(() => {});
    await f.close();
  }
});

test('lazy completion cohort revision reports withdrawal and only credits the healthy peer', async () => {
  if (Deno.env.get('MELOFON_COHORT_CASE') !== 'held-pacer') {
    return await cohortPacerChild();
  }
  const hold = Deno.env.get('RAOP_PROGRESS_HOLD')!;
  await Deno.writeTextFile(hold, 'hold actual emission before withdrawal');
  const f = await fixture({}, 2), bytes = pcm(44100);
  try {
    const peers = await Promise.all([f.activate(0), f.activate(1)]);
    const epoch = f.stream.epoch!, key = identity(epoch, 1n, 44100n);
    assertEquals(
      (await f.stream.appendSource({
        epoch,
        source: 1n,
        segment: 1n,
        pcm: bytes,
      })).acceptedFrames,
      44100n,
    );
    await f.stream.seal(epoch, 1n, 44100n);
    await f.stream.endStream(epoch, 44100n);
    assertEquals((await f.stream.source(epoch, 1n))!.fedFrames, 0n);
    await peers[0].close();
    const old = await f.stream.waitCompletion(key);
    assertEquals(old.status, 'failed');
    const withdrawn = old.attachments.find((a) => a.outcome === 'withdrawn');
    assert(withdrawn);
    await Deno.remove(hold);
    // Do not revise while emission is held. Let the loop see the old failed
    // receipt with no pending replacement, and keep its healthy queued tail.
    await until(
      'healthy prefix schedules before core observes the failed cohort',
      async () => (await f.stream.progress(epoch, 1n))!.sourceFrames > 0n,
    );
    const revision = await f.stream.reviseCompletion(key, [
      withdrawn.attachment,
    ]);
    await until(
      'revised cohort reaches a terminal native outcome',
      async () =>
        (await f.stream.pollCompletion(revision))!.status !== 'pending',
    );
    const result = await f.stream.waitCompletion(revision);
    assertEquals(result.status, 'complete');
    assertEquals(result.required, 1n);
    assert(
      result.attachments.some((a) => a.excluded && a.outcome === 'withdrawn'),
    );
    await until(
      'healthy receiver renders',
      () =>
        renderScheduledAudio(f.receivers[1].sessions[0], f.receivers[1].nowMs())
          .pcm.length >= bytes.length,
    );
    const replay = renderScheduledAudio(
      f.receivers[1].sessions[0],
      f.receivers[1].nowMs(),
    );
    assertEquals(replay.issues, []);
    assertEquals(replay.pcm.subarray(0, bytes.length), bytes);
    assertEquals(
      replay.pcm.subarray(bytes.length),
      new Uint8Array(replay.pcm.length - bytes.length),
    );
    assertEquals(await f.stream.pollCompletion(key), old);
    await f.stream.ackCompletion(key);
    await f.stream.ackCompletion(revision);
    await libraryProof();
  } finally {
    await Deno.remove(hold).catch(() => {});
    await f.close();
  }
});

test('close joins lazy completion waits and source cancellation with a held FLUSH', async () => {
  const flush = Promise.withResolvers<void>(),
    f = await fixture({ beforeFlushReply: () => flush.promise });
  try {
    await f.activate();
    const epoch = f.stream.epoch!;
    await f.stream.appendSource({
      epoch,
      source: 1n,
      segment: 1n,
      pcm: pcm(704),
    });
    await f.stream.seal(epoch, 1n, 704n);
    const waiting = f.stream.waitCompletion(identity(epoch, 1n, 704n));
    const progress = f.stream.progress(epoch, 1n);
    const cancellation = f.stream.cancelSource(epoch, 1n);
    await until('held FLUSH', () => f.receivers[0].sessions[0].flushes === 1);
    const closing = f.stream.close();
    assertEquals(f.stream.close(), closing);
    const result = await waiting;
    assertEquals(result.status, 'canceled');
    await progress;
    await cancellation;
    await closing;
    await assertRejects(() => f.stream.progress(epoch, 1n), Error, 'closed');
    await assertRejects(
      () => f.stream.waitCompletion(identity(epoch, 1n, 704n)),
      Error,
      'closed',
    );
    await libraryProof();
  } finally {
    flush.resolve();
    await f.close();
  }
});

test('source cutoff refuses foreign identities and has no vacuous progress without peers', async () => {
  const f = await fixture(), source = 0xfedcba9876543210n;
  try {
    await f.stream.appendSource({
      epoch: 1n,
      source,
      segment: 1n,
      pcm: pcm(353),
    });
    await assertRejects(
      () => f.stream.cancelSource(1n, source + 1n),
      Error,
      'refused',
    );
    await assertRejects(
      () => f.stream.cancelSource(1n, source, [{} as AirplayTransport]),
      Error,
      'Foreign',
    );
    await assertRejects(() => f.stream.cancelSource(1n, 0n), RangeError);
    assertEquals(f.stream.epoch, 1n);
    const result = await f.stream.cancelSource(1n, source);
    assert(result.progress);
    assertEquals([
      result.source,
      result.progress.status,
      result.progress.participants,
      result.progress.sourceFrames,
      result.cutoffFrames,
    ], [source, 'waiting', 0n, 0n, 0n]);
    assertEquals(await f.stream.progress(1n, source), null);
    await f.stream.ackCancel(1n);
    await libraryProof();
  } finally {
    await f.close();
  }
});

test('failed RECORD cutoff stays explicitly failed with zero source credit', async () => {
  const f = await fixture({ refuseRecord: () => true });
  try {
    const epoch = 1n;
    await f.stream.appendSource({
      epoch,
      source: 1n,
      segment: 1n,
      pcm: pcm(704),
    });
    await f.activate(0, false);
    const before = (await f.stream.progress(epoch, 1n))!;
    assertEquals(before.status, 'failed');
    const result = await f.stream.cancelSource(epoch, 1n);
    assert(result.progress);
    assertEquals([
      result.progress.status,
      result.progress.error,
      result.progress.sourceFrames,
    ], ['failed', before.error, 0n]);
    assertEquals(f.receivers[0].sessions[0].audioPackets, 0);
    await f.stream.ackCancel(epoch);
    await libraryProof();
  } finally {
    await f.close();
  }
});

test('raw source cutoff is retained across epochs and exact ack ends its lifetime', async () => {
  const lib = raopFfiInternals.loadLibrary(), s = lib.symbols.raop_stream_new();
  assert(s);
  const source = 0xfedcba9876543210n, append = new BigUint64Array(8);
  try {
    assertEquals(
      lib.symbols.raop_stream_append_source(
        s,
        1n,
        source,
        1n,
        pcm(1),
        4n,
        append,
      ),
      0,
    );
    const ids = new BigUint64Array(0),
      progress = new BigUint64Array(15),
      result = new BigUint64Array(6);
    assertEquals(lib.symbols.raop_stream_cancel_source(s, 1n, 0n, ids, 0n), -1);
    assertEquals(
      lib.symbols.raop_stream_cancel_source(s, 1n, source + 1n, ids, 0n),
      -1,
    );
    assertEquals(lib.symbols.raop_stream_epoch(s), 1n);
    assertEquals(
      lib.symbols.raop_stream_cancel_source(s, 1n, source, ids, 0n),
      0,
    );
    await until(
      'source cutoff applied',
      () =>
        lib.symbols.raop_stream_cancel_source_poll(s, 1n, source, progress) ===
          1,
    );
    const saved = progress.slice();
    assertEquals(saved[1], source);
    assertEquals(saved[14], 0n);
    assertEquals(
      lib.symbols.raop_stream_cancel_source_poll(s, 1n, source + 1n, progress),
      -1,
    );
    assertEquals(lib.symbols.raop_stream_cancel_v2(s, 2n, ids, 0n), 0);
    await until(
      'new cancellation ready',
      () =>
        lib.symbols.raop_stream_cancel_poll(s, 2n, result) === 1 &&
        result[2] !== 0n,
    );
    assertEquals(
      lib.symbols.raop_stream_cancel_source_poll(s, 1n, source, progress),
      1,
    );
    assertEquals(progress, saved);
    assertEquals(lib.symbols.raop_stream_cancel_ack(s, 1n), 0);
    assertEquals(
      lib.symbols.raop_stream_cancel_source_poll(s, 1n, source, progress),
      0,
    );
    assertEquals(lib.symbols.raop_stream_cancel_ack(s, 2n), 0);
    await libraryProof();
  } finally {
    assertEquals(await lib.symbols.raop_stream_free(s), 0);
  }
});

test('exact-only injected backends reject timeline calls rather than fabricate progress', async () => {
  let native: AirplayTimelineStream | undefined;
  const devices = createAirplayDevices({
    outputs: createOutputs(),
    stream() {
      native = createFfiStream();
      return { ...native, appendSource: undefined };
    },
  });
  const stream = devices.createStream();
  try {
    await assertRejects(
      () => stream.progress(1n, 1n),
      Error,
      'timeline backend unavailable',
    );
    assertEquals(stream.epoch, 1n);
    assert(native);
    assertEquals(
      (await stream.append({ epoch: 1n, segment: 1n, pcm: pcm(1) }))
        .acceptedFrames,
      1n,
    );
    await libraryProof();
  } finally {
    await stream.close();
    devices.close();
  }
});
