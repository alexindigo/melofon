// tests/command-provenance.test.ts — command provenance (plan
// command-provenance): every engine mutation records its source as
// lastCommand and logs one [cmd] line; unsourced callers read as internal;
// restore is recorded with via 'restore'. The 2026-09-24 ghost-writer
// incident is the motivation: attribution on every jump.
import { assert, assertEquals } from '@std/assert';
import { openDb } from '../src/db.ts';
import { createLibrary, type SongRow } from '../src/library.ts';
import { createNowPlaying } from '../src/nowplaying.ts';
import { createPlayer } from '../src/player.ts';
import { createPlayback } from '../src/playback.ts';

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
