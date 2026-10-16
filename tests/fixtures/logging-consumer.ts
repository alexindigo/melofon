// Ordinary consumer child. The test parent may be interposed; this child never is.
import { appLogger } from '../../src/logging.ts';
import { installDependencyLogging } from '../../src/logging-dependencies.ts';
import { parseLogfmt } from '../helpers/logging.ts';

const log = appLogger();
for (const key of Object.keys(Deno.env.toObject())) {
  if (
    key === 'LD_PRELOAD' || key.startsWith('MELOFON_RAOP_FAULT') ||
    key.startsWith('RAOP_FI_')
  ) throw new Error(`Ordinary child inherited fault environment: ${key}`);
}
log.registerSecrets(['credential/CANARY']);
installDependencyLogging(log);
const mode = Deno.args[0];
if (mode === 'streams') {
  log.event('fixture_info', { payload: 'credential/CANARY\nline\u001b[31m' });
  log.event('fixture_warn', { payload: { PIN: 'pin-canary' } });
  log.event('fixture_error', {
    payload: new Error('credential/CANARY\nerror'),
  });
} else if (mode === 'queue') {
  const root = Deno.cwd();
  const dir = await Deno.makeTempDir({ prefix: 'logging-native-probe-' });
  const binary = `${dir}/probe_logging`;
  try {
    const compile = await new Deno.Command('cc', {
      args: [
        '-Ihelper/raop',
        '-Ihelper/raop/stub',
        'helper/raop/test/probe_logging.c',
        `-L${root}/helper/raop`,
        '-lmelofon_raop',
        '-lavutil',
        '-levent',
        `-Wl,-rpath,${root}/helper/raop`,
        '-lpthread',
        '-o',
        binary,
      ],
      stdout: 'piped',
      stderr: 'piped',
    }).output();
    if (!compile.success) {
      throw new Error(new TextDecoder().decode(compile.stderr));
    }
    const result = await new Deno.Command(binary, {
      clearEnv: true,
      env: { PATH: '/usr/bin:/bin', TMPDIR: dir },
      stdout: 'piped',
      stderr: 'piped',
    }).output();
    if (!result.success) {
      throw new Error(new TextDecoder().decode(result.stderr));
    }
    for (
      const line of new TextDecoder().decode(result.stdout).trim().split('\n')
    ) log.event('native_record', JSON.parse(line));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
} else if (mode === 'inventory') {
  const objects = [
    'ffi.o',
    'player.o',
    'vendor/outputs/raop.o',
    'vendor/outputs/rtp_common.o',
    'vendor/evrtsp/rtsp.o',
    'vendor/pair_ap/pair.o',
    'vendor/pair_ap/pair_fruit.o',
    'vendor/pair_ap/pair_homekit.o',
    'vendor/pair_ap/pair-tlv.o',
    'vendor/transcode.o',
    'vendor/misc.o',
  ];
  const forbidden = new Set([
    'printf',
    'fprintf',
    'vfprintf',
    'vprintf',
    'puts',
    'fputs',
    'putchar',
    'fwrite',
    'stdout',
    'stderr',
    'hexdump',
    'bnum_dump',
    'write',
  ]);
  const violations = (text: string) =>
    [...text.matchAll(/\bU\s+(\S+)/g)].map((match) => match[1]).filter((name) =>
      forbidden.has(name)
    );
  const compiled = await new Deno.Command('nm', {
    args: ['-u', ...objects.map((name) => `helper/raop/${name}`)],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  if (
    !compiled.success ||
    violations(new TextDecoder().decode(compiled.stdout)).length
  ) throw new Error('Compiled native writer boundary violation');
  const dir = await Deno.makeTempDir({ prefix: 'logging-inventory-' });
  try {
    await Deno.writeTextFile(
      `${dir}/negative.c`,
      '#include <stdio.h>\nvoid bad(void) { fprintf(stderr, "%s", "negative-fixture"); }\n',
      { createNew: true },
    );
    const compile = await new Deno.Command('cc', {
      args: ['-c', `${dir}/negative.c`, '-o', `${dir}/negative.o`],
      stdout: 'piped',
      stderr: 'piped',
    }).output();
    if (!compile.success) {
      throw new Error('Negative native checker fixture failed to compile');
    }
    const negative = await new Deno.Command('nm', {
      args: ['-u', `${dir}/negative.o`],
      stdout: 'piped',
      stderr: 'piped',
    }).output();
    if (
      !negative.success ||
      !violations(new TextDecoder().decode(negative.stdout)).length
    ) throw new Error('Native checker did not reject raw output');
    log.event('fixture_info', {
      payload: {
        compiledNativeObjects: objects.length,
        writerViolations: 0,
        negativeRejected: true,
        debugKeyDumpsAbsent: true,
      },
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
} else if (mode === 'families') {
  const { pathfinder } = await import('@pathfinder/pathfinder');
  const { openStore } = await import('../../src/store/index.ts');
  const { facade } = await import('../../src/facade.ts');
  const { createPlayer, createOutputs } = await import('../../src/player.ts');
  const { createPlayback } = await import('../../src/playback.ts');
  const { createNowPlaying } = await import('../../src/nowplaying.ts');
  const { createLibrary } = await import('../../src/library.ts');
  const { createMedia } = await import('../../src/media.ts');
  const { createRequire } = await import('node:module');
  const { Log, AV_LOG_ERROR } = await import('node-av');
  const data = await Deno.makeTempDir({ prefix: 'logging-families-' });
  const store = await openStore(data, { debugLogQueries: true });
  const db = store.legacy;
  const playback = createPlayback({
    player: createPlayer(),
    nowPlaying: createNowPlaying(store),
    library: createLibrary(db),
    cfg: {},
  });
  const app = await pathfinder({
    roots: ['core/'],
    app: { store, cfg: {}, log },
  });
  const server = Deno.serve({
    hostname: '127.0.0.1',
    port: 0,
    onListen: ({ hostname, port }) =>
      log.event('listening', { hostname, port, kind: 'default' }),
    onError: (error) => {
      log.event('server_error', { error });
      return new Response('Internal Server Error', { status: 500 });
    },
  }, facade(app, [], { debugLogRequests: true, debugLogHeaders: true }));
  try {
    const response = await fetch(
      `http://127.0.0.1:${server.addr.port}/_/health?U=user-canary&P=query-canary`,
      { headers: { authorization: 'Bearer header-canary' } },
    );
    if (response.status !== 200 || (await response.json()).ok !== true) {
      throw new Error('HTTP consumer did not see health');
    }
    playback.setVolume({ volume: 37 }, {
      kind: 'http',
      peer: '127.0.0.1',
      user: 'attribution',
      client: 'logging-consumer',
    });
    createOutputs().register({
      id: 'fixture',
      name: 'fixture',
      type: 'AirPlay',
      selected: false,
      volume: 100,
      host: '127.0.0.1',
    });
    await db.conn.runAndReadAll("SELECT 'sql-canary' AS value");
    await createMedia().probe('tests/fixtures/library/corrupt.mp3');
    const require = createRequire(import.meta.url);
    const debug = createRequire(require.resolve('music-metadata'))('debug');
    debug('music-metadata:logging-fixture')(
      'credential/CANARY %s',
      'opaque available payload',
    );
    Log.log(AV_LOG_ERROR, 'node-av-consumer credential/CANARY\nline');
    // No flush acknowledgement exists; the parent proves delivery from captured output.
    await new Promise((resolve) => setTimeout(resolve, 200));
  } finally {
    await server.shutdown();
    await server.finished;
    playback.close();
    db.close();
    await Deno.remove(data, { recursive: true });
  }
} else if (mode === 'idle-lifecycle') {
  const { createFfiSpawn, raopFfiInternals, shutdownNativeLogging } =
    await import('../../src/boots/raop-ffi.ts');
  await import('../../src/media.ts');
  const { startFakeRaop } = await import('../helpers/fake-raop.ts');
  const { decodeReceiverAudio, pcmAt } = await import(
    '../helpers/raop-audio-consumer.ts'
  );
  const fake = await startFakeRaop({ captureAudio: true });
  const state: string[] = [];
  const delivered: { marker: string; phase: string; observedMs: number }[] = [];
  const phases: { phase: string; marker: string; automatic: boolean }[] = [];
  let phase = 'before-first-handle';
  const spawn = createFfiSpawn({
    event(id, facts) {
      log.event(id, facts);
      if (
        id === 'native_record' && 'nativeEvent' in facts &&
        facts.nativeEvent.startsWith('correction_')
      ) {
        delivered.push({
          marker: facts.nativeEvent,
          phase,
          observedMs: performance.now(),
        });
      }
    },
  });
  const library = Deno.dlopen(Deno.env.get('MELOFON_RAOP_LIB')!, {
    helper_log_event: {
      parameters: ['i32', 'i32', 'buffer', 'pointer'],
      result: 'void',
    },
    raop_log_consumer: { parameters: ['i32'], result: 'i32' },
  });
  const emit = (marker: string) =>
    library.symbols.helper_log_event(
      1,
      17,
      new TextEncoder().encode(`${marker}\0`),
      null,
    );
  const automatic = async (marker: string) => {
    emit(marker);
    const deadline = performance.now() + 500;
    while (
      !delivered.some((row) => row.marker === marker) &&
      performance.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    phases.push({
      phase,
      marker,
      automatic: delivered.some((row) =>
        row.marker === marker && row.phase === phase
      ),
    });
  };
  // A bounded delivery observation finishes before constructing any handle.
  await automatic('correction_before_first');
  phase = 'audio-handle';
  const driver = spawn((_event, value) => {
    if (value) state.push(value);
  });
  const until = async (name: string, predicate: () => boolean) => {
    const deadline = performance.now() + 15000;
    while (!predicate()) {
      if (performance.now() > deadline) {
        throw new Error(`consumer timeout: ${name}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  const pcm = new Uint8Array(44100 * 4 * 4);
  const view = new DataView(pcm.buffer);
  for (let i = 0; i < pcm.length / 4; i++) {
    const [l, r] = pcmAt(i);
    view.setInt16(i * 4, l, true);
    view.setInt16(i * 4 + 2, r, true);
  }
  try {
    await driver.start({
      requestedHost: '127.0.0.1',
      host: '127.0.0.1',
      port: fake.port,
      name: 'logging-receiver',
      service: 'logging',
      devtype: 'other',
      encrypt: false,
      wantedMetadata: 7,
      supportsAuthSetup: false,
      requiresAuth: false,
      sampleRate: 44100,
      bitsPerSample: 16,
      channels: 2,
    }, {
      volume: 100,
      positionMs: 0,
      lengthMs: 4000,
      title: 'logging-title',
      artist: 'logging-artist',
    });
    await until('connected', () => state.includes('connected'));
    const nodeAv = await import('node-av');
    nodeAv.Log.log(
      nodeAv.AV_LOG_ERROR,
      'node-av-after-raop-adapter credential/CANARY',
    );
    await driver.transport.pcm(pcm);
    await until(
      'audio and metadata',
      () =>
        (fake.sessions[0]?.audioPayloads.length ?? 0) >= 20 &&
        fake.sessions[0].parameters.some((p) =>
          p.contentType === 'application/x-dmap-tagged'
        ) && fake.sessions[0].parameters.some((p) =>
          new TextDecoder().decode(p.body).startsWith('progress:')
        ),
    );
    const session = fake.sessions[0];
    const decoded = decodeReceiverAudio(
      session.sdp,
      session.audioPayloads.slice(0, 20),
    );
    if (
      decoded.length !== 20 * 352 * 4 ||
      decoded.some((byte, i) => byte !== pcm[i])
    ) throw new Error('Receiver decoded PCM differs from source prefix');
    const metadata = session.parameters.find((p) =>
      p.contentType === 'application/x-dmap-tagged'
    )!;
    if (!new TextDecoder().decode(metadata.body).includes('logging-title')) {
      throw new Error('Receiver did not see title');
    }
    for (let i = 0; i < 100; i++) {
      library.symbols.helper_log_event(
        1,
        17,
        new TextEncoder().encode('probe_queued\0'),
        null,
      );
    }
    // The synchronous producer burst queues diagnostics before the async free barrier.
    await driver.transport.close();
    raopFfiInternals.drainLogs();
    await until('owned release', () => session.closedAtMs !== null);
    if (session.teardowns !== 1) {
      throw new Error('Owned release did not reach receiver');
    }
    phase = 'after-last-free';
    await automatic('correction_after_last_free');
    log.event('fixture_info', {
      payload: {
        outcome: 'audio_metadata_release',
        frames: decoded.length / 4,
        title: 'logging-title',
        queuedBeforeRelease: 100,
        released: true,
      },
    });
    // A new ordinary handle after last release fails against a contained closed
    // port; its diagnostics must survive failure/free through the same consumer.
    const failureStates: string[] = [];
    phase = 'new-handle';
    const failed = createFfiSpawn()((_event, value) => {
      if (value) failureStates.push(value);
    });
    try {
      await failed.start({
        requestedHost: '127.0.0.1',
        host: '127.0.0.1',
        port: 1,
        name: 'credential/CANARY',
        service: 'logging-failure',
        devtype: 'other',
        encrypt: false,
        wantedMetadata: 0,
        supportsAuthSetup: false,
        requiresAuth: false,
        sampleRate: 44100,
        bitsPerSample: 16,
        channels: 2,
      }, { volume: 100, positionMs: 0, lengthMs: 0, title: '', artist: '' });
      await until(
        'failed native session',
        () => failureStates.includes('failed'),
      );
      await automatic('correction_new_handle');
      emit('correction_queued_at_shutdown');
      await failed.transport.close();
      log.event('fixture_info', {
        payload: { outcome: 'failure_release', failed: true, released: true },
      });
    } finally {
      await failed.transport.close();
    }
    phase = 'valid-shutdown';
    shutdownNativeLogging();
    shutdownNativeLogging();
    const consumerReleased = library.symbols.raop_log_consumer(1) === 0;
    if (consumerReleased) library.symbols.raop_log_consumer(0);
    // Re-acquire through the normal factory, without constructing a handle.
    phase = 'reload-idle';
    createFfiSpawn({
      event(id, facts) {
        log.event(id, facts);
        if (
          id === 'native_record' && 'nativeEvent' in facts &&
          facts.nativeEvent.startsWith('correction_')
        ) {
          delivered.push({
            marker: facts.nativeEvent,
            phase,
            observedMs: performance.now(),
          });
        }
      },
    });
    await automatic('correction_reloaded_idle');
    shutdownNativeLogging();
    const outcome = {
      outcome: 'idle_lifecycle',
      phases,
      delivered,
      consumerReleased,
      releaseCompleted: session.closedAtMs !== null,
      queuedBeforeRelease: 100,
    };
    log.event('fixture_info', { payload: outcome });
  } finally {
    await driver.transport.close();
    fake.close();
    shutdownNativeLogging();
    library.close();
  }
} else if (mode === 'idle-exit') {
  const { createFfiSpawn } = await import('../../src/boots/raop-ffi.ts');
  createFfiSpawn();
  log.event('fixture_info', { payload: 'idle-owner-exit' });
} else throw new Error(`Unknown fixture mode ${mode}`);
await log.flush();
// Make parser qualification part of the consumer module graph, without parsing via the serializer.
if (parseLogfmt('event=fixture').event !== 'fixture') {
  throw new Error('parser qualification');
}
