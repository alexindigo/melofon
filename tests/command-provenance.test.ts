// tests/command-provenance.test.ts — command provenance (plan
// command-provenance): every engine mutation records its source as
// lastCommand and logs one [cmd] line; unsourced callers read as internal;
// restore is recorded with via 'restore'; /api/player exposes
// last_command with the request's peer/user-agent. The 2026-09-24
// ghost-writer incident is the motivation: attribution on every jump.
import { assert, assertEquals } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { openDb } from '../src/db.ts';
import { createBinds } from '../src/binds.ts';
import { facade } from '../src/facade.ts';
import { loadLayers } from '../src/layers.ts';
import { createLibraries } from '../src/libraries.ts';
import { createLibrary, type SongRow } from '../src/library.ts';
import { createListens } from '../src/listens.ts';
import { createMedia } from '../src/media.ts';
import { createNotify } from '../src/notify.ts';
import { createNowPlaying } from '../src/nowplaying.ts';
import { createOutputs, createPlayer } from '../src/player.ts';
import { createPlayback } from '../src/playback.ts';
import { createStream } from '../src/stream.ts';
import { createUserService } from '../src/user.ts';

let songN = 0;
function song(durationMs: number | null = 180_000): SongRow {
  songN++;
  return {
    id: `hash-${songN}`,
    path: `/music/song-${songN}.mp3`,
    libraryId: null,
    libraryPath: null,
    title: `Song ${songN}`,
    albumId: null,
    albumName: null,
    artistId: null,
    artistName: 'Artist',
    track: songN,
    disc: 1,
    durationMs,
    size: 1,
    genre: null,
    year: null,
    isVideo: false,
    suffix: 'mp3',
    contentType: 'audio/mpeg',
  };
}

async function setup() {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-prov-' });
  const db = await openDb(dir);
  const player = createPlayer();
  const playback = createPlayback({
    player,
    nowPlaying: createNowPlaying(db),
    library: createLibrary(db),
    cfg: {},
  });
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  };
  return {
    playback,
    logs,
    close: async () => {
      console.log = originalLog;
      playback.close();
      db.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

const HA = {
  kind: 'http' as const,
  peer: '10.4.20.172',
  userAgent: 'HomeAssistant/2026.9.3 aiohttp/3.14.3 Python/3.14',
};

Deno.test('every mutation is recorded with its source as lastCommand', async () => {
  const { playback, close } = await setup();
  try {
    assertEquals(playback.lastCommand(), null, 'nothing before the first');

    playback.queueAdd([song(), song()], { play: true }, HA);
    let cmd = playback.lastCommand()!;
    assertEquals(cmd.kind, 'queueAdd');
    assertEquals(cmd.detail, 'songs=2 play');
    assertEquals(cmd.source, HA);
    assert(cmd.atMs <= Date.now() && cmd.atMs > Date.now() - 5000, 'atMs now');

    playback.seek({ positionMs: 30504000 }, HA);
    cmd = playback.lastCommand()!;
    assertEquals(cmd.kind, 'seek');
    assertEquals(cmd.detail, 'position_ms=30504000');
    assertEquals(cmd.source, HA);

    playback.seek({ seekMs: -2000 }, HA);
    assertEquals(playback.lastCommand()!.detail, 'seek_ms=-2000');

    playback.setVolume({ volume: 75 }, HA);
    assertEquals(playback.lastCommand()!.detail, 'volume=75');
    playback.setVolume({ step: -5 }, HA);
    assertEquals(playback.lastCommand()!.detail, 'step=-5');

    playback.setRepeat('all', HA);
    assertEquals(playback.lastCommand()!.detail, 'repeat=all');
    playback.setShuffle(true, HA);
    assertEquals(playback.lastCommand()!.detail, 'shuffle=true');
    playback.setConsume(false, HA);
    assertEquals(playback.lastCommand()!.detail, 'consume=false');

    playback.pause(HA);
    assertEquals(playback.lastCommand()!.kind, 'pause');
    playback.play(HA);
    assertEquals(playback.lastCommand()!.kind, 'play');
    playback.next(HA);
    assertEquals(playback.lastCommand()!.kind, 'next');
    playback.previous(HA);
    assertEquals(playback.lastCommand()!.kind, 'previous');
    playback.toggle(HA);
    assertEquals(playback.lastCommand()!.kind, 'toggle');
    playback.stop(HA);
    assertEquals(playback.lastCommand()!.kind, 'stop');

    playback.queueAdd([song()], undefined, HA);
    assertEquals(playback.lastCommand()!.detail, 'songs=1');
    playback.queueClear(HA);
    assertEquals(playback.lastCommand()!.kind, 'queueClear');
  } finally {
    await close();
  }
});

Deno.test('an unsourced caller reads as internal; [cmd] lines name the source', async () => {
  const { playback, logs, close } = await setup();
  try {
    playback.queueAdd([song()], { play: true });
    const cmd = playback.lastCommand()!;
    assertEquals(cmd.source, { kind: 'internal' });

    playback.seek({ positionMs: 4000 }, HA);
    playback.pause({ kind: 'internal', via: 'airplay-boot' });

    const cmdLines = logs.filter((l) => l.startsWith('[cmd]'));
    assertEquals(cmdLines.length, 3);
    assertEquals(cmdLines[0], '[cmd] queueAdd songs=1 play by internal:core');
    assertEquals(
      cmdLines[1],
      '[cmd] seek position_ms=4000 by http 10.4.20.172 ' +
        '(HomeAssistant/2026.9.3 aiohttp/3.14.3 Python/3.14)',
    );
    assertEquals(cmdLines[2], '[cmd] pause by internal:airplay-boot');
  } finally {
    await close();
  }
});

Deno.test('restore is recorded with via restore and keeps engine purity', async () => {
  const { playback, logs, close } = await setup();
  try {
    playback.restore({
      queue: [song(90_000_000)],
      state: 'pause',
      currentIndex: 0,
      positionMs: 71033416,
      repeat: 'off',
      shuffle: false,
      consume: false,
    });
    const cmd = playback.lastCommand()!;
    assertEquals(cmd.kind, 'restore');
    assertEquals(cmd.source, { kind: 'internal', via: 'restore' });
    assertEquals(
      logs.filter((l) => l.startsWith('[cmd]')),
      ['[cmd] restore by internal:restore'],
    );
    // The restore emits nothing itself (boot-time behavior unchanged).
    const status = playback.playerView();
    assertEquals(status.state, 'pause');
    assert(status.itemProgressMs >= 71033416);
  } finally {
    await close();
  }
});

/** Full facade harness: real hats, real core, in-memory requests. */
async function setupWire() {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-prov-wire-' });
  const db = await openDb(dir);
  const cfg = {
    listen: undefined,
    dataDir: dir,
    user: undefined,
    password: undefined,
    secret: undefined,
    version: '0.0.0-test',
  };
  const libraries = createLibraries(db);
  const notify = createNotify();
  const player = createPlayer();
  const nowPlaying = createNowPlaying(db);
  const library = createLibrary(db);
  const playback = createPlayback({ player, nowPlaying, library, cfg, notify });
  const bag = {
    cfg,
    libraries,
    user: createUserService(db, cfg),
    library,
    listens: createListens(db),
    nowPlaying,
    player,
    outputs: createOutputs({ notify }),
    playback,
    stream: createStream(createMedia(), playback),
    notify,
    binds: createBinds(() => layers, {}),
  };
  const core = await pathfinder({ roots: ['core/'], app: { db, cfg } });
  const layers = await loadLayers({ app: bag });
  const onHook = facade(core, layers, {
    listenPort: 3689,
    defaultPort: 4534,
    env: {},
  });
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  };
  return {
    playback,
    onHook,
    logs,
    close: async () => {
      console.log = originalLog;
      playback.close();
      db.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

const HA_INFO = {
  remoteAddr: { transport: 'tcp', hostname: '10.4.20.172', port: 51234 },
  completed: Promise.resolve(),
};
const HA_HEADERS = {
  'user-agent': 'HomeAssistant/2026.9.3 aiohttp/3.14.3 Python/3.14',
};

Deno.test('OwnTone GET /api/player carries no last_command; core still records', async () => {
  const { playback, onHook, close } = await setupWire();
  try {
    // The wire is OwnTone: no last_command key, before or after mutations
    // (plan command-provenance-wire-fix).
    let res = await onHook(new Request('http://x/api/player'));
    let body = await res.json();
    assertEquals('last_command' in body, false);

    playback.queueAdd([song(90_000_000)], { play: true });
    res = await onHook(
      new Request('http://x/api/player/seek?position_ms=30504000', {
        method: 'PUT',
        headers: HA_HEADERS,
      }),
      HA_INFO,
    );
    assertEquals(res.status, 204);

    res = await onHook(new Request('http://x/api/player'));
    body = await res.json();
    assertEquals('last_command' in body, false);
    assertEquals(body.item_progress_ms >= 30504000, true, 'the seek worked');

    // …while the core keeps the full provenance record.
    const cmd = playback.lastCommand()!;
    assertEquals(cmd.kind, 'seek');
    assertEquals(cmd.detail, 'position_ms=30504000');
    assertEquals(cmd.source.kind, 'http');
    assertEquals(cmd.source.peer, '10.4.20.172');
    assertEquals(
      cmd.source.userAgent,
      'HomeAssistant/2026.9.3 aiohttp/3.14.3 Python/3.14',
    );
  } finally {
    await close();
  }
});

Deno.test('X-Melofon-Client is scooped as source.client and logged as client=', async () => {
  const { playback, onHook, logs, close } = await setupWire();
  try {
    playback.queueAdd([song(90_000_000)], { play: true });
    const res = await onHook(
      new Request('http://x/api/player/seek?position_ms=30504000', {
        method: 'PUT',
        headers: { ...HA_HEADERS, 'x-melofon-client': 'book-checkpoint' },
      }),
      HA_INFO,
    );
    assertEquals(res.status, 204);

    const cmd = playback.lastCommand()!;
    assertEquals(cmd.source.client, 'book-checkpoint');
    const cmdLines = logs.filter((l) => l.startsWith('[cmd]'));
    const seekLine = cmdLines.find((l) => l.startsWith('[cmd] seek '))!;
    assertEquals(
      seekLine,
      '[cmd] seek position_ms=30504000 by http 10.4.20.172 ' +
        'client=book-checkpoint ' +
        '(HomeAssistant/2026.9.3 aiohttp/3.14.3 Python/3.14)',
    );

    // Header absent → no client field at all.
    await onHook(
      new Request('http://x/api/player/seek?position_ms=30505000', {
        method: 'PUT',
        headers: HA_HEADERS,
      }),
      HA_INFO,
    );
    assertEquals(playback.lastCommand()!.source.client, undefined);
  } finally {
    await close();
  }
});

Deno.test('sourceFrom edge cases: no peer, no UA; UA truncated at 80', async () => {
  const { playback, onHook, close } = await setupWire();
  try {
    playback.queueAdd([song(90_000_000)], { play: true });

    // No info (no remoteAddr) and no user-agent header: source is bare http.
    let res = await onHook(
      new Request('http://x/api/player/seek?position_ms=1000', {
        method: 'PUT',
      }),
    );
    assertEquals(res.status, 204);
    assertEquals(playback.lastCommand()!.source, { kind: 'http' });

    // A long user-agent is truncated to 80 chars in the record.
    res = await onHook(
      new Request('http://x/api/player/seek?position_ms=2000', {
        method: 'PUT',
        headers: { 'user-agent': 'X'.repeat(120) },
      }),
      HA_INFO,
    );
    assertEquals(res.status, 204);
    const source = playback.lastCommand()!.source;
    assertEquals(source.peer, '10.4.20.172');
    assertEquals(source.userAgent, 'X'.repeat(80));
  } finally {
    await close();
  }
});
