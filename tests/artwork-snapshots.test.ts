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

Deno.test('shared artwork snapshots reach a real HTTP hat with matching facts, bytes and visibility', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-artwork-snapshots-' });
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
