import { assert, assertEquals } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { openStore } from '../src/store/index.ts';
import { rawSql } from '../src/store/testing.ts';
import { seedFirstUser } from '../src/users.ts';
import { scanLibrary } from '../src/scan.ts';
import { createLibraries } from '../src/libraries.ts';
import { createUserService } from '../src/user.ts';
import { createLibrary } from '../src/library.ts';
import { createStream } from '../src/stream.ts';
import { createMedia } from '../src/media.ts';
import { loadLayers } from '../src/layers.ts';
import { createState } from '../src/state.ts';
import { facade } from '../src/facade.ts';

export const AUTH = 'u=admin&p=test&v=1.16.1&c=h5&f=json';
export const RATE = 44100;
export const landmark = (seconds: number) =>
  Math.sin(2 * Math.PI * (300 * seconds + 50 * seconds * seconds));

export async function setupH5() {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-h5-' });
  const libraryDir = `${dir}/library`;
  await Deno.mkdir(libraryDir);
  // Six seconds of a deterministic chirp. Every time has a distinct frequency;
  // PCM correlation identifies the actual first audible source position.
  const title = new TextEncoder().encode('H5 Landmarks\0');
  const paddedTitleLength = title.length + (title.length & 1);
  const dataBytes = RATE * 6 * 4;
  const wav = new Uint8Array(44 + dataBytes + 20 + paddedTitleLength);
  const view = new DataView(wav.buffer);
  const text = (at: number, value: string) =>
    wav.set(new TextEncoder().encode(value), at);
  text(0, 'RIFF');
  view.setUint32(4, wav.length - 8, true);
  text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, RATE, true);
  view.setUint32(28, RATE * 4, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < RATE * 6; i++) {
    const value = Math.round(12000 * landmark(i / RATE));
    view.setInt16(44 + i * 4, value, true);
    view.setInt16(46 + i * 4, value, true);
  }
  const info = 44 + dataBytes;
  text(info, 'LIST');
  view.setUint32(info + 4, 12 + paddedTitleLength, true);
  text(info + 8, 'INFOINAM');
  view.setUint32(info + 16, title.length, true);
  wav.set(title, info + 20);
  await Deno.writeFile(`${libraryDir}/landmarks.wav`, wav);
  await Deno.copyFile(
    'tests/fixtures/library/Fixture Artist/Fixture Album/03 - Clip.mp4',
    `${libraryDir}/clip.mp4`,
  );
  const store = await openStore(`${dir}/data`);
  const cfg = {
    listen: undefined,
    absentToMp3: false,
    dataDir: `${dir}/data`,
    user: 'admin',
    password: 'test',
    secret: 'h5-secret',
    version: 'test',
  };
  await seedFirstUser(store, cfg);
  await rawSql(store).run(
    "INSERT INTO users (id, name, password_enc, created_at) SELECT 'h5-other', 'other', password_enc, now() FROM users WHERE name = 'admin'",
  );
  const libraries = createLibraries(store);
  await libraries.add('H5', libraryDir);
  await scanLibrary(store);
  const library = createLibrary(store);
  const media = createMedia();
  let started = 0;
  let active = 0;
  const transcode = media.transcodeAudio.bind(media);
  media.transcodeAudio = async (...args) => {
    started++;
    const result = await transcode(...args);
    if (result) {
      active++;
      // Added by H5 at the native-resource lifetime boundary, not the HTTP EOF.
      const completion =
        (result as typeof result & { completion?: Promise<void> }).completion;
      if (completion) void completion.finally(() => active--);
    }
    return result;
  };
  const events: string[] = [];
  const bag = {
    cfg,
    state: createState(store),
    libraries,
    user: createUserService(store, cfg),
    library,
    stream: createStream(media, undefined, cfg, {
      event(id) {
        events.push(id);
      },
    }),
  };
  const core = await pathfinder({ roots: ['core/'], app: { store, cfg } });
  const app = facade(core, await loadLayers({ app: bag }));
  const tracks = await library.search3('', {
    artistCount: 0,
    artistOffset: 0,
    albumCount: 0,
    albumOffset: 0,
    songCount: 20,
    songOffset: 0,
  });
  const id = tracks.songs.find((s) => s.suffix === 'wav')!.id;
  assertEquals(tracks.songs.find((s) => s.id === id)!.title, 'H5 Landmarks');
  const videoId = tracks.songs.find((s) => s.isVideo)!.id;
  return {
    app,
    id,
    videoId,
    media,
    dir,
    wav,
    events,
    counts: () => ({ started, active }),
    request: (op: string, extra = '', init?: RequestInit) =>
      app(new Request(`http://x/rest/${op}?${AUTH}&id=${id}${extra}`, init)),
    async close() {
      await store.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

export async function decoded(
  s: Awaited<ReturnType<typeof setupH5>>,
  response: Response,
  codec: string,
  offset?: number,
) {
  assertEquals(response.status, 200);
  const path = `${s.dir}/returned-audio`;
  await Deno.writeFile(path, new Uint8Array(await response.arrayBuffer()));
  const probe = await s.media.probe(path);
  assertEquals(probe.audioCodec, codec);
  assertEquals(probe.hasVideo, false);
  const audio = await s.media.decodePcm(path);
  assert(audio);
  const chunks: Uint8Array[] = [];
  for await (const chunk of audio) chunks.push(chunk);
  const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  assert(size > RATE / 2, 'HTTP body must decode to non-empty PCM');
  const pcm = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    pcm.set(chunk, at);
    at += chunk.length;
  }
  if (offset !== undefined) {
    const view = new DataView(pcm.buffer);
    let best = -Infinity, lag = 0;
    // Skip the first 60 ms of priming, then match a 120 ms window.
    for (let shift = -4410; shift <= 4410; shift += 5) {
      let correlation = 0, sourceEnergy = 0, outputEnergy = 0;
      for (let i = 2646; i < 7938; i += 4) {
        const output = view.getInt16(i * 4, true);
        const source = landmark(offset + (i + shift) / RATE);
        correlation += output * source;
        sourceEnergy += source * source;
        outputEnergy += output * output;
      }
      correlation /= Math.sqrt(sourceEnergy * outputEnergy);
      if (correlation > best) {
        best = correlation;
        lag = shift / RATE;
      }
    }
    console.log(`H5 ${codec} seek ${offset}s measured lag ${lag.toFixed(6)}s`);
    assert(best > 0.9, `decoded landmark correlation ${best} is too low`);
    // Characterized in VM receipts: mp3 -25.057 ms, AAC -25.170 ms,
    // Opus 0 ms. Bounds include codec priming, not a second of seek error.
    const tolerance = codec === 'mp3' || codec === 'aac' ? 0.03 : 0.01;
    assert(
      Math.abs(lag) < tolerance,
      `first decoded source position differs by ${lag}s`,
    );
    assert(
      Math.abs(size / 4 / RATE - (6 - offset)) < 0.1,
      'decoded body must include the whole remaining audio',
    );
  }
  return { probe, pcm };
}
