// Real OwnTone HTTP admission -> core preparation -> native RAOP consumer.
import { assert, assertEquals, assertRejects } from '@std/assert';
import { apiFixture } from './helpers/api.ts';
import { speakerMedia, until } from './helpers/speaker-consumer.ts';
import { httpRadio, icyBlock } from './helpers/http-radio.ts';
import { startFakeRaop } from './helpers/fake-raop.ts';
import { decodeReceiverAudio } from './helpers/raop-audio-consumer.ts';
import { createTestAirplayDevices } from './helpers/airplay-devices.ts';
import { createFfiSpawn } from '../src/boots/raop-ffi.ts';
import { createAirplayBoot } from '../src/boots/airplay.ts';
import { createMedia } from '../src/media.ts';
import { createOutputs, createPlayer } from '../src/player.ts';
import { createPlayback } from '../src/playback.ts';
import { createLibrary } from '../src/library.ts';
import { createLibraries } from '../src/libraries.ts';
import { createNowPlaying } from '../src/nowplaying.ts';
import { createRadio } from '../src/radio.ts';
import { createNetwork } from '../src/lookups/net.ts';
import { createRadioSource } from '../src/radio-source.ts';
import { createPlaybackSource } from '../src/playback-source.ts';
import { createQueueResolver } from '../src/queue-source.ts';
import { scanLibrary } from '../src/scan.ts';
import { wireInt } from '../layers/owntone/payloads.ts';

const encode = (text: string) => new TextEncoder().encode(text);
async function fixture(receiverPort?: number) {
  let playback!: ReturnType<typeof createPlayback>;
  let radio!: ReturnType<typeof createRadio>;
  let boot: ReturnType<typeof createAirplayBoot> | undefined;
  let devices: ReturnType<typeof createTestAirplayDevices> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let songId = '';
  const f = await apiFixture({
    hats: {
      layersRoot: 'layers',
      extraPorts: 1,
      env: ([port]) => ({ MELOFON_LISTEN_owntone: `${port},${port}` }),
    },
    services: async (f) => {
      assert(f.notify);
      await createLibraries(f.store).add(
        'Music',
        await Deno.realPath('tests/fixtures/library'),
      );
      await scanLibrary(f.store);
      const library = createLibrary(f.store);
      songId = (await library.listSongs({ size: 1, offset: 0 }))[0].id;
      radio = createRadio(f.store);
      const resolve = createQueueResolver({
        getSong: (id) => library.getSong(id),
        getStation: (id) => radio.get(id),
      });
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
      if (receiverPort) {
        outputs.register({
          id: '1',
          name: 'Speech receiver',
          type: 'AirPlay',
          host: '127.0.0.1',
          port: receiverPort,
          selected: true,
          volume: 100,
          connectionStrategy: 'owntone',
        });
      }
      playback = createPlayback({
        player: createPlayer(),
        library,
        cfg: f.cfg,
        outputs,
        notify: f.notify,
        nowPlaying: createNowPlaying(f.store),
        resolveQueueReference: resolve,
        prepareQueueMedia: sources.prepare,
      });
      if (receiverPort) {
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
        timer = setInterval(() => void playback.advanceEnded(), 20);
      }
      return { playback, library, outputs };
    },
  });
  const response = (path: string, method = 'GET') =>
    fetch(
      `http://melofon.home:${f.extraPorts[0]}/api${path}`,
      { method, signal: AbortSignal.timeout(10000) },
    );
  const own = async (path: string, method = 'GET') => {
    const r = await response(path, method), text = await r.text();
    assertEquals(r.status, method === 'PUT' ? 204 : 200, text);
    return text ? JSON.parse(text) : undefined;
  };
  const addPath = (uris: string, options: Record<string, string> = {}) =>
    `/queue/items/add?${new URLSearchParams({ uris, ...options })}`;
  return {
    f,
    playback,
    radio,
    own,
    response,
    addPath,
    songUri: `library:track:${wireInt(songId)}`,
    add: (uris: string, options: Record<string, string> = {}) =>
      own(addPath(uris, options), 'POST'),
    async close() {
      clearInterval(timer);
      await boot?.close();
      devices?.close();
      await playback.close();
      await f.close();
    },
  };
}
async function speech() {
  const dir = await Deno.makeTempDir({ prefix: 'owntone-speech-' });
  const pcm = (await speakerMedia(dir)).slice(0, 352 * 150 * 4);
  const wav = (await Deno.readFile(`${dir}/media/signal.wav`)).slice(
    0,
    44 + pcm.length,
  );
  const view = new DataView(wav.buffer);
  view.setUint32(4, wav.length - 8, true);
  view.setUint32(40, pcm.length, true);
  await Deno.remove(dir, { recursive: true });
  return { pcm, wav };
}

Deno.test('OwnTone admits LAN URLs mixed with library references, preserves encoded URI replay and publishes finite facts', async () => {
  const { wav } = await speech();
  const server = httpRadio(() => ({ body: [wav] }));
  const t = await fixture();
  try {
    await t.add(`${t.songUri},${t.songUri}`);
    const url =
      `${server.origin}/speech%2Cpart?token=a%2Cb&text=hello%20world#Part%201`;
    const added = await t.add(`${url},${t.songUri},${url}`, {
      position: '1',
      shuffle: 'false',
    });
    const queue = await t.own('/queue');
    assertEquals(added.version, queue.version);
    assertEquals(added.count, 3);
    assertEquals(added.items, queue.items.slice(1, 4));
    assertEquals(added.items.map((i: { position: number }) => i.position), [
      1,
      2,
      3,
    ]);
    assertEquals(new Set(queue.items.map((i: { id: number }) => i.id)).size, 5);
    for (const item of [added.items[0], added.items[2]]) {
      assertEquals(item.data_kind, 'http');
      assertEquals(item.uri, url);
      assertEquals(item.title, 'Part%201');
      assertEquals(
        item.length_ms,
        Math.round((wav.length - 44) / 176400 * 1000),
      );
      assert(!('track_id' in item));
      assert(!('artwork_url' in item));
    }
    assertEquals(added.items[1].data_kind, 'file');
    assertEquals(added.items[1].uri, t.songUri);
    assert('track_id' in added.items[1]);
    const replay = await t.add(
      added.items.map((i: { uri: string }) => i.uri).join(','),
      {
        clear: 'true',
        playback: 'start',
        playback_from_position: '2',
      },
    );
    assertEquals(replay.items.map((i: { uri: string }) => i.uri), [
      url,
      t.songUri,
      url,
    ]);
    assert(
      replay.items.every((i: { id: number }) =>
        !queue.items.some((old: { id: number }) => old.id === i.id)
      ),
    );
    const player = await t.own('/player');
    assertEquals(player.item_id, replay.items[2].id);
    assertEquals(player.item_length_ms, replay.items[2].length_ms);
    assertEquals(player.state, 'play');
    assert(
      server.requests.every((r) =>
        new URL(r.url).pathname === '/speech%2Cpart'
      ),
    );
    assert(
      server.requests.every((r) =>
        new URL(r.url).searchParams.get('token') === 'a,b'
      ),
    );
    await until(() => server.closed === server.requests.length);
  } finally {
    await t.close();
    await server.close();
  }
});

Deno.test('OwnTone validates complete batches before clear; remote private redirects and playlists never acquire entered-host trust', async () => {
  const { wav } = await speech();
  const forbidden = httpRadio(() => ({ body: [wav] }));
  const external = forbidden.origin.replace('melofon.home', '127.0.0.1');
  const server = httpRadio((request) => {
    const path = new URL(request.url).pathname;
    if (path === '/redirect') {
      return {
        statusLine: 'HTTP/1.1 302 Found',
        headers: { location: external },
      };
    }
    if (path === '/external.m3u') {
      return { body: [encode(`${external}/audio\n`)] };
    }
    if (path === '/same.m3u') return { body: [encode('/ok\n')] };
    if (path === '/bad') return { body: [encode('<html>not audio</html>')] };
    return { body: [wav] };
  });
  const t = await fixture();
  try {
    await t.add(t.songUri, { playback: 'start' });
    await t.own('/player/pause', 'PUT');
    const oldQueue = await t.own('/queue'), oldPlayer = await t.own('/player');
    const oldCommand = t.playback.lastCommand(),
      events = t.f.notifications.length;
    for (
      const [uri, status] of [
        ['ftp://melofon.home/audio', 400],
        ['http://', 400],
        ['http://user:password@melofon.home/audio', 400],
        ['library:track:1', 404],
        ['library:genre:Missing genre', 404],
        [`${server.origin}/ok,not-a-reference`, 400],
        [`${server.origin}/ok,${server.origin}/bad`, 500],
        [`${server.origin}/redirect`, 500],
        [`${server.origin}/external.m3u`, 500],
        [`${server.origin}/ok,literal-comma`, 400],
      ] as const
    ) {
      const r = await t.response(
        t.addPath(uri, { clear: 'true', playback: 'start', shuffle: 'true' }),
        'POST',
      );
      assertEquals(r.status, status, await r.text());
      assertEquals(await t.own('/queue'), oldQueue);
      assertEquals(await t.own('/player'), oldPlayer);
      assertEquals(t.playback.lastCommand(), oldCommand);
      assertEquals(t.f.notifications.length, events);
    }
    for (
      const reference of [{ kind: 'station', id: 'missing' }, {
        kind: 'url',
        url: 'file:///audio',
      }] as const
    ) {
      await assertRejects(() =>
        t.playback.queueAddReferences([reference], { clear: true })
      );
      assertEquals(await t.own('/queue'), oldQueue);
    }
    assertEquals(forbidden.requests.length, 0);
    const added = await t.add(`${server.origin}/same.m3u`, { clear: 'true' });
    assertEquals(added.items[0].data_kind, 'http');
    assertEquals(added.items[0].title, 'same.m3u');
    assert(added.items[0].length_ms > 0);
    await until(() => server.closed === server.requests.length);
  } finally {
    await t.close();
    await server.close();
    await forbidden.close();
  }
});

Deno.test('core station reference resolves for OwnTone reads; newer HTTP clear cancels parked reference preparation', async () => {
  const { wav } = await speech();
  let parked = false;
  const server = httpRadio((request, signal) =>
    new URL(request.url).pathname === '/parked'
      ? {
        body: (async function* () {
          yield encode('ID3');
          parked = true;
          await new Promise<void>((done) =>
            signal.addEventListener('abort', () => done(), { once: true })
          );
        })(),
      }
      : { body: [wav] }
  );
  const t = await fixture();
  try {
    const station = await t.radio.create({
      name: 'Saved LAN station',
      streamUrl: `${server.origin}/station`,
      homePageUrl: null,
    });
    assert(!('invalid' in station));
    await t.playback.queueAddReferences([{ kind: 'station', id: station.id }], {
      clear: true,
    });
    const queue = await t.own('/queue');
    assertEquals(queue.items[0].title, 'Saved LAN station');
    assertEquals(queue.items[0].uri, `${server.origin}/station`);
    assertEquals(queue.items[0].length_ms, 0);
    assert(!('track_id' in queue.items[0]));
    const pending = t.response(
      t.addPath(`${server.origin}/parked`, {
        clear: 'true',
        playback: 'start',
      }),
      'POST',
    );
    await until(() => parked);
    assertEquals(await t.own('/queue'), queue);
    await t.own('/queue/clear', 'PUT');
    const cancelled = await pending;
    assertEquals(cancelled.status, 500, await cancelled.text());
    assertEquals((await t.own('/queue')).items, []);
    assertEquals((await t.own('/player')).state, 'stop');
    await until(() => server.closed === server.requests.length);
  } finally {
    await t.close();
    await server.close();
  }
});

Deno.test('HA-shaped HTTP finite URL adds deliver complete native receiver audio before natural next and stop', async () => {
  const { pcm, wav } = await speech();
  const server = httpRadio(() => ({
    headers: { 'content-type': 'audio/wav' },
    body: [wav],
  }));
  const receiver = await startFakeRaop({ captureAudio: true });
  const t = await fixture(receiver.port);
  try {
    const url = `${server.origin}/speech?announcement=true`;
    const added = await t.add(`${url},${url}`, {
      clear: 'true',
      playback: 'start',
    });
    assertEquals(
      added.items[0].length_ms,
      Math.round(pcm.length / 176400 * 1000),
    );
    assertEquals((await t.own('/queue')).items, added.items);
    assertEquals((await t.own('/player')).item_id, added.items[0].id);
    await until(() =>
      t.playback.playerView().current?.id === added.items[1].id
    );
    const received = () =>
      decodeReceiverAudio(
        receiver.sessions[0].sdp,
        receiver.sessions[0].audioPayloads,
      );
    const first = received();
    assertEquals(
      first.length,
      pcm.length,
      'complete first speech byte count before next',
    );
    for (let at = 0; at < pcm.length; at += 1408) {
      assertEquals(
        first.slice(at, at + 1408),
        pcm.slice(at, at + 1408),
        `first speech packet ${at / 1408}`,
      );
    }
    assertEquals((await t.own('/player')).item_id, added.items[1].id);
    await until(() => t.playback.playerView().state === 'stop');
    assertEquals((await t.own('/player')).state, 'stop');
    const expected = new Uint8Array(pcm.length * 2);
    expected.set(pcm);
    expected.set(pcm, pcm.length);
    assertEquals(
      received(),
      expected,
      'both complete finite sources reach the ALAC consumer before natural stop',
    );
    assertEquals(receiver.sessions.length, 1, 'natural next retains the sink');
    assertEquals(
      server.requests.length,
      4,
      'two preparation leases and two playback leases',
    );
    await until(() => server.closed === 4);
  } finally {
    await t.close();
    receiver.close();
    await server.close();
  }
});

Deno.test('live ICY titles invalidate OwnTone WS queue reads while station identity and raw native facts stay distinct', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'on-air-' });
  const pcm = await speakerMedia(dir);
  const wav = await Deno.readFile(`${dir}/media/signal.wav`);
  new DataView(wav.buffer).setUint32(4, 0xffffffff, true);
  new DataView(wav.buffer).setUint32(40, 0xffffffff, true);
  const channels: { send?: (text: string | null) => void }[] = [];
  const server = httpRadio((_request, signal) => {
    const channel: typeof channels[number] = {};
    channels.push(channel);
    return {
      headers: {
        'content-type': 'audio/wav',
        'icy-metaint': '65536',
        'icy-name': 'Wire station',
      },
      body: (async function* () {
        let text: string | null = "StreamTitle='Artist A - Title A - Part 2';";
        let at = 0;
        while (!signal.aborted) {
          yield wav.subarray(at, at + 65536);
          at += 65536;
          const block = text === null ? new Uint8Array([0]) : icyBlock(text);
          yield block.subarray(0, 1);
          yield block.subarray(1);
          text = await new Promise<string | null>((done) => {
            channel.send = done;
            if (signal.aborted) done(null);
            else {signal.addEventListener('abort', () => done(null), {
                once: true,
              });}
          });
          channel.send = undefined;
        }
      })(),
    };
  });
  const receiver = await startFakeRaop({ captureAudio: true });
  const t = await fixture(receiver.port);
  const ws = new WebSocket(`ws://melofon.home:${t.f.extraPorts[0]}/`, [
    'notify',
  ]);
  const frames: string[][] = [];
  const snapshots: {
    version: number;
    items: { title: string; album?: string; artist?: string }[];
  }[] = [];
  const reads: Promise<
    {
      version: number;
      items: { title: string; album?: string; artist?: string }[];
    }
  >[] = [];
  try {
    ws.onmessage = (event) => {
      const frame = JSON.parse(String(event.data)).notify as string[];
      frames.push(frame);
      if (frame.includes('queue')) {
        reads.push(
          t.own('/queue').then((queue) => {
            snapshots.push(queue);
            return queue;
          }),
        );
      }
    };
    await until(() => ws.readyState === WebSocket.OPEN);
    ws.send(JSON.stringify({ notify: ['queue', 'player'] }));
    for (let attempt = 0; frames.length === 0; attempt++) {
      assert(attempt < 30);
      await t.own('/player/pause', 'PUT');
      await new Promise((done) => setTimeout(done, 10));
    }
    const login = await t.f.login('bearer');
    const native = async () => {
      const response = await t.f.get('/api/v1/now-playing', login.credential);
      assertEquals(response.status, 200);
      return (await response.json()).nowPlaying[0].media;
    };
    const station = await t.radio.create({
      name: 'Saved station',
      streamUrl: `${server.origin}/live`,
      homePageUrl: null,
    });
    assert(!('invalid' in station));
    await t.playback.queueAddReferences([{ kind: 'station', id: station.id }], {
      play: true,
    });
    const streamTitle = () => {
      const facts = t.playback.playerView().current?.facts;
      return facts?.kind === 'web' ? facts.streamTitle : null;
    };
    await until(() => streamTitle() === 'Artist A - Title A - Part 2');
    await until(() =>
      snapshots.some((q) =>
        q.items[0]?.album === 'Title A - Part 2' &&
        q.items[0]?.artist === 'Artist A'
      )
    );
    assertEquals((await native()).streamTitle, 'Artist A - Title A - Part 2');
    assertEquals((await native()).title, 'Saved station');
    const send = async (text: string | null) => {
      await until(() => !!channels.at(-1)?.send);
      const channel = channels.at(-1)!;
      const done = channel.send!;
      channel.send = undefined;
      done(text);
      await until(() => !!channels.at(-1)?.send);
    };
    const version = (await t.own('/queue')).version;
    const events = t.f.notifications.length;
    await send(null);
    await send("StreamTitle='Artist A - Title A - Part 2';");
    assertEquals(
      (await t.own('/queue')).version,
      version,
      'zero blocks and duplicates do not invalidate',
    );
    assertEquals(t.f.notifications.length, events);
    const before = snapshots.length;
    await send(
      "StreamTitle='Unsplit B';StreamUrl='https://example.test/cover.jpg';",
    );
    await until(() =>
      snapshots.slice(before).some((q) => q.items[0]?.album === 'Unsplit B')
    );
    const changed = snapshots.findLast((q) =>
      q.items[0]?.album === 'Unsplit B'
    )!;
    assertEquals(
      changed.version,
      version + 1,
      'zero and duplicate frames were consumed before B without a revision',
    );
    assertEquals(t.f.notifications.length, events + 1);
    assertEquals(changed.items[0].title, 'Saved station');
    assertEquals(changed.items[0].album, 'Unsplit B');
    assert(!('artist' in changed.items[0]));
    assertEquals((await native()).streamTitle, 'Unsplit B');
    const facts = t.playback.playerView().current!.facts;
    assert(facts.kind === 'web');
    assertEquals(facts.streamUrl, 'https://example.test/cover.jpg');
    await send("StreamTitle='';");
    await until(() => streamTitle() === '');
    assertEquals((await t.own('/queue')).items[0].album, '');
    assertEquals((await native()).streamTitle, '');
    await send("StreamTitle='Artist C - Title C';");
    await until(() => streamTitle() === 'Artist C - Title C');
    await until(() => receiver.sessions[0]?.audioPayloads.length >= 10);
    const received = decodeReceiverAudio(
      receiver.sessions[0].sdp,
      receiver.sessions[0].audioPayloads.slice(0, 10),
    );
    assertEquals(
      received,
      pcm.subarray(0, received.length),
      'metadata never enters receiver PCM',
    );
    await t.own('/player/pause', 'PUT');
    assert(!('album' in (await t.own('/queue')).items[0]));
    assertEquals((await native()).streamTitle, null);
    await t.own('/player/play', 'PUT');
    await until(() => channels.length === 2);
    await until(() => streamTitle() === 'Artist A - Title A - Part 2');
    assertEquals((await t.own('/queue')).items[0].title, 'Saved station');
    await t.own('/player/stop', 'PUT');
    assert(!('album' in (await t.own('/queue')).items[0]));
    // URL inspection must not publish on-air facts; playback learns icy-name.
    await t.add(`${server.origin}/direct`, {
      clear: 'true',
      playback: 'start',
    });
    await until(() => channels.length === 4);
    await until(() => streamTitle() === 'Artist A - Title A - Part 2');
    assertEquals((await t.own('/queue')).items[0].title, 'Wire station');
    assertEquals((await native()).title, 'Wire station');
    await t.add(t.songUri);
    await t.own('/player/next', 'PUT');
    const next = await t.own('/queue');
    assert(!('album' in next.items[0]));
    assertEquals(next.items[1].data_kind, 'file');
    assertEquals((await t.own('/player')).item_id, next.items[1].id);
  } finally {
    ws.close();
    await until(() => ws.readyState === WebSocket.CLOSED);
    await Promise.all(reads);
    await t.close();
    receiver.close();
    await server.close();
    await Deno.remove(dir, { recursive: true });
  }
});
