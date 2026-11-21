// Real household registry, durable settings, media decoder and scheduled RAOP.
import { assert, assertEquals } from '@std/assert';
import { apiFixture } from './api.ts';
import { createLibraries } from '../../src/libraries.ts';
import { createLibrary } from '../../src/library.ts';
import { scanLibrary } from '../../src/scan.ts';
import { createMedia } from '../../src/media.ts';
import { createNowPlaying } from '../../src/nowplaying.ts';
import { createPlaybackReports } from '../../src/playback-reports.ts';
import { createPersistence } from '../../src/persistence.ts';
import { createPlayers } from '../../src/players.ts';
import { createOutputs } from '../../src/player.ts';
import { createQueueResolver } from '../../src/queue-source.ts';
import { createAirplayBoot } from '../../src/boots/airplay.ts';
import { createFfiStream } from '../../src/boots/raop-ffi.ts';
import { createTestAirplayDevices } from './airplay-devices.ts';
import { startFakeRaop } from './fake-raop.ts';
import { traceTimelineAudio } from './raop-timeline-audio.ts';
import type { CrossfadeRecord } from '../../src/playback-mix.ts';
import { createReleaseSet, releaseOrThrow } from '../../src/releases.ts';

export async function crossfadeHttp(options: {
  parts: Uint8Array[];
  directory?: string;
  beforeDecode?(path: string, startMs: number): Promise<void>;
  observed?(record: CrossfadeRecord): void;
}) {
  const directory = options.directory ??
    await Deno.makeTempDir({ prefix: 'crossfade-http-' });
  const releases = createReleaseSet();
  if (!options.directory) {
    releases.add(
      'directory',
      () => Deno.remove(directory, { recursive: true }),
      6,
    );
  }
  try {
    await Deno.mkdir(`${directory}/media`, { recursive: true });
    for (const [i, pcm] of options.parts.entries()) {
      const bytes = new Uint8Array(44 + pcm.length),
        header = new DataView(bytes.buffer);
      const text = new TextEncoder();
      bytes.set(text.encode('RIFF'));
      header.setUint32(4, bytes.length - 8, true);
      bytes.set(text.encode('WAVEfmt '), 8);
      header.setUint32(16, 16, true);
      header.setUint16(20, 1, true);
      header.setUint16(22, 2, true);
      header.setUint32(24, 44100, true);
      header.setUint32(28, 176400, true);
      header.setUint16(32, 4, true);
      header.setUint16(34, 16, true);
      bytes.set(text.encode('data'), 36);
      header.setUint32(40, pcm.length, true);
      bytes.set(pcm, 44);
      await Deno.writeFile(`${directory}/media/${i}.wav`, bytes);
    }
    const receivers: Awaited<ReturnType<typeof startFakeRaop>>[] = [];
    for (let i = 0; i < 2; i++) {
      const receiver = await startFakeRaop({
        captureAudio: true,
        captureWire: true,
      });
      receivers.push(receiver);
      releases.add(`receiver ${i}`, () => receiver.close(), 4);
    }
    const traces = new Map<number, ReturnType<typeof traceTimelineAudio>>();
    const devices: ReturnType<typeof createTestAirplayDevices>[] = [];
    const records: (CrossfadeRecord & { playerId: number })[] = [];
    let players!: Awaited<ReturnType<typeof createPlayers>>;
    let reports!: ReturnType<typeof createPlaybackReports>;
    let persistence!: ReturnType<typeof createPersistence>;
    let outputs!: ReturnType<typeof createOutputs>;
    let songIds: string[] = [];
    const f = await apiFixture({
      storeDir: `${directory}/db`,
      hats: {
        layersRoot: 'layers',
        extraPorts: 1,
        env: ([port]) => ({ MELOFON_LISTEN_owntone: `${port},${port}` }),
      },
      services: async (f) => {
        assert(f.notify);
        const libraries = createLibraries(f.store);
        if (!(await libraries.list()).length) {
          await libraries.add('Crossfade', `${directory}/media`);
        }
        await scanLibrary(f.store);
        const library = createLibrary(f.store);
        const songs = await library.listSongs({
          offset: 0,
          size: options.parts.length,
        });
        songIds = options.parts.map((_, i) =>
          songs.find((s) => s.path.endsWith(`/${i}.wav`))!.id
        );
        persistence = createPersistence(f.store);
        releases.add('persistence', () => persistence.close(), 3);
        outputs = createOutputs({ persistence, notify: f.notify });
        const saved = await persistence.loadOutputs();
        for (const [index, receiver] of receivers.entries()) {
          const id = String(index + 1),
            previous = saved.find((s) => s.id === id);
          outputs.register({
            ...previous,
            id,
            name: `Crossfade ${id}`,
            type: 'AirPlay',
            host: '127.0.0.1',
            port: receiver.port,
            selected: previous?.selected ?? index === 0,
            volume: previous?.volume ?? 100,
            connectionStrategy: 'owntone',
          });
          await outputs.adopt(id);
        }
        const nowPlaying = createNowPlaying(f.store);
        reports = createPlaybackReports({
          nowPlaying,
          library,
          notify: f.notify,
          serverRows: () => players.serverRows(),
        });
        releases.add('reports', () => reports.close(), 2);
        const original = createMedia();
        const media = {
          ...original,
          async decodePcm(
            path: string,
            settings: Parameters<typeof original.decodePcm>[1],
          ) {
            await options.beforeDecode?.(path, settings?.startMs ?? 0);
            return await original.decodePcm(path, settings);
          },
        };
        players = await createPlayers({
          store: f.store,
          persistence,
          outputs,
          reports,
          notify: f.notify,
          maxResumeAgeMs: 60000,
          playback: {
            library,
            nowPlaying,
            cfg: f.cfg,
            resolveQueueReference: createQueueResolver({
              getSong: library.getSong,
              getStation: f.store.radio.get,
            }),
          },
          createBoot(playerId, playback, outputs) {
            const trace = traceTimelineAudio(createFfiStream);
            traces.set(playerId, trace);
            const targets = createTestAirplayDevices(
              outputs,
              undefined,
              trace.stream,
              { md: '0,2' },
            );
            devices.push(targets);
            releases.add(`devices ${devices.length}`, () => targets.close(), 1);
            return createAirplayBoot({
              playback,
              outputs,
              devices: targets,
              media,
              notify: f.notify!,
              retryBackoffMs: [],
              crossfadeObserved(record) {
                records.push({ ...record, playerId });
                options.observed?.(record);
              },
            });
          },
        });
        releases.add('players', () => players.close(), 0);
        return {
          library,
          players,
          playback: players.playback,
          persistence,
          outputs,
        };
      },
    });
    releases.add('http', () => f.close(), 5);
    const { credential } = await f.login('bearer');
    const json = async (
      path: string,
      method = 'GET',
      body?: unknown,
      status = 200,
    ) => {
      const response = method === 'GET'
        ? await f.get(`/api/v1${path}`, credential)
        : await f.json(`/api/v1${path}`, method, body, credential);
      const text = await response.text();
      assertEquals(response.status, status, text);
      return text ? JSON.parse(text) : undefined;
    };
    return {
      f,
      credential,
      directory,
      receivers,
      traces,
      records,
      players,
      persistence,
      outputs,
      songIds,
      json,
      add: (id = 1) =>
        json(`/players/${id}/queue/items`, 'POST', {
          references: songIds.map((id) => ({ kind: 'song', id })),
        }),
      command: (kind: string, id = 1, body = {}) =>
        json(`/players/${id}/${kind}`, 'POST', body, 204),
      patch: (body: unknown, id = 1) => json(`/players/${id}`, 'PATCH', body),
      current: async (id = 1) => (await json(`/players/${id}`)).player,
      async own() {
        const response = await fetch(
          `http://melofon.home:${f.extraPorts[0]}/api/player`,
        );
        assertEquals(response.status, 200);
        return await response.json();
      },
      async close() {
        await releaseOrThrow(releases, 'Crossfade fixture cleanup failed');
      },
    };
  } catch (error) {
    await releaseOrThrow(releases, 'Crossfade fixture setup failed', { error });
    throw error;
  }
}
