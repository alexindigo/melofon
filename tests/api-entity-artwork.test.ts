import { assert, assertEquals, assertNotEquals } from '@std/assert';
import { decodeBase64 } from '@std/encoding/base64';
import { createArtwork } from '../src/artwork.ts';
import { createHatData } from '../src/hat-data.ts';
import { createLibraries } from '../src/libraries.ts';
import { createLibrary } from '../src/library.ts';
import { createPlaylists } from '../src/playlists.ts';
import { createPodcasts, type Podcasts } from '../src/podcasts.ts';
import { createPodcastFiles } from '../src/podcast-files.ts';
import { createRadio } from '../src/radio.ts';
import { imagePixels } from '../src/media.ts';
import { scanLibrary } from '../src/scan.ts';
import { apiFixture, error } from './helpers/api.ts';
import { pixelPng } from './helpers/pixel-image.ts';
import { tagged } from './helpers/tagged.ts';
import reference from './fixtures/thumbhash-reference.json' with {
  type: 'json',
};

const red = reference.vectors.find((v) => v.name === 'one-red')!;
const black = reference.vectors.find((v) => v.name === 'one-black')!;
const redImage = pixelPng(1, 1, decodeBase64(red.rgba));
const blackImage = pixelPng(1, 1, decodeBase64(black.rgba));
// Solid 100x100 red, from c07's unmodified pinned official encoder (same
// provenance as thumbhash-reference.json). DCT quantization depends on sample
// dimensions, so the composed grid cannot use the 1x1 source's vector.
const redGridHash = '1fsDBwCIiIiHh4eHd4h4d4d4AIqHoHgI';

async function fixture() {
  const root = await Deno.makeTempDir({ prefix: 'melofon-entity-artwork-' });
  let podcasts!: Podcasts;
  let playlists!: ReturnType<typeof createPlaylists>;
  let radio!: ReturnType<typeof createRadio>;
  let seeded = false;
  let channelId = '';
  let missingChannelId = '';
  const cover = `${root}/music/Artist/Red/cover.png`;
  const open = () =>
    apiFixture({
      storeDir: `${root}/data`,
      services: async (f) => {
        const library = createLibrary(f.store);
        const libraries = createLibraries(f.store);
        playlists = createPlaylists(f.store);
        radio = createRadio(f.store, {
          dataDir: f.cfg.dataDir,
          state: f.state,
        });
        if (!seeded) {
          for (const name of ['Red', 'Black', 'Missing']) {
            const dir = `${root}/music/Artist/${name}`;
            await Deno.mkdir(dir, { recursive: true });
            await tagged(`${dir}/song.mp3`, {
              TALB: name,
              TPE1: 'Artist',
              TPE2: 'Artist',
              TIT2: name,
            });
            if (name !== 'Missing') {
              await Deno.writeFile(
                `${dir}/cover.png`,
                name === 'Red' ? redImage : blackImage,
              );
            }
          }
          await Deno.writeFile(`${root}/music/Artist/artist.png`, redImage);
          await libraries.add('Music', `${root}/music`);
          await scanLibrary(f.store);
          for (const missing of [false, true]) {
            const channel = await f.store.podcasts.add(
              `https://unused.test/${missing}/feed`,
            );
            await f.store.podcasts.saveFeed(channel.id, {
              title: missing ? 'Missing' : 'Show',
              description: null,
              imageUrl: null,
              episodes: [{
                guid: 'one',
                title: 'Episode',
                description: null,
                publishDate: null,
                enclosureUrl: 'https://unused.test/audio.mp3',
                contentType: 'audio/mpeg',
                enclosureLength: null,
                duration: 60,
              }],
            }, Date.now());
            if (missing) missingChannelId = channel.id;
            else {
              channelId = channel.id;
              const path = await createPodcastFiles(f.cfg.dataDir).saveImage(
                channel.id,
                redImage,
                'png',
              );
              await f.store.podcasts.image(
                channel.id,
                path,
                'https://unused.test/image.png',
              );
            }
          }
          seeded = true;
        }
        podcasts = await createPodcasts({
          store: f.store,
          state: f.state,
          dataDir: f.cfg.dataDir,
        });
        return {
          library,
          libraries,
          playlists,
          podcasts,
          radio,
          artwork: createArtwork(library, {
            playlists,
            podcasts,
            radio,
            state: f.state,
            dataDir: f.cfg.dataDir,
            facts: f.store.artwork,
          }),
        };
      },
    });
  let f = await open();
  const songs = await createLibrary(f.store).listSongs({ offset: 0, size: 20 });
  const song = songs.find((row) => row.title === 'Red')!;
  const other = songs.find((row) => row.title === 'Black')!;
  const missing = songs.find((row) => row.title === 'Missing')!;
  const album = (await createLibrary(f.store).getAlbum(song.albumId!))!.album;
  const playlist = await playlists.create('admin', 'Grid', [song.id], true);
  const empty = await playlists.create('admin', 'Empty', [], true);
  const station = await radio.create({
    name: 'A',
    streamUrl: 'http://station.home/live',
    homePageUrl: null,
  });
  assert(!('invalid' in station));
  const episode = (await podcasts.episodes(channelId))[0];
  return {
    root,
    cover,
    song,
    other,
    missing,
    album,
    playlist,
    empty,
    station,
    episode,
    channelId,
    missingChannelId,
    get f() {
      return f;
    },
    get playlists() {
      return playlists;
    },
    get podcasts() {
      return podcasts;
    },
    get radio() {
      return radio;
    },
    async clear() {
      const data = createHatData(f.store, f.cfg, f.state)('melofon');
      for (const row of await data.list()) await data.remove(row.key);
    },
    async restart() {
      await podcasts.close();
      await f.close();
      f = await open();
    },
    async close() {
      await podcasts.close();
      await f.close();
      await Deno.remove(root, { recursive: true });
    },
  };
}

type Art = {
  url: string;
  version: string;
  width: number;
  height: number;
  thumbHash: string | null;
  dominantColor: string | null;
};
type Entity = { id: string; artwork: Art | null };
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function read(t: Fixture, path: string, key: string, etag?: string) {
  const response = await t.f.get(
    `/api/v1/${path}`,
    key,
    etag ? { 'If-None-Match': etag } : {},
  );
  assertEquals(response.status, 200, await response.clone().text());
  const text = await response.text();
  assert(!text.includes(t.root), 'no internal file paths');
  assert(!text.includes('imagePath'));
  return { body: JSON.parse(text), etag: response.headers.get('etag') };
}

async function image(t: Fixture, art: Art, key: string) {
  assertEquals(new URL(art.url, t.f.origin).searchParams.get('v'), art.version);
  const response = await t.f.get(art.url, key);
  assertEquals(response.status, 200);
  assertEquals(response.headers.get('content-type'), 'image/png');
  assertEquals(
    response.headers.get('cache-control'),
    'private, max-age=31536000, immutable',
  );
  const bytes = new Uint8Array(await response.arrayBuffer());
  const pixels = await imagePixels(bytes, art.width, art.height);
  const repeated = await t.f.get(art.url, key, {
    'If-None-Match': response.headers.get('etag')!,
  });
  assertEquals(repeated.status, 304);
  assertEquals(await repeated.text(), '');
  return { bytes, pixels };
}

Deno.test('phase C artwork matrix: six native kinds, lazy list facts, versioned HTTP 200/304 and station name pixels', async () => {
  const t = await fixture();
  try {
    assert(
      (await Deno.resolveDns('melofon.home', 'A')).every((ip) =>
        !ip.startsWith('127.')
      ),
    );
    const cookie = (await t.f.login()).credential;
    const bearer = (await t.f.login('bearer')).credential;
    const cases = [
      ['songs', 'song', t.song.id],
      ['albums', 'album', t.album.id],
      ['artists', 'artist', t.album.artistId!],
      ['playlists', 'playlist', t.playlist.id],
      ['radio-stations', 'radioStation', t.station.id],
      ['podcasts', 'podcast', t.channelId],
    ];
    for (const [path, field, id] of cases) {
      await error(await t.f.get(`/api/v1/${path}`), 401, 'unauthenticated');
      await error(
        await t.f.get(`/api/v1/${path}/${id}`),
        401,
        'unauthenticated',
      );
      await t.clear();
      const first = await read(t, path, cookie);
      const listKey = path === 'radio-stations' ? 'radioStations' : path;
      const initial = (first.body[listKey] as Entity[]).find((row) =>
        row.id === id
      )!;
      assert(initial.artwork);
      assertEquals([initial.artwork.thumbHash, initial.artwork.dominantColor], [
        null,
        null,
      ]);
      const second = await read(t, path, bearer, first.etag ?? undefined);
      const entity = (second.body[listKey] as Entity[]).find((row) =>
        row.id === id
      )!;
      assert(entity.artwork);
      assert(entity.artwork.thumbHash);
      assert(/^#[0-9a-f]{6}$/.test(entity.artwork.dominantColor!));
      if (first.etag) assertNotEquals(second.etag, first.etag);
      const detail = await read(t, `${path}/${id}`, cookie);
      assertEquals(detail.body[field].artwork, entity.artwork);
      const a = await image(t, entity.artwork, cookie);
      const b = await image(t, entity.artwork, bearer);
      assertEquals(a.bytes, b.bytes);
      if (path !== 'radio-stations') {
        assertEquals(
          entity.artwork.thumbHash,
          path === 'playlists' ? redGridHash : red.hash,
        );
        assertEquals(entity.artwork.dominantColor, '#ff0000');
        for (let i = 0; i < a.pixels.length; i += 4) {
          assertEquals(
            a.pixels.slice(i, i + 4),
            new Uint8Array([255, 0, 0, 255]),
          );
        }
      } else {
        // Independent upstream Unifont U+0041 vector from c10. Full raster mask,
        // not just a non-grey image, proves the consumer sees the station's name.
        const glyph = '0000000018242442427E424242420000';
        assertEquals([entity.artwork.width, entity.artwork.height], [512, 512]);
        const background = a.pixels.slice(0, 4);
        assertEquals(
          entity.artwork.dominantColor,
          `#${
            [...background.subarray(0, 3)].map((n) =>
              n.toString(16).padStart(2, '0')
            ).join('')
          }`,
        );
        for (let y = 0; y < 512; y++) {
          for (let x = 0; x < 512; x++) {
            const col = Math.floor((x - 236) / 5),
              row = Math.floor((y - 216) / 5);
            const ink = col >= 0 && col < 8 && row >= 0 && row < 16 &&
              (parseInt(glyph.slice(row * 2, row * 2 + 2), 16) &
                (1 << (7 - col)));
            assertEquals(
              a.pixels.slice((y * 512 + x) * 4, (y * 512 + x) * 4 + 4),
              ink ? new Uint8Array([255, 255, 255, 255]) : background,
            );
          }
        }
      }
      await t.restart();
      const restored = await read(t, `${path}/${id}`, bearer);
      assertEquals(restored.body[field].artwork, entity.artwork);
    }
    const channel =
      (await read(t, `podcasts/${t.channelId}`, cookie)).body.podcast;
    const episodes =
      (await read(t, `podcasts/${t.channelId}/episodes`, bearer)).body.episodes;
    assertEquals(episodes[0].artwork, channel.artwork);
    assertEquals(
      (await read(t, `podcast-episodes/${t.episode.id}`, cookie)).body.episode
        .artwork,
      channel.artwork,
    );
    for (
      const [path, field] of [
        [`songs/${t.missing.id}`, 'song'],
        [`albums/${t.missing.albumId}`, 'album'],
        [`playlists/${t.empty.id}`, 'playlist'],
        [`podcasts/${t.missingChannelId}`, 'podcast'],
      ]
    ) assertEquals((await read(t, path, bearer)).body[field].artwork, null);
    const missingEpisodes =
      (await read(t, `podcasts/${t.missingChannelId}/episodes`, cookie)).body
        .episodes;
    assertEquals(missingEpisodes[0].artwork, null);
    const membership =
      (await read(t, `songs/${t.song.id}/playlists`, bearer)).body.playlists;
    assertEquals(
      membership.find((row: Entity) => row.id === t.playlist.id).artwork
        .thumbHash,
      null,
    );
    const nextMembership =
      (await read(t, `songs/${t.song.id}/playlists`, bearer)).body.playlists;
    assertEquals(
      nextMembership.find((row: Entity) => row.id === t.playlist.id).artwork
        .thumbHash,
      redGridHash,
    );
    assert(t.f.peers.every((ip) => !ip.startsWith('127.')));
  } finally {
    await t.close();
  }
});

Deno.test('native entity artwork: playlist edits/privacy, podcast replacement, radio precedence and deletion survive readback/restart', async () => {
  const t = await fixture();
  try {
    const key = (await t.f.login()).credential;
    await t.f.auth.users.create(t.f.admin.id, {
      username: 'reader',
      password: 'password-reader',
      role: 'user',
    });
    const reader =
      (await t.f.login('bearer', 'reader', 'password-reader')).credential;
    const playlist = async () =>
      (await read(t, `playlists/${t.playlist.id}`, reader)).body.playlist
        .artwork as Art;
    const initial = await playlist();
    await image(t, initial, reader);
    await t.playlists.setTracks('admin', t.playlist.id, [t.other.id], true);
    const edited = await playlist();
    assertNotEquals(edited.version, initial.version);
    const changed = await image(t, edited, reader);
    assertEquals(changed.pixels.slice(0, 4), new Uint8Array([0, 0, 0, 255]));
    await playlist();
    assertEquals((await playlist()).thumbHash, black.hash);
    await Deno.writeFile(`${t.root}/music/Artist/Black/cover.png`, redImage);
    const replacedPlaylist = await playlist();
    assertNotEquals(replacedPlaylist.version, edited.version);
    await t.playlists.update('admin', t.playlist.id, { public: false });
    await error(
      await t.f.get(`/api/v1/playlists/${t.playlist.id}`, reader),
      404,
      'not_found',
    );
    await error(
      await t.f.get(edited.url, reader, { 'If-None-Match': '*' }),
      404,
      'not_found',
    );
    assert(
      !(await read(t, 'playlists', reader)).body.playlists.some((row: Entity) =>
        row.id === t.playlist.id
      ),
    );
    const before = await read(t, `podcasts/${t.channelId}`, reader);
    const path = await createPodcastFiles(t.f.cfg.dataDir).saveImage(
      t.channelId,
      blackImage,
      'png',
    );
    await t.f.store.podcasts.image(
      t.channelId,
      path,
      'https://unused.test/black.png',
    );
    const after = await read(
      t,
      `podcasts/${t.channelId}`,
      reader,
      before.etag!,
    );
    assertNotEquals(
      after.body.podcast.artwork.version,
      before.body.podcast.artwork.version,
    );
    assertEquals(
      (await image(t, after.body.podcast.artwork, reader)).bytes,
      blackImage,
    );
    const episode = await read(t, `podcast-episodes/${t.episode.id}`, key);
    assertEquals(
      episode.body.episode.artwork,
      (await read(t, `podcasts/${t.channelId}`, reader)).body.podcast.artwork,
    );
    const station = async () =>
      (await read(t, `radio-stations/${t.station.id}`, reader)).body
        .radioStation.artwork as Art;
    const tile = await station();
    const tileBody = await image(t, tile, reader);
    const upload = await t.f.request(
      `/api/v1/radio-stations/${t.station.id}/artwork`,
      {
        method: 'PUT',
        headers: {
          Cookie: key,
          Origin: t.f.origin,
          'Content-Type': 'image/png',
        },
        body: blackImage as BodyInit,
      },
    );
    assertEquals(upload.status, 200);
    await upload.json();
    const override = await station();
    assertNotEquals(override.version, tile.version);
    assertEquals((await image(t, override, reader)).bytes, blackImage);
    await t.restart();
    assertEquals((await station()).version, override.version);
    const restoredPodcast =
      (await read(t, `podcasts/${t.channelId}`, reader)).body.podcast.artwork;
    assertEquals(restoredPodcast, episode.body.episode.artwork);
    const restoredPlaylist =
      (await read(t, `playlists/${t.playlist.id}`, key)).body.playlist.artwork;
    assertEquals(restoredPlaylist.version, replacedPlaylist.version);
    assertEquals(
      (await image(t, restoredPlaylist, key)).pixels.slice(0, 4),
      new Uint8Array([255, 0, 0, 255]),
    );
    await error(
      await t.f.get(`/api/v1/playlists/${t.playlist.id}`, reader),
      404,
      'not_found',
    );
    const removed = await t.f.request(
      `/api/v1/radio-stations/${t.station.id}/artwork`,
      {
        method: 'DELETE',
        headers: { Cookie: key, Origin: t.f.origin },
      },
    );
    assertEquals(removed.status, 200);
    await removed.json();
    assertEquals(
      (await image(t, await station(), reader)).bytes,
      tileBody.bytes,
    );
    await t.radio.update(t.station.id, { ...t.station, name: 'B' });
    assertNotEquals((await station()).version, tile.version);
    await t.podcasts.deleteChannel(t.channelId);
    await error(
      await t.f.get(`/api/v1/podcasts/${t.channelId}`, key),
      404,
      'not_found',
    );
    await error(
      await t.f.get(`/api/v1/podcast-episodes/${t.episode.id}`, reader),
      404,
      'not_found',
    );
    await error(
      await t.f.get(after.body.podcast.artwork.url, reader, {
        'If-None-Match': '*',
      }),
      404,
      'not_found',
    );
    await t.radio.delete(t.station.id);
    await error(
      await t.f.get(`/api/v1/radio-stations/${t.station.id}`, key),
      404,
      'not_found',
    );
    await error(
      await t.f.get(tile.url, key, { 'If-None-Match': '*' }),
      404,
      'not_found',
    );
  } finally {
    await t.close();
  }
});
