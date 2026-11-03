import { assert, assertEquals, assertNotEquals } from '@std/assert';
import { decodeBase64, encodeBase64 } from '@std/encoding/base64';
import { cp } from 'node:fs/promises';
import {
  type ArtworkDescriptor,
  type ArtworkRef,
  createArtwork,
} from '../src/artwork.ts';
import { createLibraries } from '../src/libraries.ts';
import { createLibrary } from '../src/library.ts';
import { createPlaylists } from '../src/playlists.ts';
import { createPodcasts, type Podcasts } from '../src/podcasts.ts';
import { createPodcastFiles } from '../src/podcast-files.ts';
import { imageHeader } from '../src/image-header.ts';
import { scanLibrary } from '../src/scan.ts';
import { apiFixture } from './helpers/api.ts';
import { tagged } from './helpers/tagged.ts';
import { candidateImagePath, writeCandidateImage } from '../src/images.ts';
import { rawSql } from '../src/store/testing.ts';
import { Buffer } from 'node:buffer';
import { deflateSync } from 'node:zlib';
import { resizeImage } from '../src/media.ts';

// A real APIC frame on the tagged fixture audio, as in artwork-h8.
async function embed(path: string, image: Uint8Array) {
  const bytes = await Deno.readFile(path);
  const sync = (
    n: number,
  ) => [n >> 21 & 127, n >> 14 & 127, n >> 7 & 127, n & 127];
  const end = 10 + bytes[6] * 2097152 + bytes[7] * 16384 + bytes[8] * 128 +
    bytes[9];
  const payload = new Uint8Array(14 + image.length);
  payload.set(new TextEncoder().encode('\x00image/jpeg\x00\x03\x00'));
  payload.set(image, 14);
  const frame = new Uint8Array(10 + payload.length);
  frame.set(new TextEncoder().encode('APIC'));
  frame.set(sync(payload.length), 4);
  frame.set(payload, 10);
  const result = new Uint8Array(bytes.length + frame.length);
  result.set(bytes.subarray(0, end));
  result.set(sync(end - 10 + frame.length), 6);
  result.set(frame, end);
  result.set(bytes.subarray(end), end + frame.length);
  await Deno.writeFile(path, result);
}

// Independent body identity oracle, not the artwork owner's hash helper.
async function digest(bytes: Uint8Array) {
  const hash = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return [...new Uint8Array(hash)].map((n) => n.toString(16).padStart(2, '0'))
    .join('');
}

async function probeHat(dir: string) {
  const root = `${dir}/layers`;
  await cp('layers/melofon', `${root}/melofon`, { recursive: true });
  const probe = `${root}/melofon/api/artwork-probe`;
  await Deno.mkdir(`${probe}/#kind/#id`, { recursive: true });
  await Deno.writeTextFile(
    `${probe}/20-auth.ts`,
    "export { default } from '#melofon/auth.ts';",
  );
  // Test-only hat projection: core supplies all resolution/facts. It imports no src/.
  await Deno.writeTextFile(
    `${probe}/#kind/#id/get.ts`,
    `
import { encodeBase64 } from '@std/encoding/base64';
export default async function (request, context) {
  const p = new URL(request._raw.url).searchParams;
  const ref = {kind: request.params.kind, id: request.params.id};
  const options = {username: context.state.user.username, size: Number(p.get('size') ?? 0)};
  const art = context.app.artwork;
  if (p.get('mode') === 'describe') return await art.describe(ref, options);
  if (p.get('mode') === 'snapshot') {
    const selected = await art.snapshot(ref, options);
    return selected.kind === 'image'
      ? {...selected, bytes: encodeBase64(selected.bytes)} : selected;
  }
  const result = await art.get(p.has('legacy') ? p.get('legacy') : ref, options);
  if (result.kind === 'unknown') return new Response(null, {status: 404});
  result.response.headers.set('x-fixture-kind', result.kind);
  if (result.kind === 'image') result.response.headers.set('x-fixture-descriptor', JSON.stringify(result.descriptor));
  return result.response;
}`,
  );
  return root;
}

Deno.test('shared artwork snapshots reach a real HTTP hat with matching facts, bytes and visibility', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-artwork-snapshots-' });
  const root = await probeHat(dir);
  let podcasts: Podcasts | undefined;
  let library!: ReturnType<typeof createLibrary>;
  let playlists!: ReturnType<typeof createPlaylists>;
  let channelId = '';
  const picture = await Deno.readFile(
    'tests/fixtures/library/Fixture Artist/Fixture Album/cover.jpg',
  );
  const own = new Uint8Array([...picture, 1]);
  const local = new Uint8Array([...picture, 2]);
  const photo = new Uint8Array([...picture, 3]);
  const podcastPicture = new Uint8Array([...picture, 4]);
  const music = `${dir}/music`;
  const f = await apiFixture({
    hats: { layersRoot: root, extraPorts: 0, env: () => ({}) },
    services: async (f) => {
      await Deno.mkdir(`${music}/Artist/Album`, { recursive: true });
      await Deno.mkdir(`${music}/Missing`, { recursive: true });
      await tagged(`${music}/Artist/Album/own.mp3`, {
        TALB: 'Album',
        TPE2: 'Artist',
        TRCK: '1',
      });
      await embed(`${music}/Artist/Album/own.mp3`, own);
      await tagged(`${music}/Artist/Album/plain.mp3`, {
        TALB: 'Album',
        TPE2: 'Artist',
        TRCK: '2',
      });
      await tagged(`${music}/Missing/song.mp3`, {
        TALB: 'Missing',
        TPE2: 'Other',
      });
      await Deno.writeFile(`${music}/Artist/Album/cover.jpg`, local);
      await Deno.writeFile(`${music}/Artist/artist.jpg`, photo);
      await createLibraries(f.store).add('Music', music);
      await scanLibrary(f.store);
      library = createLibrary(f.store);
      playlists = createPlaylists(f.store);
      const channel = await f.store.podcasts.add('https://unused.test/feed');
      channelId = channel.id;
      await f.store.podcasts.saveFeed(channel.id, {
        title: 'Show',
        description: null,
        imageUrl: null,
        episodes: [],
      }, Date.now());
      const imagePath = await createPodcastFiles(f.cfg.dataDir).saveImage(
        channel.id,
        podcastPicture,
        'jpg',
      );
      await f.store.podcasts.image(
        channel.id,
        imagePath,
        'https://unused.test/cover.jpg',
      );
      podcasts = await createPodcasts({
        store: f.store,
        state: f.state,
        dataDir: f.cfg.dataDir,
      });
      return {
        artwork: createArtwork(library, {
          state: f.state,
          dataDir: f.cfg.dataDir,
          playlists,
          podcasts,
        }),
      };
    },
  });
  try {
    assert(
      (await Deno.resolveDns('melofon.home', 'A')).every((ip) =>
        !ip.startsWith('127.')
      ),
    );
    const cookie = (await f.login('cookie')).credential;
    await f.auth.users.create(f.admin.id, {
      username: 'reader',
      password: 'password-reader',
      role: 'user',
    });
    const bearer =
      (await f.login('bearer', 'reader', 'password-reader')).credential;
    const songs = await library.listSongs({ size: 20, offset: 0 });
    const song = songs.find((s) => s.path.endsWith('/own.mp3'))!;
    const plain = songs.find((s) => s.path.endsWith('/plain.mp3'))!;
    const missing = songs.find((s) => s.path.endsWith('/Missing/song.mp3'))!;
    const { album } = (await library.getAlbum(song.albumId!))!;
    const list = await playlists.create('admin', 'Grid', [song.id], true);
    const path = (ref: ArtworkRef, query = '') =>
      `/api/v1/artwork-probe/${ref.kind}/${ref.id}?${query}`;
    const facts = async (ref: ArtworkRef, credential = cookie) => {
      const response = await f.get(path(ref, 'mode=describe'), credential);
      assertEquals(response.status, 200);
      return await response.json();
    };
    const cases: [
      ArtworkRef,
      ArtworkDescriptor['sourceKind'],
      Uint8Array | null,
    ][] = [
      [{ kind: 'song', id: song.id }, 'embedded', own],
      [{ kind: 'song', id: plain.id }, 'album-file', local],
      [{ kind: 'album', id: album.id }, 'album-file', local],
      [{ kind: 'artist', id: album.artistId! }, 'artist-photo', photo],
      [{ kind: 'playlist', id: list.id }, 'playlist', null],
      [{ kind: 'podcast', id: channelId }, 'podcast', podcastPicture],
    ];
    for (const [ref, sourceKind, expected] of cases) {
      for (const credential of [cookie, bearer]) {
        const description = await facts(ref, credential);
        assertEquals(description.kind, 'image');
        const descriptor: ArtworkDescriptor = description.descriptor;
        assertEquals(descriptor.sourceKind, sourceKind);
        assert(/^[a-f0-9]{64}$/.test(descriptor.version));
        const selected =
          await (await f.get(path(ref, 'mode=snapshot'), credential)).json();
        assertEquals(selected.descriptor, descriptor);
        const selectedBytes = decodeBase64(selected.bytes);
        assertEquals(await digest(selectedBytes), descriptor.sourceHash);
        const body = await f.get(path(ref), credential);
        assertEquals(body.status, 200);
        assertEquals(
          JSON.parse(body.headers.get('x-fixture-descriptor')!),
          descriptor,
        );
        assertEquals(body.headers.get('content-type'), descriptor.mime);
        const delivered = new Uint8Array(await body.arrayBuffer());
        assertEquals(delivered, selectedBytes);
        if (expected) assertEquals(delivered, expected);
        assertEquals([descriptor.width, descriptor.height], [
          imageHeader(delivered)!.width,
          imageHeader(delivered)!.height,
        ]);
        const alias = ref.kind === 'playlist' ? `pl-${ref.id}` : ref.id;
        const legacy = await f.get(path(ref, `legacy=${alias}`), credential);
        assertEquals(new Uint8Array(await legacy.arrayBuffer()), delivered);
        assertEquals(
          JSON.parse(legacy.headers.get('x-fixture-descriptor')!),
          descriptor,
        );
        const resized = await f.get(path(ref, 'size=16'), credential);
        assertEquals(
          JSON.parse(resized.headers.get('x-fixture-descriptor')!),
          descriptor,
        );
        const header = imageHeader(
          new Uint8Array(await resized.arrayBuffer()),
        )!;
        assert(Math.max(header.width, header.height) <= 16);
      }
    }
    // A populated grid cache must not reveal a descriptor or bytes after visibility loss.
    await playlists.update('admin', list.id, { public: false });
    const playlistRef: ArtworkRef = { kind: 'playlist', id: list.id };
    assertEquals(await facts(playlistRef, bearer), { kind: 'unknown' });
    assertEquals(
      await (await f.get(path(playlistRef, 'mode=snapshot'), bearer)).json(),
      { kind: 'unknown' },
    );
    const denied = await f.get(path(playlistRef), bearer);
    assertEquals(denied.status, 404);
    await denied.arrayBuffer();
    assertEquals((await facts(playlistRef)).kind, 'image');
    const noAuth = await f.get(path(playlistRef));
    assertEquals(noAuth.status, 401);
    await noAuth.arrayBuffer();
    // Absence stays distinct from unknown and from the legacy missing-cover tile.
    for (
      const ref of [{ kind: 'song' as const, id: missing.id }, {
        kind: 'album' as const,
        id: missing.albumId!,
      }]
    ) {
      assertEquals(await facts(ref), { kind: 'missing' });
      const response = await f.get(path(ref), cookie);
      assertEquals(response.headers.get('x-fixture-kind'), 'placeholder');
      assertEquals(
        encodeBase64(new Uint8Array(await response.arrayBuffer())),
        encodeBase64(
          new Uint8Array(
            await createArtwork(library).placeholder().arrayBuffer(),
          ),
        ),
      );
    }
    assertEquals(await facts({ kind: 'song', id: 'absent' }), {
      kind: 'unknown',
    });
    assertEquals(await facts({ kind: 'song', id: album.id }), {
      kind: 'unknown',
    });
    const artistRef: ArtworkRef = { kind: 'artist', id: album.artistId! };
    await Deno.remove(`${music}/Artist/artist.jpg`);
    const fallback = await facts(artistRef);
    assertEquals(fallback.descriptor.sourceHash, await digest(local));
    assertEquals(fallback.descriptor.sourceKind, 'album-file');
    const albumRef: ArtworkRef = { kind: 'album', id: album.id };
    const before = await facts(albumRef);
    await Deno.writeFile(`${music}/Artist/Album/cover.jpg`, photo);
    const changed = await facts(albumRef);
    assertEquals(changed.descriptor.sourceHash, await digest(photo));
    assertNotEquals(changed.descriptor.version, before.descriptor.version);
    // Policy changes alter the public version without mislabelling the source bytes.
    await f.state.set('artwork.jpegQuality', '30');
    const policyChanged = await facts(albumRef);
    assertEquals(
      policyChanged.descriptor.sourceHash,
      changed.descriptor.sourceHash,
    );
    assertNotEquals(
      policyChanged.descriptor.version,
      changed.descriptor.version,
    );
    assertEquals(
      await createArtwork(library, { state: f.state }).describe(albumRef),
      policyChanged,
    );
    await Deno.remove(`${music}/Artist/Album/cover.jpg`);
    assertEquals(
      (await facts(albumRef)).descriptor.sourceHash,
      await digest(own),
    );
    await tagged(`${music}/Artist/Album/own.mp3`, {
      TALB: 'Album',
      TPE2: 'Artist',
      TRCK: '1',
    });
    assertEquals(await facts(albumRef), { kind: 'missing' });
    // Unknown headers stay original, with honest nullable dimensions.
    await Deno.writeFile(
      `${music}/Artist/Album/cover.jpg`,
      new Uint8Array([1, 2, 3]),
    );
    const corrupt = await facts(albumRef);
    assertEquals([corrupt.descriptor.width, corrupt.descriptor.height], [
      null,
      null,
    ]);
    const corruptBody = await f.get(path(albumRef, 'size=16'), cookie);
    assertEquals(
      new Uint8Array(await corruptBody.arrayBuffer()),
      new Uint8Array([1, 2, 3]),
    );
    await f.store.podcasts.delete(channelId);
    assertEquals(await facts({ kind: 'podcast', id: channelId }), {
      kind: 'unknown',
    });
  } finally {
    await podcasts?.close();
    await f.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('HTTP artwork reuses source facts across restart and invalidates every source owner', async () => {
  const dir = await Deno.makeTempDir({
    prefix: 'melofon-artwork-source-facts-',
  });
  const root = await probeHat(dir);
  const music = `${dir}/music`;
  const data = `${dir}/data`;
  // Real pixel changes are necessary: JPEG trailer changes alter source identity,
  // but correctly leave the composed playlist's output pixels/hash unchanged.
  const chunk = (name: string, payload: Uint8Array) => {
    const body = Buffer.concat([Buffer.from(name), payload]);
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) {
        crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0);
      }
    }
    const result = Buffer.alloc(body.length + 8);
    result.writeUInt32BE(payload.length);
    result.set(body, 4);
    result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, body.length + 4);
    return result;
  };
  const encoded = await Promise.all([0, 1, 2, 3, 4, 5].map(async (n) => {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(8);
    header.writeUInt32BE(8, 4);
    header[8] = 8;
    header[9] = 2;
    const pixels = Buffer.alloc(8 * 25);
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        pixels.set([n * 40, 255 - n * 40, n * 20], y * 25 + 1 + x * 3);
      }
    }
    const png = Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(pixels)),
      chunk('IEND', new Uint8Array()),
    ]);
    return (await resizeImage(png, 8, 8, 'jpeg', 75))!;
  }));
  const length = Math.max(...encoded.map((bytes) => bytes.length));
  const images = encoded.map((bytes) => {
    const padded = new Uint8Array(length);
    padded.set(bytes);
    return padded;
  });
  const hashes = await Promise.all(images.map(digest));
  const sourcePaths = new Set<string>();
  let reads = 0, hashesComputed = 0;
  const open = Deno.open;
  const hash = crypto.subtle.digest.bind(crypto.subtle);
  Deno.open = ((path, options) => {
    if (sourcePaths.has(String(path))) reads++;
    return open(path, options);
  }) as typeof Deno.open;
  crypto.subtle.digest = ((algorithm, input) => {
    const bytes = ArrayBuffer.isView(input)
      ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
      : new Uint8Array(input);
    if (
      bytes.length === images[0].length && bytes[0] === 255 && bytes[1] === 216
    ) hashesComputed++;
    return hash(algorithm, input);
  }) as typeof crypto.subtle.digest;
  let seeded = false;
  let library!: ReturnType<typeof createLibrary>;
  let playlists!: ReturnType<typeof createPlaylists>;
  let podcasts: Podcasts | undefined;
  let channelId = '';
  const songPath = `${music}/Artist/Album/song.mp3`;
  const plainPath = `${music}/Candidate/song.mp3`;
  const localPath = `${music}/Artist/Album/cover.jpg`;
  const photoPath = `${music}/Artist/artist.jpg`;
  sourcePaths.add(songPath);
  sourcePaths.add(plainPath);
  sourcePaths.add(localPath);
  sourcePaths.add(photoPath);
  const start = () =>
    apiFixture({
      storeDir: data,
      hats: { layersRoot: root, extraPorts: 0, env: () => ({}) },
      services: async (f) => {
        if (!seeded) {
          await Deno.mkdir(`${music}/Artist/Album`, { recursive: true });
          await Deno.mkdir(`${music}/Candidate`, { recursive: true });
          await tagged(songPath, { TALB: 'Album', TPE2: 'Artist', TRCK: '1' });
          await embed(songPath, images[0]);
          await tagged(plainPath, { TALB: 'Candidate', TPE2: 'Other' });
          await createLibraries(f.store).add('Music', music);
          await scanLibrary(f.store);
          const channel = await f.store.podcasts.add(
            'https://unused.test/source-facts',
          );
          channelId = channel.id;
          await f.store.podcasts.saveFeed(channelId, {
            title: 'Show',
            description: null,
            imageUrl: null,
            episodes: [],
          }, Date.now());
          const path = await createPodcastFiles(data).saveImage(
            channelId,
            images[1],
            'jpg',
          );
          sourcePaths.add(path);
          await f.store.podcasts.image(
            channelId,
            path,
            'https://unused.test/cover.jpg',
          );
          seeded = true;
        }
        library = createLibrary(f.store, undefined, { dataDir: data });
        playlists = createPlaylists(f.store);
        podcasts = await createPodcasts({
          store: f.store,
          state: f.state,
          dataDir: data,
        });
        return {
          artwork: createArtwork(library, {
            state: f.state,
            dataDir: data,
            playlists,
            podcasts,
            facts: f.store.artwork,
          }),
        };
      },
    });
  let f: Awaited<ReturnType<typeof apiFixture>> | undefined;
  try {
    f = await start();
    assert(
      (await Deno.resolveDns('melofon.home', 'A')).every((ip) =>
        !ip.startsWith('127.')
      ),
    );
    const cookie = (await f.login('cookie')).credential;
    const bearer = (await f.login('bearer')).credential;
    const songs = await library.listSongs({ size: 10, offset: 0 });
    const song = songs.find((s) => s.path === songPath)!;
    const plain = songs.find((s) => s.path === plainPath)!;
    const album = (await library.getAlbum(song.albumId!))!.album;
    const list = await playlists.create('admin', 'Sources', [song.id], true);
    const ref = (kind: ArtworkRef['kind'], id: string): ArtworkRef => ({
      kind,
      id,
    });
    const songRef = ref('song', song.id);
    const albumRef = ref('album', album.id);
    const artistRef = ref('artist', album.artistId!);
    const candidateRef = ref('album', plain.albumId!);
    const playlistRef = ref('playlist', list.id);
    const podcastRef = ref('podcast', channelId);
    const facts = async (ref: ArtworkRef) => {
      const response = await f!.get(
        `/api/v1/artwork-probe/${ref.kind}/${ref.id}?mode=describe`,
        cookie,
      );
      assertEquals(response.status, 200);
      return await response.json();
    };
    const body = async (ref: ArtworkRef, expected?: Uint8Array) => {
      const response = await f!.get(
        `/api/v1/artwork-probe/${ref.kind}/${ref.id}`,
        bearer,
      );
      assertEquals(response.status, 200);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (expected) assertEquals(bytes, expected);
      return {
        bytes,
        descriptor: JSON.parse(
          response.headers.get('x-fixture-descriptor')!,
        ) as ArtworkDescriptor,
      };
    };
    // Embedded bytes and their hash are loaded once; the album shares that source.
    reads = hashesComputed = 0;
    const embedded = await body(songRef, images[0]);
    assertEquals([reads, hashesComputed], [1, 1]);
    const counters = [reads, hashesComputed];
    assertEquals((await facts(albumRef)).descriptor, embedded.descriptor);
    await body(songRef, images[0]);
    assertEquals([reads, hashesComputed], counters);
    const grid = await body(playlistRef);
    const podcast = await body(podcastRef, images[1]);
    const beforeRepeat = [reads, hashesComputed];
    await body(playlistRef, grid.bytes);
    await body(podcastRef, images[1]);
    assertEquals([reads, hashesComputed], beforeRepeat);
    // Close the actual HTTP/store owners; no in-memory facts can survive this restart.
    await podcasts!.close();
    await f.close();
    f = await start();
    reads = hashesComputed = 0;
    assertEquals(
      (await body(songRef, images[0])).descriptor,
      embedded.descriptor,
    );
    assertEquals(
      (await body(playlistRef, grid.bytes)).descriptor,
      grid.descriptor,
    );
    assertEquals(
      (await body(podcastRef, images[1])).descriptor,
      podcast.descriptor,
    );
    assertEquals([reads, hashesComputed], [0, 0]);
    // Adding/removing a higher-priority file changes the winner without a rescan.
    await Deno.writeFile(localPath, images[2]);
    const local = await body(albumRef, images[2]);
    assertEquals(local.descriptor.sourceHash, hashes[2]);
    assertNotEquals(local.descriptor.version, embedded.descriptor.version);
    const stat = await Deno.stat(localPath);
    await Deno.writeFile(localPath, images[3]); // same size and restored mtime
    await Deno.utime(localPath, stat.atime!, stat.mtime!);
    const replaced = await body(albumRef, images[3]);
    assertEquals(replaced.descriptor.sourceHash, hashes[3]);
    assertNotEquals(replaced.descriptor.version, local.descriptor.version);
    assertNotEquals(
      (await body(playlistRef)).descriptor.version,
      grid.descriptor.version,
    );
    const beforeFileRepeat = [reads, hashesComputed];
    await facts(albumRef);
    await body(albumRef, images[3]);
    assertEquals([reads, hashesComputed], beforeFileRepeat);
    await Deno.remove(localPath);
    assertEquals(
      (await body(albumRef, images[0])).descriptor.version,
      embedded.descriptor.version,
    );
    await Deno.writeFile(photoPath, images[4]);
    assertEquals(
      (await body(artistRef, images[4])).descriptor.sourceKind,
      'artist-photo',
    );
    await Deno.remove(photoPath);
    assertEquals(
      (await body(artistRef, images[0])).descriptor.sourceHash,
      hashes[0],
    );
    // No-picture extraction is cached, but candidate selection is checked each request.
    assertEquals(await facts(candidateRef), { kind: 'missing' });
    const libraryRow = (await f.store.catalog.listLibraries())[0];
    const add = async (image: Uint8Array, foundAtMs: number) => {
      const saved = (await writeCandidateImage(libraryRow, image, 'jpg'))!;
      sourcePaths.add(candidateImagePath(libraryRow, saved.hash, saved.ext));
      return (await f!.store.candidates.addCandidates([{
        entityType: 'album',
        entityId: plain.albumId!,
        kind: 'cover',
        source: 'fixture',
        confidence: 'strong',
        imageHash: saved.hash,
        imageExt: saved.ext,
        libraryId: libraryRow.id,
        origin: 'https://unused.test/image',
        foundAtMs,
      }]))[0];
    };
    await add(images[2], 1);
    const firstCandidate = await body(candidateRef, images[2]);
    const candidateCounters = [reads, hashesComputed];
    await body(candidateRef, images[2]);
    assertEquals([reads, hashesComputed], candidateCounters);
    const next = await add(images[3], 2);
    const nextCandidate = await body(candidateRef, images[3]);
    assertNotEquals(
      firstCandidate.descriptor.version,
      nextCandidate.descriptor.version,
    );
    await f.store.candidates.setState(next.id, 'rejected');
    await body(candidateRef, images[2]);
    await playlists.setTracks('admin', list.id, [plain.id]);
    assertNotEquals(
      (await body(playlistRef)).descriptor.version,
      grid.descriptor.version,
    );
    const path = await createPodcastFiles(data).saveImage(
      channelId,
      images[5],
      'jpg',
    );
    await f.store.podcasts.image(
      channelId,
      path,
      'https://unused.test/new.jpg',
    );
    assertNotEquals(
      (await body(podcastRef, images[5])).descriptor.version,
      podcast.descriptor.version,
    );
    await Deno.remove(path);
    assertEquals(await facts(podcastRef), { kind: 'missing' });
    // Disposable backing eviction rebuilds facts rather than returning stale bytes.
    await Deno.remove(`${data}/cache`, { recursive: true });
    reads = hashesComputed = 0;
    await body(songRef, images[0]);
    assertEquals([reads, hashesComputed], [1, 1]);
    await f.state.set('artwork.maxSourceMegabytes', '0');
    assertEquals(await facts(songRef), { kind: 'missing' });
    await f.state.set('artwork.maxSourceMegabytes', '20');
    await body(songRef, images[0]);
    // Existing installations acquire the new disposable table during normal open.
    await rawSql(f.store).run('DROP TABLE artwork_sources');
    await podcasts!.close();
    await f.close();
    f = await start();
    await body(songRef, images[0]);
    assert(await f.store.artwork.get(`embedded-v1:${songPath}`));
  } finally {
    Deno.open = open;
    crypto.subtle.digest = hash;
    await podcasts?.close();
    await f?.close();
    await Deno.remove(dir, { recursive: true });
  }
});
