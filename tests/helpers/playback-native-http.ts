// Cold plain-HTTP control -> real file decoder -> production boot -> native RAOP.
import { assert, assertEquals } from '@std/assert';
import { fixturePcm } from './decoded-pcm.ts';
import { apiFixture } from './api.ts';
import { createMedia } from '../../src/media.ts';
import { createLibrary } from '../../src/library.ts';
import { createLibraries } from '../../src/libraries.ts';
import { scanLibrary } from '../../src/scan.ts';
import { createOutputs, createPlayer, planRestore } from '../../src/player.ts';
import { catalogMedia } from '../../src/queue-source.ts';
import { createPlayback } from '../../src/playback.ts';
import { createNowPlaying } from '../../src/nowplaying.ts';
import { createAirplayBoot } from '../../src/boots/airplay.ts';
import { createFfiStream } from '../../src/boots/raop-ffi.ts';
import { createTestAirplayDevices } from './airplay-devices.ts';
import { startFakeRaop } from './fake-raop.ts';
import { wireInt } from '../../layers/owntone/payloads.ts';
import { traceTimelineAudio } from './raop-timeline-audio.ts';
import type { PlaybackSource } from '../../src/player.ts';
import type { QueueMedia, QueueReference } from '../../src/queue-source.ts';
import type {
  AirplayCompletionKey,
  AirplayCompletionResult,
  AirplayTimelineStream,
} from '../../src/boots/airplay-profile.ts';
import { createPlaybackSource } from '../../src/playback-source.ts';
import { createRadioSource } from '../../src/radio-source.ts';
import { createNetwork } from '../../src/lookups/net.ts';
import { httpRadio } from './http-radio.ts';
import type { RadioReply } from './http-radio.ts';
import type { SourceMetadata } from '../../src/queue-source.ts';
import { createPersistence } from '../../src/persistence.ts';
import type {
  AirplaySourceCancelResult,
  AirplaySourceCutoff,
} from '../../src/boots/airplay-profile.ts';

export async function nativeHttpFixture(options: {
  pcm: Uint8Array;
  additionalPcm?: Uint8Array[];
  titles?: string[];
  durations?: (number | null)[];
  metadata?: boolean;
  radioReply?: (wav: Uint8Array) => RadioReply;
  metadataObserved?: (metadata: SourceMetadata, sourceFrame: bigint) => void;
  declaredMs?: number | null;
  acquisition?: Promise<void>;
  web?: 'finite' | 'live';
  afterFirstChunk?: Promise<void>;
  receiver?: Parameters<typeof startFakeRaop>[0];
  receiverCount?: number;
  receiverSelection?: boolean[];
  beforeDecode?: (path: string, startMs: number) => Promise<void>;
  afterDecodedChunk?: (path: string, frames: bigint) => Promise<void>;
  persist?: boolean;
  directory?: string;
  storeDir?: string;
  restore?: boolean;
  targetChecks?: boolean;
  completionProgress?: () => Promise<void>;
  cutoffCapture?: Promise<void>;
  seekAdmitted?: (positionMs: number) => void;
  sourcePath?: string;
  sourceOpened?: (source: PlaybackSource) => void;
  resolveSource?: (
    reference: QueueReference,
    resolve: () => Promise<QueueMedia | null>,
  ) => Promise<QueueMedia | null>;
  crossfadeMs?: () => number;
  crossfadeObserved?: Parameters<
    typeof createAirplayBoot
  >[0]['crossfadeObserved'];
  append?: (
    request: Parameters<AirplayTimelineStream['appendSource']>[0],
    append: AirplayTimelineStream['appendSource'],
  ) => ReturnType<AirplayTimelineStream['appendSource']>;
}) {
  const directory = options.directory ??
    await Deno.makeTempDir({ prefix: 'native-http-' });
  await Deno.mkdir(`${directory}/media`, { recursive: true });
  const wav = new Uint8Array(44 + options.pcm.length);
  const view = new DataView(wav.buffer), text = new TextEncoder();
  wav.set(text.encode('RIFF'), 0);
  view.setUint32(4, wav.length - 8, true);
  wav.set(text.encode('WAVEfmt '), 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, 44100, true);
  view.setUint32(28, 176400, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 16, true);
  wav.set(text.encode('data'), 36);
  view.setUint32(40, options.pcm.length, true);
  wav.set(options.pcm, 44);
  if (options.sourcePath) {
    await Deno.copyFile(
      options.sourcePath,
      `${directory}/media/source.${options.sourcePath.split('.').pop()}`,
    );
  } else await Deno.writeFile(`${directory}/media/source.wav`, wav);
  for (const [i, pcm] of (options.additionalPcm ?? []).entries()) {
    const file = new Uint8Array(44 + pcm.length);
    file.set(wav.subarray(0, 44));
    const header = new DataView(file.buffer);
    header.setUint32(4, file.length - 8, true);
    header.setUint32(40, pcm.length, true);
    file.set(pcm, 44);
    await Deno.writeFile(`${directory}/media/next-${i}.wav`, file);
  }
  const receivers = await Promise.all(
    Array.from({ length: options.receiverCount ?? 1 }, () =>
      startFakeRaop({
        captureAudio: true,
        captureWire: true,
        ...options.receiver,
      })),
  );
  const receiver = receivers[0];
  let playback!: ReturnType<typeof createPlayback>;
  let boot!: ReturnType<typeof createAirplayBoot>;
  let devices!: ReturnType<typeof createTestAirplayDevices>;
  let outputOwner!: ReturnType<typeof createOutputs>;
  let timer: ReturnType<typeof setInterval> | undefined;
  let opens = 0, songId = '';
  let songIds: string[] = [];
  const published = new Set<PlaybackSource>();
  let unsubscribePlaying: (() => void) | undefined;
  const origins: number[] = [], cutoffs: AirplaySourceCancelResult[] = [];
  const capturedCutoffs: AirplaySourceCutoff[] = [], cancelAcks: bigint[] = [];
  const cancelTimes: { before: number; after: number }[] = [];
  let persistence: ReturnType<typeof createPersistence> | undefined;
  let native!: AirplayTimelineStream, token: PlaybackSource | undefined;
  let key: AirplayCompletionKey | undefined;
  const ackStates: { state: string; generation: number }[] = [];
  const completions: AirplayCompletionResult[] = [];
  const audio = traceTimelineAudio(() => {
    native = createFfiStream();
    return {
      ...native,
      appendSource: (request) =>
        options.append
          ? options.append(request, native.appendSource)
          : native.appendSource(request),
      async waitCompletion(key) {
        const result = await native.waitCompletion(key);
        completions.push(result);
        return result;
      },
      async progress(epoch, source) {
        const result = await native.progress(epoch, source);
        if (
          options.completionProgress && key &&
          (await native.pollCompletion(key))?.status === 'complete'
        ) await options.completionProgress();
        return result;
      },
      get epoch() {
        return native.epoch;
      },
      async seal(epoch, source, target) {
        const result = await native.seal(epoch, source, target);
        if (result.status === 'accepted') {
          key = { epoch, source, target, revision: 1n };
        }
        return result;
      },
      async ackCompletion(key) {
        ackStates.push(playback.playerView());
        await native.ackCompletion(key);
      },
      async cancelSource(...args) {
        const before = receiver.nowMs();
        const [epoch, source, retire, capture] = args;
        let captured: Promise<void> | undefined;
        const pending = native.cancelSource(epoch, source, retire, (cutoff) => {
          capturedCutoffs.push(cutoff);
          if (options.cutoffCapture) {
            captured = options.cutoffCapture.then(() => capture?.(cutoff));
            void captured.catch(() => {});
          } else capture?.(cutoff);
        });
        cancelTimes.push({ before, after: receiver.nowMs() });
        const result = await pending;
        await captured;
        cutoffs.push(result);
        return result;
      },
      async ackCancel(epoch) {
        await native.ackCancel(epoch);
        cancelAcks.push(epoch);
      },
    };
  });
  const radio = options.web
    ? httpRadio(() =>
      options.radioReply?.(wav) ?? ({
        headers: {
          'content-type': 'audio/wav',
          ...(options.web === 'live'
            ? { 'icy-name': 'Finite live response' }
            : {}),
        },
        body: [wav],
      })
    )
    : undefined;
  const f = await apiFixture({
    storeDir: options.storeDir,
    hats: {
      layersRoot: 'layers',
      extraPorts: 1,
      env: ([port]) => ({ MELOFON_LISTEN_owntone: `${port},${port}` }),
    },
    services: async (f) => {
      assert(f.notify);
      const libraries = createLibraries(f.store);
      if (!(await libraries.list()).length) {
        await libraries.add('Native gate', `${directory}/media`);
      }
      await scanLibrary(f.store);
      const catalog = createLibrary(f.store);
      const songs = await catalog.listSongs({ offset: 0, size: 100 });
      songId = songs.find((s) => /\/source\./.test(s.path))!.id;
      songIds = [
        songId,
        ...(options.additionalPcm ?? []).map((_, i) =>
          songs.find((s) => s.path.endsWith(`/next-${i}.wav`))!.id
        ),
      ];
      const library = {
        ...catalog,
        async getSong(id: string) {
          const song = await catalog.getSong(id);
          return song
            ? {
              ...song,
              ...(options.declaredMs !== undefined
                ? { durationMs: options.declaredMs }
                : {}),
              ...(options.durations?.[songIds.indexOf(id)] !== undefined
                ? { durationMs: options.durations[songIds.indexOf(id)] }
                : {}),
              ...(options.titles?.[songIds.indexOf(id)]
                ? { title: options.titles[songIds.indexOf(id)] }
                : {}),
            }
            : null;
        },
      };
      if (options.persist) persistence = createPersistence(f.store);
      const outputs = outputOwner = createOutputs({
        notify: f.notify,
        persistence,
      });
      for (const [index, peer] of receivers.entries()) {
        outputs.register({
          id: String(index + 1),
          name: 'Scheduled gate',
          type: 'AirPlay',
          host: '127.0.0.1',
          port: peer.port,
          selected: options.receiverSelection?.[index] ?? true,
          volume: 100,
          connectionStrategy: 'owntone',
        });
        if (options.persist) await outputs.adopt(String(index + 1));
      }
      const media = createMedia();
      const wrappedMedia: typeof media = {
        ...media,
        async decodePcm(path, settings) {
          opens++;
          origins.push(settings?.startMs ?? 0);
          await options.acquisition;
          await options.beforeDecode?.(path, settings?.startMs ?? 0);
          const decoded = await media.decodePcm(path, settings);
          if (
            !decoded || !options.afterFirstChunk && !options.afterDecodedChunk
          ) {
            return decoded;
          }
          return fixturePcm(
            (async function* () {
              let first = true;
              for await (const chunk of decoded) {
                yield chunk;
                await options.afterDecodedChunk?.(
                  path,
                  BigInt(chunk.length / 4),
                );
                if (first) {
                  first = false;
                  await options.afterFirstChunk;
                }
              }
            })(),
            decoded,
          );
        },
      };
      const sourceOwner = createPlaybackSource({
        media: wrappedMedia,
        state: f.state,
        radio: createRadioSource({
          network: createNetwork({ state: f.state }),
          state: f.state,
        }),
      });
      const sources = {
        ...sourceOwner,
        open(
          media: Parameters<typeof sourceOwner.open>[0],
          settings: Parameters<typeof sourceOwner.open>[1],
        ) {
          return sourceOwner.open(media, {
            ...settings,
            onMetadata(metadata, frame) {
              options.metadataObserved?.(metadata, frame);
              settings.onMetadata?.(metadata, frame);
            },
          });
        },
      };
      const engine = createPlayback({
        player: createPlayer(),
        library,
        outputs,
        cfg: f.cfg,
        notify: f.notify,
        nowPlaying: createNowPlaying(f.store),
        ...(options.resolveSource
          ? {
            resolveQueueReference: (reference: QueueReference) =>
              options.resolveSource!(reference, async () => {
                if (reference.kind === 'song') {
                  const song = await library.getSong(reference.id);
                  return song ? catalogMedia(song) : null;
                }
                assert(radio);
                // Inspection accepts a direct URL. Retain the caller's station
                // identity only after acquiring its actual finite/live facts.
                const prepared = await sources.prepare({
                  reference: { kind: 'url', url: `${radio.origin}/source` },
                  facts: {
                    kind: 'web',
                    url: `${radio.origin}/source`,
                    title: null,
                    artistName: null,
                    durationMs: null,
                    mode: 'unknown',
                    seekable: false,
                    streamTitle: null,
                    streamUrl: null,
                  },
                }, new AbortController().signal);
                assert(prepared.facts.kind === 'web');
                return { reference, facts: prepared.facts };
              }),
          }
          : {}),
        ...(options.targetChecks
          ? {
            targets: {
              preparePlayback: () => Promise.resolve(),
              hasPlaybackTarget: () => outputs.list().some((o) => o.selected),
            },
          }
          : {}),
        persistence,
        ...(options.web
          ? { prepareQueueMedia: sources.prepare, state: f.state }
          : {}),
      });
      if (options.web) await f.state.set('playback.source.retryBackoffMs', '');
      playback = {
        ...engine,
        seek(...args) {
          const result = engine.seek(...args);
          if (args[0].positionMs !== undefined) {
            options.seekAdmitted?.(args[0].positionMs);
          }
          return result;
        },
        openSource(...args) {
          token = engine.openSource(...args) ?? undefined;
          if (token && !published.has(token)) {
            published.add(token);
            options.sourceOpened?.(token);
          }
          return token ?? null;
        },
      };
      unsubscribePlaying = f.notify.subscribe(() => {
        const playing = engine.sourcePlanView().playing;
        if (!playing || published.has(playing)) return;
        token = playing;
        published.add(playing);
        options.sourceOpened?.(playing);
      });
      if (options.restore && persistence) {
        const snapshot = await planRestore({
          queue: await persistence.loadQueue(),
          saved: await persistence.loadPlayerState(),
          resolve: async (reference) => {
            const song = reference.kind === 'song'
              ? await library.getSong(reference.id)
              : null;
            return song ? catalogMedia(song) : null;
          },
          nowMs: Date.now(),
          maxAgeMs: 60000,
          selectedOutputPresent: true,
        });
        if (snapshot) await playback.restore(snapshot);
      }
      devices = createTestAirplayDevices(
        outputs,
        undefined,
        audio.stream,
        options.metadata ? { md: '0,2' } : {},
      );
      boot = createAirplayBoot({
        outputs,
        playback,
        notify: f.notify,
        devices,
        retryBackoffMs: [],
        crossfadeMs: options.crossfadeMs,
        crossfadeObserved: options.crossfadeObserved,
        ...(options.web ? { sources } : {}),
        media: wrappedMedia,
      });
      timer = setInterval(() => void playback.advanceEnded(), 10);
      return {
        outputs,
        playback,
        library,
        players: {
          get: () => playback,
          list: () => [{ id: 1, name: 'Home', isDefault: true }],
          members: () => outputs.list(),
        },
      };
    },
  });
  const own = async (path: string, method = 'GET', payload?: unknown) => {
    const response = await fetch(
      `http://melofon.home:${f.extraPorts[0]}/api${path}`,
      {
        method,
        ...(payload === undefined ? {} : {
          body: JSON.stringify(payload),
          headers: { 'Content-Type': 'application/json' },
        }),
        signal: AbortSignal.timeout(10000),
      },
    );
    const body = await response.text();
    assertEquals(response.status, method === 'PUT' ? 204 : 200, body);
    return body ? JSON.parse(body) : undefined;
  };
  return {
    receiver,
    receivers,
    playback,
    own,
    audio,
    ackStates,
    completions,
    origins,
    cutoffs,
    capturedCutoffs,
    cancelAcks,
    cancelTimes,
    fixture: f,
    outputs: outputOwner,
    songIds,
    publish(change: () => void) {
      assert(persistence);
      return persistence.publishedCommands.publish(change);
    },
    async saved() {
      await persistence?.drain();
      return persistence?.loadPlayerState();
    },
    get native() {
      return native;
    },
    get token() {
      return token;
    },
    get key() {
      return key;
    },
    get opens() {
      return opens;
    },
    play: (start = true) =>
      own(
        `/queue/items/add?uris=${
          encodeURIComponent(
            radio
              ? `${radio.origin}/source`
              : `library:track:${wireInt(songId)}`,
          )
        }${start ? '&playback=start' : ''}`,
        'POST',
      ),
    async close() {
      clearInterval(timer);
      unsubscribePlaying?.();
      await boot.close();
      devices.close();
      await playback.close();
      await persistence?.close();
      for (const peer of receivers) peer.close();
      await f.close();
      await radio?.close();
      if (!options.directory) await Deno.remove(directory, { recursive: true });
    },
  };
}
