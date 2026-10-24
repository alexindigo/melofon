// tests/command-provenance.test.ts — command provenance (plan
// command-provenance): every engine mutation records its source as
// lastCommand and emits a command event; unsourced callers read as internal;
// restore is recorded with via 'restore'; native /_/last-command reads the
// records while OwnTone /api/player keeps its eight keys. The 2026-09-24
// ghost-writer incident is the motivation: attribution on every jump.
import {
  assert,
  assertEquals,
  assertStrictEquals,
  assertThrows,
} from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { openStore } from '../src/store/index.ts';
import { createBinds } from '../src/binds.ts';
import { facade } from '../src/facade.ts';
import { loadLayers } from '../src/layers.ts';
import { createState } from '../src/state.ts';
import { createLibraries } from '../src/libraries.ts';
import { createLibrary, type SongRow } from '../src/library.ts';
import { createListens } from '../src/listens.ts';
import { createMedia } from '../src/media.ts';
import { createNotify } from '../src/notify.ts';
import { createNowPlaying } from '../src/nowplaying.ts';
import {
  createOutputs,
  createPlayer,
  type LastCommand,
  type OutputCommand,
} from '../src/player.ts';
import { projectCommandProvenance } from '../src/command-provenance.ts';
import lastCommandGet from '../core/last-command/get.ts';
import { createPlayback } from '../src/playback.ts';
import { createStream } from '../src/stream.ts';
import { createFileSource } from '../src/file-source.ts';
import { createUserService } from '../src/user.ts';
import { captureLogs, parseLogfmt } from './helpers/logging.ts';

let songN = 0;
function song(durationMs: number | null = 180_000): SongRow {
  songN++;
  return {
    id: `hash-${songN}`,
    path: `/music/song-${songN}.mp3`,
    fileName: `song-${songN}`,
    libraryId: null,
    libraryPath: null,
    title: `Song ${songN}`,
    albumId: null,
    albumName: null,
    albumFolderName: null,
    artistId: null,
    artistName: 'Artist',
    track: songN,
    disc: 1,
    durationMs,
    size: 1,
    genre: null,
    year: null,
    firstSeenMs: null,
    isVideo: false,
    suffix: 'mp3',
    contentType: 'audio/mpeg',
  };
}

async function setup() {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-prov-' });
  const store = await openStore(dir);
  const db = store;
  const player = createPlayer();
  const { log, lines: logs } = captureLogs();
  const playback = createPlayback({
    log,
    player,
    nowPlaying: createNowPlaying(store),
    library: createLibrary(store),
    cfg: {},
  });
  return {
    playback,
    logs,
    close: async () => {
      playback.close();
      await db.close();
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

    const cmdLines = logs.map(parseLogfmt).filter((l) => l.event === 'command');
    assertEquals(cmdLines.length, 3);
    assertEquals(cmdLines[0].command, 'queueAdd');
    assertEquals(JSON.parse(cmdLines[0].facts), { songs: 1, play: true });
    assertEquals(cmdLines[0].kind, 'internal');
    assertEquals(cmdLines[1].command, 'seek');
    assertEquals(JSON.parse(cmdLines[1].facts), { position_ms: 4000 });
    assertEquals(cmdLines[1].kind, 'http');
    assertEquals(cmdLines[1].peer, HA.peer);
    assertEquals(cmdLines[1].userAgent, HA.userAgent);
    assertEquals(cmdLines[2].command, 'pause');
    assertEquals(cmdLines[2].via, 'airplay-boot');
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
    const records = logs.map(parseLogfmt).filter((l) => l.event === 'command');
    assertEquals(records.length, 1);
    assertEquals(records[0].command, 'restore');
    assertEquals(records[0].via, 'restore');
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
  const store = await openStore(dir);
  const db = store;
  const cfg = {
    listen: undefined,
    dataDir: dir,
    user: undefined,
    password: undefined,
    secret: undefined,
    version: '0.0.0-test',
  };
  const libraries = createLibraries(store);
  const notify = createNotify();
  const player = createPlayer();
  const nowPlaying = createNowPlaying(store);
  const library = createLibrary(store);
  const { log, lines: logs } = captureLogs();
  const playback = createPlayback({
    player,
    nowPlaying,
    library,
    cfg,
    notify,
    log,
  });
  const bag = {
    state: createState(store),
    cfg,
    libraries,
    user: createUserService(store, cfg),
    library,
    listens: createListens(store),
    nowPlaying,
    player,
    outputs: createOutputs({ notify, log }),
    playback,
    stream: createStream(
      createMedia(),
      playback,
      undefined,
      undefined,
      createFileSource(library),
    ),
    notify,
    binds: createBinds(() => layers, {}),
  };
  const core = await pathfinder({
    roots: ['core/'],
    app: { store, cfg, playback, outputs: bag.outputs },
  });
  const layers = await loadLayers({ app: bag });
  const hook = facade(core, layers, {
    listenPort: 3689,
    defaultPort: 4534,
    env: {},
  });
  return {
    playback,
    outputs: bag.outputs,
    notify,
    core,
    onDefault: (
      request: Request,
      info: unknown = { remoteAddr: { hostname: '127.0.0.1' } },
    ) => facade(core, layers, { defaultPort: 4534, env: {} })(request, info),
    onHook: (
      request: Request,
      info: unknown = { remoteAddr: { hostname: '127.0.0.1' } },
    ) => hook(request, info),
    logs,
    close: async () => {
      playback.close();
      await db.close();
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
    const seekLine = logs.map(parseLogfmt).find((l) =>
      l.event === 'command' && l.command === 'seek'
    )!;
    assertEquals(JSON.parse(seekLine.facts), { position_ms: 30504000 });
    assertEquals(seekLine.kind, 'http');
    assertEquals(seekLine.peer, HA.peer);
    assertEquals(seekLine.client, 'book-checkpoint');
    assertEquals(seekLine.userAgent, HA.userAgent);

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

const PLAYER_KEYS = [
  'state',
  'repeat',
  'consume',
  'shuffle',
  'volume',
  'item_id',
  'item_length_ms',
  'item_progress_ms',
].sort();

Deno.test('native last-command: detached allowlist, optionals and primitive values', () => {
  let hiddenReads = 0;
  const source = {
    kind: 'http' as const,
    via: '',
    peer: '10.4.20.172',
    userAgent: 'quotes"\nframing',
    user: 'public-user',
    client: 'public-client',
  };
  const playback: LastCommand = {
    kind: 'seek',
    detail: '',
    source,
    atMs: 0,
    intent: 'none',
    queueCleared: false,
  };
  const selection = [{ id: '0', selected: false }];
  const outputs: OutputCommand = { kind: 'setEnabled', source, selection };
  for (const object of [playback, outputs, source, selection[0]]) {
    for (
      const key of ['password', 'pin', 'authorization', 'cookie', 'toJSON']
    ) {
      Object.defineProperty(object, key, {
        enumerable: true,
        get() {
          hiddenReads++;
          throw new Error('private accessor must never execute');
        },
      });
    }
  }
  const view = projectCommandProvenance(playback, outputs);
  // Unknown accessors on inputs must not even be inspected by the projection.
  const sourceExpected = {
    kind: 'http' as const,
    via: '',
    peer: '10.4.20.172',
    userAgent: 'quotes"\nframing',
    user: 'public-user',
    client: 'public-client',
  };
  assertEquals(view, {
    playback: {
      kind: 'seek',
      detail: '',
      source: sourceExpected,
      atMs: 0,
      intent: 'none',
      queueCleared: false,
    },
    outputs: {
      kind: 'setEnabled',
      source: sourceExpected,
      selection: [{ id: '0', selected: false }],
    },
  });
  assertEquals(view.playback!.source, sourceExpected);
  assertEquals(view.outputs!.source, sourceExpected);
  const json = JSON.stringify(view);
  assertEquals(JSON.parse(json), view);
  for (const key of ['password', 'pin', 'authorization', 'cookie', 'toJSON']) {
    assertEquals(json.includes(`"${key}"`), false);
  }
  view.playback!.source.client = 'changed';
  view.outputs!.source.peer = 'changed';
  view.playback!.detail = 'changed';
  view.outputs!.selection![0].selected = true;
  view.outputs!.selection!.push({ id: 'new', selected: true });
  assertEquals(source.client, 'public-client');
  assertEquals(source.peer, '10.4.20.172');
  assertEquals(playback.detail, '');
  // Inspect only the fixture's known primitives, never its hostile context.
  assertEquals(selection.length, 1);
  assertEquals(selection[0].id, '0');
  assertEquals(selection[0].selected, false);
  assertEquals(hiddenReads, 0);
  const bare = projectCommandProvenance({
    kind: 'pause',
    source: { kind: 'internal' },
    atMs: 0,
    intent: 'pause',
    queueCleared: true,
  }, { kind: 'update', source: { kind: 'internal' } });
  assertEquals(bare, {
    playback: {
      kind: 'pause',
      source: { kind: 'internal' },
      atMs: 0,
      intent: 'pause',
      queueCleared: true,
    },
    outputs: { kind: 'update', source: { kind: 'internal' } },
  });
  assertEquals(
    projectCommandProvenance(null, {
      kind: 'setEnabled',
      source: { kind: 'internal' },
      selection: [],
    }).outputs!.selection,
    [],
  );
  let coercions = 0;
  const invalidOptional = {
    toString() {
      coercions++;
      throw new Error('no coercion');
    },
    toJSON() {
      coercions++;
      throw new Error('no serialization');
    },
  };
  const malformed = projectCommandProvenance({
    kind: 'seek',
    atMs: 0,
    intent: 'none',
    queueCleared: false,
    detail: invalidOptional,
    source: { kind: 'internal', client: invalidOptional },
  } as unknown as LastCommand, null);
  assertEquals(Object.hasOwn(malformed.playback!, 'detail'), false);
  assertEquals(malformed.playback!.source, { kind: 'internal' });
  assertEquals(coercions, 0);
});

Deno.test('native last-command: reads each owner once and missing injection fails', async () => {
  const reads = [0, 0];
  const context = {
    app: {
      playback: {
        lastCommand() {
          reads[0]++;
          return null;
        },
      },
      outputs: {
        lastCommand() {
          reads[1]++;
          return null;
        },
      },
    },
  };
  const response = lastCommandGet({}, context);
  assertEquals(await response.json(), { playback: null, outputs: null });
  assertEquals(reads, [1, 1]);
  assertEquals(response.headers.get('cache-control'), 'no-store');
  for (const missing of ['playback', 'outputs']) {
    const incomplete = { app: { ...context.app } };
    Reflect.deleteProperty(incomplete.app, missing);
    assertThrows(() => lastCommandGet({}, incomplete), TypeError);
  }
});

Deno.test('native last-command: independently null owners through actual facade JSON', async () => {
  const { playback, onDefault, onHook, close } = await setupWire();
  try {
    const first = await onDefault(new Request('http://x/_/last-command'));
    assertEquals(first.status, 200);
    assertEquals(first.headers.get('cache-control'), 'no-store');
    assert(first.headers.get('content-type')?.includes('application/json'));
    const initial = await first.json();
    assertEquals(initial, { playback: null, outputs: null });
    playback.pause();
    const onlyPlayback =
      await (await onHook(new Request('http://x/_/last-command'))).json();
    assertEquals(onlyPlayback, {
      playback: playback.lastCommand(),
      outputs: null,
    });
  } finally {
    await close();
  }
  const second = await setupWire();
  try {
    second.outputs.setEnabled([]);
    const onlyOutputs =
      await (await second.onDefault(new Request('http://x/_/last-command')))
        .json();
    assertEquals(onlyOutputs, {
      playback: null,
      outputs: second.outputs.lastCommand(),
    });
    assertEquals(onlyOutputs.outputs.selection, []);
  } finally {
    await second.close();
  }
});

Deno.test('native last-command: OwnTone seek, volume and selection share the real owners', async () => {
  const { playback, outputs, onHook, onDefault, close } = await setupWire();
  try {
    playback.restore({
      queue: [song(90_000_000)],
      state: 'pause',
      currentIndex: 0,
      positionMs: 0,
      repeat: 'off',
      shuffle: false,
      consume: false,
    });
    const headers = { ...HA_HEADERS, 'x-melofon-client': 'native-consumer' };
    const receipts = [];
    for (
      const [path, kind, detail] of [
        ['seek?position_ms=75000', 'seek', 'position_ms=75000'],
        ['volume?volume=75', 'volume', 'volume=75'],
      ]
    ) {
      const response = await onHook(
        new Request(`http://x/api/player/${path}`, {
          method: 'PUT',
          headers,
        }),
        HA_INFO,
      );
      assertEquals(response.status, 204);
      const record = playback.lastCommand()!;
      assertEquals(record.kind, kind);
      assertEquals(record.detail, detail);
      assertEquals(record.source, { ...HA, client: 'native-consumer' });
      const native =
        await (await onDefault(new Request('http://x/_/last-command'))).json();
      assertEquals(native, { playback: record, outputs: null });
      const own = await (await onHook(new Request('http://x/api/player')))
        .json();
      assertEquals(Object.keys(own).sort(), PLAYER_KEYS);
      assertEquals(
        own.state,
        'play',
        'seek starts playback (OwnTone semantics)',
      );
      assert(own.item_progress_ms >= 75000);
      if (kind === 'volume') assertEquals(own.volume, 75);
      receipts.push({ native, own });
    }
    outputs.register({
      id: '123',
      name: 'unconnected fixture',
      type: 'AirPlay',
      selected: false,
      volume: 100,
    });
    const selected = await onHook(
      new Request('http://x/api/outputs/set', {
        method: 'PUT',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ outputs: ['123'] }),
      }),
      HA_INFO,
    );
    assertEquals(selected.status, 204);
    const native = await (await onHook(new Request('http://x/_/last-command')))
      .json();
    assertEquals(native, {
      playback: playback.lastCommand(),
      outputs: outputs.lastCommand(),
    });
    assertEquals(native.outputs, {
      kind: 'setEnabled',
      source: { ...HA, client: 'native-consumer' },
      selection: [{ id: '123', selected: true }],
    });
    const ownOutputs = await (await onHook(new Request('http://x/api/outputs')))
      .json();
    assertEquals(ownOutputs.outputs[0].selected, true);
  } finally {
    await close();
  }
});

Deno.test('native last-command: internal pause and restore provenance stays visible', async () => {
  const { playback, outputs, onDefault, close } = await setupWire();
  try {
    playback.restore({
      queue: [song()],
      state: 'pause',
      currentIndex: 0,
      positionMs: 1234,
      repeat: 'off',
      shuffle: false,
      consume: false,
    });
    outputs.register({
      id: '123',
      name: 'restored fixture',
      type: 'AirPlay',
      selected: false,
      volume: 42,
    }, { kind: 'internal', via: 'restore' });
    const restored =
      await (await onDefault(new Request('http://x/_/last-command'))).json();
    assertEquals(restored, {
      playback: playback.lastCommand(),
      outputs: outputs.lastCommand(),
    });
    assertEquals(restored.playback.source, {
      kind: 'internal',
      via: 'restore',
    });
    assertEquals(restored.outputs.source, { kind: 'internal', via: 'restore' });
    playback.pause({ kind: 'internal', via: 'airplay-boot' });
    const paused =
      await (await onDefault(new Request('http://x/_/last-command'))).json();
    assertEquals(paused.playback.kind, 'pause');
    assertEquals(paused.playback.source, {
      kind: 'internal',
      via: 'airplay-boot',
    });
    assertEquals(paused.outputs, restored.outputs);
  } finally {
    await close();
  }
});

Deno.test('native last-command: observer GETs preserve records, state and notifications', async () => {
  const { playback, outputs, notify, onDefault, onHook, logs, close } =
    await setupWire();
  const notifications: string[][] = [];
  const unsubscribe = notify.subscribe((types) => notifications.push(types));
  try {
    playback.restore({
      queue: [song()],
      state: 'pause',
      currentIndex: 0,
      positionMs: 4321,
      repeat: 'off',
      shuffle: false,
      consume: false,
    });
    outputs.register({
      id: '123',
      name: 'frozen fixture',
      type: 'AirPlay',
      selected: false,
      volume: 42,
    });
    const playerRecord = playback.lastCommand();
    const outputRecord = outputs.lastCommand();
    const before = {
      playerRecord,
      outputRecord,
      player: playback.playerView(),
      queue: playback.queueView(),
      outputs: outputs.list(),
      notifications: notifications.slice(),
      commands: logs.map(parseLogfmt).filter((l) => l.event === 'command'),
    };
    const frozen = JSON.stringify(before);
    const responses = [];
    for (const route of [onDefault, onHook, onDefault]) {
      const response = await route(
        new Request('http://x/_/last-command', {
          headers: {
            ...HA_HEADERS,
            'x-melofon-client': 'observer',
            authorization: 'observer-secret',
            cookie: 'observer-cookie',
          },
        }),
        { remoteAddr: { hostname: '127.0.0.1' } },
      );
      assertEquals(response.headers.get('cache-control'), 'no-store');
      const body = await response.json();
      assertEquals(body, { playback: playerRecord, outputs: outputRecord });
      responses.push(body);
    }
    assertStrictEquals(playback.lastCommand(), playerRecord);
    assertStrictEquals(outputs.lastCommand(), outputRecord);
    const after = {
      playerRecord: playback.lastCommand(),
      outputRecord: outputs.lastCommand(),
      player: playback.playerView(),
      queue: playback.queueView(),
      outputs: outputs.list(),
      notifications: notifications.slice(),
      commands: logs.map(parseLogfmt).filter((l) => l.event === 'command'),
    };
    assertEquals(JSON.stringify(after), frozen);
    const own = await (await onHook(new Request('http://x/api/player'))).json();
    assertEquals(Object.keys(own).sort(), PLAYER_KEYS);
  } finally {
    unsubscribe();
    await close();
  }
});

Deno.test('native last-command: output update and PIN expose no inferred payload', async () => {
  const { outputs, onHook, close } = await setupWire();
  try {
    outputs.register({
      id: '123',
      name: 'PIN fixture',
      type: 'AirPlay',
      selected: false,
      volume: 42,
    });
    const pins: unknown[] = [];
    outputs.onCommand((id, command) => pins.push({ id, command }));
    const response = await onHook(
      new Request('http://x/api/outputs/123', {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          'x-melofon-client': 'pin-control',
        },
        body: JSON.stringify({ volume: 0, pin: 'private-pin-canary' }),
      }),
    );
    assertEquals(response.status, 204);
    assertEquals(pins, [{ id: '123', command: { pin: 'private-pin-canary' } }]);
    assertEquals(outputs.get('123')!.volume, 0);
    const native = await (await onHook(new Request('http://x/_/last-command')))
      .json();
    assertEquals(native, {
      playback: null,
      outputs: {
        kind: 'update',
        source: { kind: 'http', client: 'pin-control' },
      },
    });
    assertEquals(JSON.stringify(native).includes('private-pin-canary'), false);
  } finally {
    await close();
  }
});

Deno.test('native last-command: default and extra binds follow GET-only Pathfinder routing', async () => {
  const { core, onDefault, onHook, playback, outputs, close } =
    await setupWire();
  try {
    for (const route of [onDefault, onHook]) {
      const response = await route(new Request('http://x/_/last-command'));
      assertEquals(response.status, 200);
      assertEquals(await response.json(), { playback: null, outputs: null });
      const own = await onHook(new Request('http://x/api/player'));
      assertEquals(Object.keys(await own.json()).sort(), PLAYER_KEYS);
    }
    const expected = await core(
      new Request('http://x/last-command', { method: 'POST' }),
    );
    const expectedBody = await expected.text();
    assert(expected.status >= 400);
    for (const route of [onDefault, onHook]) {
      const response = await route(
        new Request('http://x/_/last-command', { method: 'POST' }),
      );
      assertEquals(response.status, expected.status);
      assertEquals(await response.text(), expectedBody);
    }
    assertEquals(playback.lastCommand(), null);
    assertEquals(outputs.lastCommand(), null);
  } finally {
    await close();
  }
});
