import { assert, assertEquals } from '@std/assert';
import { createPlayback } from '../src/playback.ts';
import { createOutputs, createPlayer } from '../src/player.ts';
import { createNotify } from '../src/notify.ts';
import { createQueueResolver, type QueueMedia } from '../src/queue-source.ts';
import type { Library } from '../src/library.ts';
import type { NowPlaying } from '../src/nowplaying.ts';
import type { State } from '../src/state.ts';
import { captureLogs } from './helpers/logging.ts';
import { apiFixture } from './helpers/api.ts';
import { speakerMedia, until } from './helpers/speaker-consumer.ts';
import { httpRadio, icyBlock } from './helpers/http-radio.ts';
import { startFakeRaop } from './helpers/fake-raop.ts';
import { decodeReceiverAudio } from './helpers/raop-audio-consumer.ts';
import { createTestAirplayDevices } from './helpers/airplay-devices.ts';
import { createFfiSpawn } from '../src/boots/raop-ffi.ts';
import { createAirplayBoot } from '../src/boots/airplay.ts';
import { createMedia } from '../src/media.ts';
import { createNetwork } from '../src/lookups/net.ts';
import { createRadioSource } from '../src/radio-source.ts';
import { createPlaybackSource } from '../src/playback-source.ts';
import { createLibrary } from '../src/library.ts';
import { createRadio } from '../src/radio.ts';
import { createNowPlaying } from '../src/nowplaying.ts';

function web(id: number): QueueMedia {
  const url = `http://melofon.home/${id}?private=QUERY-CANARY`;
  return {
    reference: { kind: 'url', url },
    facts: {
      kind: 'web',
      url,
      title: 'Station',
      artistName: null,
      durationMs: null,
      mode: 'live',
      seekable: false,
      streamTitle: null,
      streamUrl: null,
    },
  };
}

function fixture(
  backoff = [0, 0, 0],
  overrides: Partial<Parameters<typeof createPlayback>[0]> = {},
) {
  const capture = captureLogs();
  const declarations = new Map<string, { default: unknown }>();
  const settings = new Map<string, unknown>([[
    'playback.source.retryBackoffMs',
    backoff,
  ]]);
  const state = {
    declare: (key: string, schema: { default: unknown }) =>
      declarations.set(key, schema),
    getTyped: (key: string) =>
      Promise.resolve(settings.get(key) ?? declarations.get(key)?.default),
  } as Pick<State, 'declare' | 'getTyped'>;
  const player = createPlayer();
  const notify = createNotify();
  const events: string[][] = [];
  notify.subscribe((types) => events.push(types));
  const playback = createPlayback({
    player,
    notify,
    state,
    log: capture.log,
    library: {} as Library,
    nowPlaying: {} as NowPlaying,
    cfg: {},
    ...overrides,
  });
  const open = () => {
    const view = playback.playerView();
    const token = playback.openSource(view.current!.id, view.generation);
    assert(token);
    return token;
  };
  return { playback, open, settings, declarations, capture, events };
}

Deno.test('source retry defaults, short flaps, delivered-audio reset and safe structured facts', async () => {
  const f = fixture();
  try {
    assertEquals(
      f.declarations.get('playback.source.retryBackoffMs')?.default,
      [1000, 2000, 5000],
    );
    assertEquals(
      f.declarations.get('playback.source.retryResetAudioMs')?.default,
      30000,
    );
    await f.playback.queueAddSources([web(1)], { play: true });
    const token = f.open();
    for (let n = 0; n < 3; n++) {
      f.playback.sourceAudio(token, 29999);
      assert(await f.playback.retrySource(token, 'transport-error'));
    }
    assertEquals(await f.playback.retrySource(token, 'eof'), false);
    f.playback.sourceAudio({ ...token }, 30000);
    assertEquals(
      await f.playback.retrySource(token, 'eof'),
      false,
      'forged delivery cannot reset',
    );
    f.playback.sourceAudio(token, 30000);
    assert(await f.playback.retrySource(token, 'decode-error'));
    assertEquals(
      f.capture.records().filter((r) => r.event === 'source_retry').map((r) =>
        r.attempt
      ),
      ['1', '2', '3', '1'],
    );
    assert(!f.capture.lines.join('').includes('QUERY-CANARY'));
    assert(!f.capture.lines.join('').includes('http://'));
  } finally {
    await f.playback.close();
  }
});

Deno.test('source retry budget survives feed handoff without counting output-only cancellation', async () => {
  const f = fixture([0]);
  try {
    await f.playback.queueAddSources([web(1), web(2)], { play: true });
    const first = f.open();
    assert(await f.playback.retrySource(first, 'eof'));
    f.playback.cancelSource(first);
    const second = f.open();
    assertEquals(await f.playback.retrySource(first, 'eof'), false);
    assertEquals(await f.playback.retrySource(second, 'eof'), false);
    assertEquals(f.playback.playerView().current?.id, first.entryId);
    assertEquals(f.playback.playerView().state, 'play');
    assertEquals(
      f.capture.records().filter((r) => r.event === 'source_retry').length,
      1,
    );
  } finally {
    await f.playback.close();
  }
});

Deno.test('exhaustion parked in station activation resumes after a nondestructive queue append', async () => {
  let resolve!: (value: QueueMedia) => void;
  let waiting = false;
  const parked = new Promise<QueueMedia>((done) => resolve = done);
  const f = fixture([], {
    resolveQueueReference: () => {
      waiting = true;
      return parked;
    },
  });
  try {
    const next = {
      ...web(2),
      reference: { kind: 'station', id: 'next' },
    } as QueueMedia;
    const added = await f.playback.queueAddSources([web(1), next], {
      play: true,
    });
    assert(f.playback.reportSourceOutcome(f.open(), 'decode-error'));
    await until(() => waiting);
    await f.playback.queueAddSources([web(3)]);
    resolve(next);
    await new Promise((done) => setTimeout(done, 0));
    await f.playback.advanceEnded();
    assertEquals(f.playback.playerView().current?.id, added[1].id);
    assertEquals(f.playback.queueView().items.length, 3);
  } finally {
    await f.playback.close();
  }
});

for (
  const action of ['pause', 'stop', 'next', 'queueClear', 'close'] as const
) {
  Deno.test(`source retry delay is revoked by ${action} without stale metadata or advance`, async () => {
    const f = fixture([600000]);
    try {
      await f.playback.queueAddSources([web(1), web(2)], { play: true });
      const token = f.open();
      const pending = f.playback.retrySource(token, 'eof');
      await until(() =>
        f.capture.records().some((r) => r.event === 'source_retry')
      );
      await f.playback[action]();
      assertEquals(await pending, false);
      assert(token.signal.aborted);
      const before = f.playback.playerView();
      assertEquals(
        f.playback.reportSourceOutcome(token, 'decode-error'),
        false,
      );
      assertEquals(
        f.playback.reportSourceMetadata(token, { streamTitle: 'late' }),
        false,
      );
      assertEquals(f.playback.playerView(), before);
    } finally {
      await f.playback.close();
    }
  });
}

for (const repeat of ['off', 'single', 'all'] as const) {
  for (const consume of [false, true]) {
    Deno.test(`exhaustion skips exactly once with repeat=${repeat}, consume=${consume}, and an all-failed queue stops`, async () => {
      const f = fixture([]);
      try {
        const added = await f.playback.queueAddSources([web(1), web(2)], {
          play: true,
        });
        f.playback.setRepeat(repeat);
        f.playback.setConsume(consume);
        const first = f.open();
        assertEquals(await f.playback.retrySource(first, 'eof'), false);
        assert(f.playback.reportSourceOutcome(first, 'decode-error'));
        assertEquals(f.playback.reportSourceOutcome(first, 'eof'), false);
        assertEquals(f.playback.playerView().current?.id, added[1].id);
        assertEquals(f.playback.queueView().items.length, consume ? 1 : 2);
        const second = f.open();
        assert(f.playback.reportSourceOutcome(second, 'decode-error'));
        assertEquals(f.playback.playerView().state, 'stop');
        assertEquals(f.playback.queueView().items.length, consume ? 0 : 2);
        assertEquals(
          f.playback.reportSourceOutcome(second, 'decode-error'),
          false,
        );
      } finally {
        await f.playback.close();
      }
    });
  }
}

Deno.test('OwnTone reconnect retains occurrence, tries ordered alternatives, delivers replacement ALAC audio and advances once', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'radio-reconnect-' });
  const allPcm = await speakerMedia(dir);
  const pcm = allPcm.slice(0, 352 * 100 * 4);
  // Keep each attempt below the approved 30-second replenishment threshold.
  const fullWav = (await Deno.readFile(`${dir}/media/signal.wav`)).slice(
    0,
    44 + 352 * 500 * 4,
  );
  const wav = fullWav.slice(0, 44 + pcm.length);
  new DataView(wav.buffer).setUint32(4, 0xffffffff, true);
  new DataView(wav.buffer).setUint32(40, 0xffffffff, true);
  new DataView(fullWav.buffer).setUint32(4, 0xffffffff, true);
  new DataView(fullWav.buffer).setUint32(40, 0xffffffff, true);
  const nextWav = fullWav.slice();
  const samples = new DataView(nextWav.buffer);
  for (let at = 44; at < nextWav.length; at += 2) {
    samples.setInt16(at, -samples.getInt16(at, true), true);
  }
  const nextPcm = nextWav.subarray(44);
  let releaseBackup: (() => void) | undefined;
  let releaseHealthy: (() => void) | undefined;
  let a = 0, b = 0, healthyHits = 0;
  const capture = captureLogs();
  const server = httpRadio((request, signal) => {
    const path = new URL(request.url).pathname;
    if (path === '/list.m3u') {
      return {
        body: [
          new TextEncoder().encode(
            '/a?private=QUERY-CANARY\n/b?private=QUERY-CANARY',
          ),
        ],
      };
    }
    if (path === '/a' && a++ > 0 || path === '/b' && b++ > 0) {
      return { statusLine: 'HTTP/1.1 503 Unavailable' };
    }
    if (path === '/healthy' && healthyHits++ > 0) {
      return { statusLine: 'HTTP/1.1 503 Unavailable' };
    }
    const audio = path === '/a' ? wav : path === '/b' ? fullWav : nextWav;
    return {
      headers: {
        'content-type': 'audio/wav',
        'icy-name': 'Radio',
        'icy-metaint': String(audio.length),
      },
      body: (async function* () {
        yield audio;
        yield icyBlock(`StreamTitle='${path}';`);
        if (path !== '/a') {
          await new Promise<void>((done) => {
            if (path === '/b') releaseBackup = done;
            if (path === '/healthy') releaseHealthy = done;
            if (signal.aborted) done();
            else signal.addEventListener('abort', () => done(), { once: true });
          });
        }
      })(),
    };
  });
  const receivers = await Promise.all([
    startFakeRaop({ captureAudio: true }),
    startFakeRaop({ captureAudio: true }),
  ]);
  let playback!: ReturnType<typeof createPlayback>;
  let radio!: ReturnType<typeof createRadio>;
  let boot: ReturnType<typeof createAirplayBoot> | undefined;
  let devices: ReturnType<typeof createTestAirplayDevices> | undefined;
  const f = await apiFixture({
    hats: {
      layersRoot: 'layers',
      extraPorts: 1,
      env: ([port]) => ({ MELOFON_LISTEN_owntone: `${port},${port}` }),
    },
    services: async (f) => {
      assert(f.notify);
      const library = createLibrary(f.store);
      radio = createRadio(f.store);
      const media = createMedia();
      const sources = createPlaybackSource({
        media,
        state: f.state,
        radio: createRadioSource({
          network: createNetwork({ state: f.state }),
          state: f.state,
        }),
      });
      const outputs = createOutputs({ notify: f.notify });
      receivers.forEach((receiver, n) =>
        outputs.register({
          id: String(n + 1),
          name: `Receiver ${n}`,
          type: 'AirPlay',
          host: '127.0.0.1',
          port: receiver.port,
          selected: true,
          volume: 100,
          connectionStrategy: 'owntone',
        })
      );
      playback = createPlayback({
        player: createPlayer(),
        library,
        cfg: f.cfg,
        outputs,
        notify: f.notify,
        state: f.state,
        log: capture.log,
        nowPlaying: createNowPlaying(f.store),
        resolveQueueReference: createQueueResolver({
          getSong: (id) => library.getSong(id),
          getStation: (id) => radio.get(id),
        }),
        prepareQueueMedia: sources.prepare,
      });
      await f.state.set('playback.source.retryBackoffMs', '100,100,100');
      devices = createTestAirplayDevices(outputs, createFfiSpawn());
      boot = createAirplayBoot({
        outputs,
        playback,
        media,
        sources,
        devices,
        notify: f.notify,
        retryBackoffMs: [],
      });
      return { playback, outputs, library };
    },
  });
  const own = async (path: string, method = 'GET') => {
    const r = await fetch(`http://melofon.home:${f.extraPorts[0]}/api${path}`, {
      method,
      signal: AbortSignal.timeout(10000),
    });
    assertEquals(r.status, method === 'GET' ? 200 : 204);
    const text = await r.text();
    return text ? JSON.parse(text) : undefined;
  };
  try {
    const station = await radio.create({
      name: 'Saved radio',
      streamUrl: `${server.origin}/list.m3u`,
      homePageUrl: null,
    });
    const healthy = await radio.create({
      name: 'Next radio',
      streamUrl: `${server.origin}/healthy`,
      homePageUrl: null,
    });
    assert(!('invalid' in station) && !('invalid' in healthy));
    await own('/player/repeat?state=single', 'PUT');
    const added = await playback.queueAddReferences([{
      kind: 'station',
      id: station.id,
    }, { kind: 'station', id: healthy.id }], { play: true });
    await until(() =>
      capture.records().some((r) => r.event === 'source_retry')
    );
    assertEquals(
      (await own('/player')).item_id,
      added[0].id,
      'backoff retains the occurrence',
    );
    await until(() =>
      receivers.every((r) => r.sessions[0]?.audioPayloads.length >= 200)
    );
    for (const receiver of receivers) {
      const actual = decodeReceiverAudio(
        receiver.sessions[0].sdp,
        receiver.sessions[0].audioPayloads.slice(0, 200),
      );
      const expected = new Uint8Array(pcm.length * 2);
      expected.set(pcm);
      expected.set(pcm, pcm.length);
      assertEquals(
        actual,
        expected,
        'initial and reconnected audio reach both consumers on the same occurrence',
      );
    }
    assertEquals((await own('/player')).item_id, added[0].id);
    await until(() => !!releaseBackup);
    releaseBackup!();
    await until(() => playback.playerView().current?.id === added[1].id);
    assertEquals((await own('/player')).item_id, added[1].id);
    const queue = await own('/queue');
    assertEquals(
      queue.items.map((i: { id: number }) => i.id),
      added.map((i) => i.id),
    );
    assert(
      !('album' in queue.items[0]),
      'exhausted on-air metadata is cleared',
    );
    const replacement = (receiver: typeof receivers[number]) => {
      const actual = decodeReceiverAudio(
        receiver.sessions[0].sdp,
        receiver.sessions[0].audioPayloads,
      );
      const marker = nextPcm.subarray(0, 1408);
      // Live source boundaries need not coincide with ALAC packet boundaries.
      // Locate the exact PCM prefix at a stereo sample boundary, then compare
      // the entire twenty-packet-sized window byte for byte.
      for (let at = 0; at + 1408 * 20 <= actual.length; at += 4) {
        if (marker.every((byte, n) => actual[at + n] === byte)) {
          return actual.subarray(at, at + 1408 * 20);
        }
      }
      return null;
    };
    await until(() => receivers.every((r) => replacement(r) !== null));
    for (const receiver of receivers) {
      assertEquals(
        replacement(receiver),
        nextPcm.subarray(0, 1408 * 20),
        'next occurrence delivers its distinct PCM',
      );
    }
    assertEquals(server.requests.map((r) => new URL(r.url).pathname), [
      '/list.m3u',
      '/a',
      '/b',
      '/list.m3u',
      '/a',
      '/b',
      '/healthy',
    ]);
    assertEquals(
      capture.records().filter((r) => r.event === 'source_retry').length,
      3,
    );
    assertEquals(
      capture.records().filter((r) => r.event === 'source_exhausted').length,
      1,
    );
    assert(!capture.lines.join('').includes('QUERY-CANARY'));
    await own('/player/repeat?state=all', 'PUT');
    await until(() => !!releaseHealthy);
    releaseHealthy!();
    await until(() => playback.playerView().state === 'stop');
    assertEquals(
      (await own('/player')).state,
      'stop',
      'repeat-all cannot revisit the all-failed queue',
    );
    assertEquals((await own('/queue')).items.length, 2);
    assertEquals(server.requests.length, 10);
    assertEquals(
      capture.records().filter((r) => r.event === 'source_exhausted').length,
      2,
    );
    await until(() => server.closed === server.requests.length);
  } finally {
    await boot?.close();
    devices?.close();
    await playback.close();
    await f.close();
    receivers.forEach((r) => r.close());
    await server.close();
    await Deno.remove(dir, { recursive: true });
  }
});
