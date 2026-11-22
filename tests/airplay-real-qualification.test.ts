// No imports with runtime/device side effects before the explicit opt-in. This
// is a real-speaker test, not another fake receiver or a normal scripts/test job.
import { assert, assertEquals, assertThrows } from '@std/assert';
import { isAbsolute, relative } from 'node:path';
import type {
  AirplayCompletionResult,
  AirplayRangeSnapshot,
  AirplaySourceCutoff,
  AirplayTimelineStream,
} from '../src/boots/airplay-profile.ts';
import type { CrossfadeRecord } from '../src/playback-mix.ts';

interface QualificationConfig {
  dataDir: string;
  evidenceDir: string;
  receiverId: string;
  receiverHost: string;
  receiverPort: number;
  receiverModel: string;
  firmware: string;
  credentialRequirement: 'none' | 'password' | 'pairing-key';
  volume: number;
}

function outside(root: string, path: string) {
  const part = relative(root, path);
  return isAbsolute(part) || part === '..' || part.startsWith('../');
}

async function configuration(): Promise<QualificationConfig> {
  const path = Deno.env.get('MELOFON_QUALIFICATION_CONFIG');
  assert(
    path && isAbsolute(path),
    'Set an absolute private qualification config path',
  );
  const root = await Deno.realPath('.');
  assert(
    outside(root, await Deno.realPath(path)),
    'Private config must be outside the checkout',
  );
  const stat = await Deno.stat(path);
  assert(
    stat.isFile && stat.mode !== null && (stat.mode & 0o777) === 0o600,
    'Private config must have mode 0600',
  );
  const config = JSON.parse(
    await Deno.readTextFile(path),
  ) as QualificationConfig;
  for (
    const key of [
      'dataDir',
      'evidenceDir',
      'receiverId',
      'receiverHost',
      'receiverModel',
      'firmware',
    ] as const
  ) {
    assert(
      typeof config[key] === 'string' && config[key].trim().length > 0,
      `Missing ${key}`,
    );
  }
  assert(
    Number.isInteger(config.receiverPort) && config.receiverPort > 0 &&
      config.receiverPort <= 65535,
    'Invalid receiverPort',
  );
  assert(
    Number.isInteger(config.volume) && config.volume >= 0 &&
      config.volume <= 100,
    'Choose volume explicitly (0-100)',
  );
  assert(
    ['none', 'password', 'pairing-key'].includes(config.credentialRequirement),
    'Declare the receiver credential requirement',
  );
  for (const key of ['dataDir', 'evidenceDir'] as const) {
    assert(isAbsolute(config[key]), `${key} must be absolute`);
    config[key] = await Deno.realPath(config[key]);
    assert(outside(root, config[key]), `${key} must be outside the checkout`);
  }
  assert(
    outside(config.dataDir, config.evidenceDir) &&
      outside(config.evidenceDir, config.dataDir),
    'Keep private data separate from evidence',
  );
  await Deno.stat(`${config.dataDir}/melofon.duckdb`);
  assert(Deno.env.get('TMPDIR'), 'Set TMPDIR to the VM disk-backed workspace');
  return config;
}

// DNS and TCP reachability share one cancellable deadline; no detached connect
// can start playback after an unavailable outcome or outlive fixture cleanup.
async function reachable(hostname: string, port: number) {
  try {
    const socket = await Deno.connect({
      hostname,
      port,
      signal: AbortSignal.timeout(5000),
    });
    socket.close();
    return true;
  } catch {
    return false;
  }
}

// Native completion is retained until acknowledgment. Reading it again is not
// another completion; preserve the identity and reject conflicting observations.
function rememberCompletion(
  receipts: Map<string, AirplayCompletionResult>,
  result: AirplayCompletionResult,
) {
  const key = [
    result.streamId,
    result.epoch,
    result.source,
    result.target,
    result.revision,
  ].join('/');
  const previous = receipts.get(key);
  if (previous) assertEquals(result, previous, 'Retained receipt changed');
  else receipts.set(key, result);
}

function assertRealTailCovered(
  receipts: readonly {
    transportEnd: bigint;
    attachments: readonly {
      scheduledFrames: bigint;
      submittedFrames: bigint;
    }[];
  }[],
  end: bigint,
) {
  assert(
    receipts.some((receipt) =>
      receipt.transportEnd >= end && receipt.attachments.length > 0 &&
      receipt.attachments.every((peer) =>
        peer.scheduledFrames >= end && peer.submittedFrames >= end
      )
    ),
    'A terminal receipt and its peers must cover the full real tail',
  );
}

function overlapAdmitted(
  records: readonly CrossfadeRecord[],
  chunks: readonly Uint8Array[],
  expectedPrefix: Uint8Array,
) {
  if (
    !records.some((r) => r.appliedFrames === 4410n) ||
    chunks.reduce((n, chunk) => n + chunk.length, 0) < expectedPrefix.length
  ) return false;
  let offset = 0;
  for (const chunk of chunks) {
    const count = Math.min(chunk.length, expectedPrefix.length - offset);
    assertEquals(
      chunk.subarray(0, count),
      expectedPrefix.subarray(offset, offset + count),
    );
    offset += count;
    if (offset === expectedPrefix.length) break;
  }
  return true;
}

Deno.test('real qualification requires terminal coverage without extending earlier source receipts', () => {
  const receipt = (
    transportEnd: bigint,
    scheduledFrames = transportEnd,
    submittedFrames = transportEnd,
  ) => ({
    transportEnd,
    attachments: [{ scheduledFrames, submittedFrames }],
  });
  assertRealTailCovered([receipt(5n), receipt(10n)], 10n);
  for (
    const clipped of [receipt(9n), receipt(10n, 9n), receipt(10n, 10n, 9n)]
  ) {
    assertThrows(() => assertRealTailCovered([receipt(5n), clipped], 10n));
  }
});

Deno.test('real qualification waits for positive overlap and exact native prefix admission', () => {
  const record: CrossfadeRecord = {
    outgoingEntryId: 1,
    incomingEntryId: 2,
    requestedFrames: 4410n,
    appliedFrames: 4410n,
    reason: 'applied',
  };
  const prefix = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  assertEquals(overlapAdmitted([], [prefix], prefix), false);
  assertEquals(
    overlapAdmitted([{ ...record, appliedFrames: 0n }], [prefix], prefix),
    false,
  );
  assertEquals(
    overlapAdmitted([record], [prefix.subarray(0, 4)], prefix),
    false,
  );
  assertEquals(
    overlapAdmitted(
      [record],
      [prefix.subarray(0, 4), prefix.subarray(4)],
      prefix,
    ),
    true,
  );
  assertThrows(() => overlapAdmitted([record], [new Uint8Array(8)], prefix));
});

Deno.test('real qualification counts immutable receipt identities, not reads', () => {
  const receipts = new Map<string, AirplayCompletionResult>();
  const result: AirplayCompletionResult = {
    streamId: 1n,
    epoch: 1n,
    source: 1n,
    target: 353n,
    revision: 1n,
    inputEnd: 353n,
    status: 'complete',
    error: 'none',
    transportEnd: 353n,
    capturedNs: 100n,
    required: 1n,
    attachments: [],
  };
  rememberCompletion(receipts, result);
  rememberCompletion(receipts, structuredClone(result));
  assertEquals(receipts.size, 1);
  for (
    const field of [
      'streamId',
      'epoch',
      'source',
      'target',
      'revision',
    ] as const
  ) {
    rememberCompletion(receipts, { ...result, [field]: result[field] + 1n });
  }
  assertEquals(receipts.size, 6);
  assertThrows(
    () => rememberCompletion(receipts, { ...result, capturedNs: 101n }),
    Error,
    'Retained receipt changed',
  );
  assertEquals(receipts.get('1/1/1/353/1'), result);
});

Deno.test({
  name:
    'real AirPlay qualification: UNVERIFIED unless explicitly enabled in a code-mounted VM',
  ignore: Deno.env.get('MELOFON_QUALIFY_REAL') !== '1',
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    const config = await configuration();
    // A fresh directory is never overwritten. Only allowlisted protocol facts
    // go into it; the config, credentials, tokens and raw RTSP are never copied.
    const evidence = await Deno.makeTempDir({
      dir: config.evidenceDir,
      prefix: 'airplay-qualification-',
    });
    const events: { elapsedMs: number; kind: string; facts: unknown }[] = [];
    const began = performance.now();
    const observe = (kind: string, facts: unknown) =>
      events.push({ elapsedMs: performance.now() - began, kind, facts });
    let status = 'failed';
    let phase = 'configuration';
    const report = {
      receiver: {
        id: config.receiverId,
        model: config.receiverModel,
        firmware: config.firmware,
        identitySource:
          'operator configuration; live profile recorded separately',
      },
      protocol: 'RAOP / AirPlay 1, ALAC 44100 Hz s16 stereo',
      scope: {
        nativeAcceptanceAndScheduledSubmission: 'pending',
        receiverRenderedPcmAndPrefix: 'unverified: no receiver audio capture',
        audibleTailsAndCrossfade:
          'unverified: no authorized listening outcome supplied',
        physicalMultiRoomAndSynchronization: 'unverified: one receiver only',
      },
    };
    const save = () =>
      Deno.writeTextFile(
        `${evidence}/qualification.json`,
        JSON.stringify({ status, phase, ...report, events }, (_key, value) =>
          typeof value === 'bigint' ? value.toString() : value, 2),
      );
    console.log(`Real qualification evidence: ${evidence}`);
    const { createReleaseSet, releaseOrThrow } = await import(
      '../src/releases.ts'
    );
    const owned = createReleaseSet();
    const unavailable = Symbol('unavailable');
    let failure: { error: unknown } | undefined;
    try {
      const { openStore } = await import('../src/store/index.ts');
      const privateStore = await openStore(config.dataDir);
      owned.add('private credential store', () => privateStore.close(), 100);
      const saved = (await privateStore.speakers.loadAdopted()).find((row) =>
        row.id === config.receiverId
      );
      assert(
        saved,
        'Receiver must already be adopted in the private test database',
      );
      assertEquals([saved.host, saved.port ?? 7000], [
        config.receiverHost,
        config.receiverPort,
      ], 'Explicit target must match the saved receiver');
      // Do not start a household server against this data: the test reads only
      // this receiver through the existing credential owner, into a fresh graph.
      const { createOutputs } = await import('../src/player.ts');
      const { createSpeakerCredentials } = await import(
        '../src/speaker-credentials.ts'
      );
      const { createSecrets } = await import('../src/secrets.ts');
      let outputs = createOutputs();
      outputs.restore({
        ...saved,
        selected: false,
        playerId: null,
        volume: config.volume,
        connectionStrategy: 'owntone',
      });
      const credentials = createSpeakerCredentials({
        store: privateStore.speakers,
        secrets: createSecrets(Deno.env.get('MELOFON_SECRET')),
        current: (id) =>
          outputs.get(id)
            ? { revision: outputs.revision(id), adopted: true }
            : null,
      });
      phase = 'credentials';
      const credential = await credentials.session(config.receiverId);
      if (
        config.credentialRequirement !== 'none' &&
        !(config.credentialRequirement === 'password'
          ? credential.password !== null
          : credential.pairingKey !== null)
      ) {
        status = 'missing-credentials';
        throw new Error(
          'Configure required credentials locally before qualification',
        );
      }
      observe('credential-preflight', {
        requirement: config.credentialRequirement,
        available: true,
      });
      phase = 'reachability';
      if (!await reachable(config.receiverHost, config.receiverPort)) {
        status = 'unverified-unreachable';
        observe('dns-tcp-unavailable', { timeoutMs: 5000 });
        await t.step({
          name: 'hardware UNVERIFIED: DNS/RTSP endpoint unavailable',
          ignore: true,
          fn() {},
        });
        throw unavailable;
      }
      // After TCP reachability, discovery/auth/media/transport failures fail the
      // test. Never relabel a reachable but broken receiver as unavailable.
      observe('dns-tcp-reachable', {});
      phase = 'household';
      const { apiFixture } = await import('./helpers/api.ts');
      const { createPlayers } = await import('../src/players.ts');
      const { createPersistence } = await import('../src/persistence.ts');
      const { createPlaybackReports } = await import(
        '../src/playback-reports.ts'
      );
      const { createLibrary } = await import('../src/library.ts');
      const { createLibraries } = await import('../src/libraries.ts');
      const { createNowPlaying } = await import('../src/nowplaying.ts');
      const { scanLibrary } = await import('../src/scan.ts');
      const { createQueueResolver } = await import('../src/queue-source.ts');
      const { createSpeakers } = await import('../src/speakers.ts');
      const { createAirplayDevices } = await import(
        '../src/boots/airplay-device.ts'
      );
      const { createAirplayBoot } = await import('../src/boots/airplay.ts');
      const { createFfiStream, shutdownNativeLogging } = await import(
        '../src/boots/raop-ffi.ts'
      );
      const { createMedia } = await import('../src/media.ts');
      const { wave, exact } = await import('./helpers/concurrent-playback.ts');
      const { concatenate, timelineUntil } = await import(
        './helpers/timeline-proof.ts'
      );
      const { crossfadeReference } = await import(
        './helpers/crossfade-proof.ts'
      );
      owned.add('native logging', shutdownNativeLogging, 50);
      const library = await Deno.realPath('helper/raop/libmelofon_raop.so');
      assertEquals(
        await Deno.realPath(Deno.env.get('MELOFON_RAOP_LIB')!),
        library,
      );
      const hash = new Uint8Array(
        await crypto.subtle.digest('SHA-256', await Deno.readFile(library)),
      );
      observe('production-library', {
        path: library,
        sha256: Array.from(hash, (v) => v.toString(16).padStart(2, '0')).join(
          '',
        ),
      });
      const directory = await Deno.makeTempDir({
        prefix: 'real-qualification-',
      });
      owned.add(
        'scratch',
        () => Deno.remove(directory, { recursive: true }),
        110,
      );
      await Deno.mkdir(`${directory}/media`);
      const tails = [1, 351, 352, 353, 441];
      // A packet-aligned intro keeps declared catalog durations positive. A
      // one-frame catalog item rounds to 0 ms and intentionally cannot auto-end.
      const lengths = [
        ...tails.map((n) => 352 * 126 + n),
        44100 * 3 + 353,
        44100 * 3 + 351,
        44100 * 6 + 137,
      ];
      // Low-amplitude, deterministic stereo patterns; volume is operator chosen.
      const waves = lengths.map((frames, i) => wave(frames, i + 1));
      for (const [i, wav] of waves.entries()) {
        const view = new DataView(wav.buffer);
        for (let at = 44; at < wav.length; at += 2) {
          view.setInt16(at, Math.trunc(view.getInt16(at, true) / 16), true);
        }
        await Deno.writeFile(`${directory}/media/${i}.wav`, wav);
      }
      const traces: {
        stream: AirplayTimelineStream;
        epochs: Map<bigint, Uint8Array[]>;
        completions: Map<string, AirplayCompletionResult>;
        cutoffs: AirplaySourceCutoff[];
        drained: Set<bigint>;
        origins: { epoch: bigint; originFrame: bigint }[];
        ranges: Map<bigint, AirplayRangeSnapshot[]>;
      }[] = [];
      const fades: CrossfadeRecord[] = [];
      let players!: Awaited<ReturnType<typeof createPlayers>>;
      let songIds: string[] = [];
      const f = await apiFixture({
        localOperator: true,
        services: async (f) => {
          assert(f.notify);
          const libraries = createLibraries(f.store);
          await libraries.add(
            'Real qualification fixtures',
            `${directory}/media`,
          );
          await scanLibrary(f.store);
          const library = createLibrary(f.store),
            nowPlaying = createNowPlaying(f.store);
          const songs = await library.listSongs({ offset: 0, size: 100 });
          songIds = lengths.map((_, i) =>
            songs.find((s) => s.path.endsWith(`/${i}.wav`))!.id
          );
          const persistence = createPersistence(f.store);
          owned.add('persistence', persistence.close, 20);
          outputs = createOutputs({ notify: f.notify, persistence });
          outputs.restore({
            ...saved,
            selected: false,
            playerId: null,
            volume: config.volume,
            connectionStrategy: 'owntone',
          });
          await outputs.adopt(config.receiverId);
          const devices = createAirplayDevices({
            outputs,
            credentials,
            stream(): AirplayTimelineStream {
              const native = createFfiStream();
              const trace = {
                stream: native,
                epochs: new Map<bigint, Uint8Array[]>(),
                completions: new Map<string, AirplayCompletionResult>(),
                cutoffs: [] as AirplaySourceCutoff[],
                drained: new Set<bigint>(),
                origins: [] as { epoch: bigint; originFrame: bigint }[],
                ranges: new Map<bigint, AirplayRangeSnapshot[]>(),
              };
              traces.push(trace);
              return {
                ...native,
                get epoch() {
                  return native.epoch;
                },
                attach(event, credential) {
                  const driver = native.attach((kind, value) => {
                    // Event values can contain credentials; retain event names only.
                    observe('native-device-event', { kind });
                    event(kind, value);
                  }, credential);
                  return {
                    ...driver,
                    start(profile, ...args) {
                      observe('live-receiver-profile', {
                        model: profile.model,
                        service: profile.service,
                        encrypt: profile.encrypt,
                        requiresAuth: profile.requiresAuth,
                        hasPassword: profile.hasPassword,
                        sampleRate: profile.sampleRate,
                      });
                      return driver.start(profile, ...args);
                    },
                  };
                },
                async appendSource(input) {
                  const result = await native.appendSource(input);
                  if (result.acceptedFrames > 0n) {
                    const chunks = trace.epochs.get(input.epoch) ?? [];
                    chunks.push(
                      input.pcm.slice(0, Number(result.acceptedFrames) * 4),
                    );
                    trace.epochs.set(input.epoch, chunks);
                  }
                  observe('native-append', result);
                  return result;
                },
                async metadata(input) {
                  trace.origins.push({
                    epoch: input.epoch,
                    originFrame: input.originFrame,
                  });
                  observe('source-origin', {
                    epoch: input.epoch,
                    source: input.source,
                    originFrame: input.originFrame,
                  });
                  return await native.metadata(input);
                },
                async waitCompletion(key) {
                  const result = await native.waitCompletion(key);
                  const ranges: AirplayRangeSnapshot[] = [];
                  for (let i = 0n; result.status === 'complete'; i++) {
                    const range = await native.range(key.epoch, i);
                    if (!range) break;
                    ranges.push(range);
                  }
                  trace.ranges.set(key.epoch, [
                    ...(trace.ranges.get(key.epoch) ?? []),
                    ...ranges,
                  ]);
                  observe('native-ranges-at-completion', {
                    epoch: key.epoch,
                    ranges,
                  });
                  rememberCompletion(trace.completions, result);
                  observe('native-completion', result);
                  return result;
                },
                async waitDrain(epoch) {
                  await native.waitDrain(epoch);
                  trace.drained.add(epoch);
                  observe('native-drained', { epoch });
                },
                cancelSource(epoch, source, retire, capture) {
                  return native.cancelSource(
                    epoch,
                    source,
                    retire,
                    (cutoff) => {
                      trace.cutoffs.push(cutoff);
                      observe('native-cutoff', cutoff);
                      capture?.(cutoff);
                    },
                  );
                },
              };
            },
          });
          owned.add('devices', devices.close, 10);
          const speakers = createSpeakers({
            outputs,
            adapterView: devices.describe,
            prepare: devices.preparePlayback,
          });
          const reports = createPlaybackReports({
            library,
            nowPlaying,
            notify: f.notify,
            serverRows: () => players.serverRows(),
          });
          owned.add('reports', reports.close, 10);
          const media = createMedia();
          owned.add('media', () => media.close(), 10);
          players = await createPlayers({
            store: f.store,
            persistence,
            outputs,
            reports,
            notify: f.notify,
            capacity: devices.capacity,
            maxResumeAgeMs: 0,
            playback: {
              library,
              nowPlaying,
              cfg: f.cfg,
              resolveQueueReference: createQueueResolver({
                getSong: library.getSong,
                getStation: () => Promise.resolve(null),
              }),
            },
            targets: (id) => ({
              hasPlaybackTarget: () => speakers.hasPlaybackTarget(id),
              preparePlayback: (signal) => speakers.preparePlayback(signal, id),
            }),
            createBoot: (playerId, playback, outputs, capacity) =>
              createAirplayBoot({
                playerId,
                playback,
                outputs,
                capacity,
                devices,
                media,
                notify: f.notify!,
                retryBackoffMs: [],
                crossfadeObserved(record) {
                  fades.push(record);
                  observe('crossfade', record);
                },
              }),
          });
          owned.add('players', players.close, 0);
          return {
            players,
            playback: players.playback,
            outputs,
            library,
            speakers,
          };
        },
      });
      owned.add('http/store', f.close, 90);
      const ips = await Deno.resolveDns('melofon.home', 'A');
      assert(
        ips.length > 0 && ips.every((ip) => !ip.startsWith('127.')),
        'Use non-loopback plain HTTP inside the VM',
      );
      const { credential: bearer } = await f.login('bearer');
      const call = async (path: string, method = 'GET', body?: unknown) => {
        const response = method === 'GET'
          ? await f.get(`/api/v1${path}`, bearer)
          : await f.json(`/api/v1${path}`, method, body, bearer);
        const text = await response.text();
        observe('http', { path, method, status: response.status });
        assert(
          response.ok,
          `Qualification HTTP ${method} ${path} failed (${response.status})`,
        );
        return text ? JSON.parse(text) : undefined;
      };
      const current = async () => {
        const player = (await call('/players/1')).player;
        observe('public-player', {
          state: player.state,
          positionMs: player.positionMs,
          entryId: player.current?.entryId,
          crossfadeMs: player.crossfadeMs,
        });
        return player;
      };
      const command = (kind: string, body: unknown = {}) =>
        call(`/players/1/${kind}`, 'POST', body);
      await call(
        `/players/1/speakers/${encodeURIComponent(config.receiverId)}`,
        'PUT',
        {},
      );
      const queue = async (indices: number[], crossfadeMs = 0) => {
        await call('/players/1/queue', 'DELETE');
        await call('/players/1', 'PATCH', {
          repeat: 'off',
          consume: false,
          crossfadeMs,
        });
        await call('/players/1/queue/items', 'POST', {
          references: indices.map((i) => ({ kind: 'song', id: songIds[i] })),
        });
      };
      const claimed = new Set<string>();
      const fresh = (tr: typeof traces[number]) =>
        tr.epochs.has(tr.stream.epoch) &&
        !claimed.has(`${tr.stream.id}/${tr.stream.epoch}`);
      const active = async () => {
        await timelineUntil(
          'new epoch accepted PCM',
          () => traces.some(fresh),
          30000,
        );
        const tr = traces.findLast(fresh)!;
        claimed.add(`${tr.stream.id}/${tr.stream.epoch}`);
        return { tr, epoch: tr.stream.epoch };
      };
      const finish = async (
        name: string,
        expected: Uint8Array,
        run: Awaited<ReturnType<typeof active>>,
        count: number,
      ) => {
        const { tr, epoch } = run;
        await timelineUntil(
          `${name}: full native scheduled tail and drain`,
          async () =>
            (await current()).state === 'stop' && tr.drained.has(epoch),
          30000,
        );
        const receipts = [...tr.completions.values()].filter((r) =>
          r.epoch === epoch
        );
        assertEquals(receipts.length, count);
        for (const receipt of receipts) {
          assertEquals(receipt.status, 'complete');
          assertEquals(receipt.error, 'none');
          assertEquals(receipt.attachments.length, 1);
          const peer = receipt.attachments[0];
          assertEquals([peer.outcome, peer.excluded, peer.coverageStart], [
            'complete',
            false,
            0n,
          ]);
          assert(
            peer.scheduledFrames >= receipt.transportEnd &&
              peer.submittedFrames >= receipt.transportEnd,
            'Entire real tail has scheduled submission coverage',
          );
        }
        const sessions = new Set(
          receipts.map((r) =>
            `${r.streamId}/${r.epoch}/${r.attachments[0].attachment}/${
              r.attachments[0].session
            }`
          ),
        );
        assertEquals(
          sessions.size,
          1,
          'Natural A/B uses the same native receiver session and epoch',
        );
        const accepted = concatenate(tr.epochs.get(epoch)!);
        await Deno.writeFile(`${evidence}/${name}-accepted.s16le`, accepted);
        await Deno.writeFile(`${evidence}/${name}-expected.s16le`, expected);
        exact(accepted, expected);
        const ranges = new Map(
          (tr.ranges.get(epoch) ?? []).map((r) => [r.transportStart, r]),
        );
        let end = 0n;
        for (
          const range of [...ranges.values()].filter((r) => r.kind === 'real')
            .sort((a, b) => Number(a.transportStart - b.transportStart))
        ) {
          assertEquals(
            range.transportStart,
            end,
            'No undeclared transport gap or inter-item silence',
          );
          end += range.frames;
        }
        assertEquals(
          end,
          BigInt(expected.length / 4),
          'Range accounting includes the full tail',
        );
        // Earlier source receipts freeze before later audio is scheduled.
        // The terminal receipt must independently cover the actual real end.
        assertRealTailCovered(receipts, end);
        observe('scenario-passed', {
          name,
          expectedFrames: expected.length / 4,
          receipts: count,
          session: [...sessions][0],
          prefixProofBoundary:
            'exact native accepted PCM, not receiver-rendered audio',
        });
      };
      phase = 'nonaligned-short-tails';
      for (let i = 0; i < 5; i++) {
        await queue([i]);
        await command('play');
        await finish(
          `tail-${tails[i]}`,
          waves[i].subarray(44),
          await active(),
          1,
        );
      }
      phase = 'natural-gapless';
      await queue([5, 6]);
      await command('play');
      await finish(
        'natural-ab',
        concatenate([waves[5].subarray(44), waves[6].subarray(44)]),
        await active(),
        2,
      );
      phase = 'natural-crossfade';
      await queue([5, 6], 100);
      const previousFades = fades.length;
      await command('play');
      await finish(
        'crossfade-ab',
        crossfadeReference([waves[5].subarray(44), waves[6].subarray(44)], 4410)
          .pcm,
        await active(),
        2,
      );
      assertEquals(fades.slice(previousFades).map((r) => r.appliedFrames), [
        4410n,
      ]);
      phase = 'manual-next-prefix';
      await queue([5, 6], 100);
      const nextFades = fades.length;
      await command('play');
      const beforeNext = await active();
      const mixedPrefix = crossfadeReference(
        [waves[5].subarray(44), waves[6].subarray(44)],
        4410,
      ).pcm.subarray(0, lengths[5] * 4);
      await timelineUntil(
        'accepted future overlap',
        () =>
          overlapAdmitted(
            fades.slice(nextFades),
            beforeNext.tr.epochs.get(beforeNext.epoch) ?? [],
            mixedPrefix,
          ),
        30000,
      );
      await command('next');
      const next = await active();
      assert(next.epoch !== beforeNext.epoch || next.tr !== beforeNext.tr);
      await finish('manual-next-prefix', waves[6].subarray(44), next, 1);
      phase = 'seek-stop-resume';
      await queue([7], 100);
      await command('play');
      await active();
      await timelineUntil(
        'scheduled source progression',
        async () => (await current()).positionMs > 100,
        30000,
      );
      await command('seek', { positionMs: 1000 });
      const sought = await active();
      await timelineUntil(
        'seek origin',
        () =>
          sought.tr.origins.some((m) =>
            m.epoch === sought.epoch && m.originFrame === 44100n
          ),
        30000,
      );
      await timelineUntil(
        'scheduled seek progression',
        async () => (await current()).positionMs > 1100,
        30000,
      );
      await command('stop');
      const bookmark = await current();
      assertEquals(bookmark.state, 'pause');
      const cutoff = sought.tr.cutoffs.findLast((c) =>
        c.epoch === sought.epoch
      )!;
      assert(cutoff, 'Stop captures an immutable native cutoff');
      assertEquals(
        bookmark.positionMs,
        1000 + Math.floor(Number(cutoff.progress.sourceFrames) * 1000 / 44100),
      );
      const seekPrefix = concatenate(sought.tr.epochs.get(sought.epoch)!);
      exact(
        seekPrefix,
        waves[7].subarray(44 + 44100 * 4, 44 + 44100 * 4 + seekPrefix.length),
      );
      await Deno.writeFile(
        `${evidence}/seek-accepted-prefix.s16le`,
        seekPrefix,
      );
      // A held stopped bookmark must not extrapolate while connections release.
      await new Promise((done) => setTimeout(done, 250));
      assertEquals((await current()).positionMs, bookmark.positionMs);
      await command('play');
      const resumed = await active();
      const origin = Math.round(bookmark.positionMs * 44100 / 1000);
      await finish(
        'stop-resume-prefix',
        waves[7].subarray(44 + origin * 4),
        resumed,
        1,
      );
      assert(
        (await Deno.readTextFile('/proc/self/maps')).split('\n').some((line) =>
          line.endsWith(` ${library}`)
        ),
        'Shipping library is actually mapped',
      );
      report.scope.nativeAcceptanceAndScheduledSubmission =
        'passed: exact PCM admission, native per-session scheduled receipts and HTTP commands';
      status = 'protocol-passed-sound-unverified';
    } catch (error) {
      if (error !== unavailable) {
        failure = { error };
        observe('failure', {
          phase,
          type: error instanceof Error ? error.name : 'unknown',
        });
      }
    } finally {
      try {
        await releaseOrThrow(owned, 'Real qualification cleanup failed');
        observe('cleanup-joined', {});
      } catch (error) {
        status = 'failed';
        observe('cleanup-failed', {});
        failure = {
          error: new AggregateError([
            ...(failure ? [failure.error] : []),
            error,
          ], 'Real qualification or cleanup failed'),
        };
      }
      try {
        await save();
      } catch (error) {
        status = 'failed';
        failure = {
          error: new AggregateError([
            ...(failure ? [failure.error] : []),
            error,
          ], 'Qualification evidence could not be saved'),
        };
      }
      console.log(
        `Real AirPlay qualification: ${status}; receiver-rendered prefix, sound and multi-room sync remain UNVERIFIED`,
      );
    }
    if (failure) throw failure.error;
  },
});
