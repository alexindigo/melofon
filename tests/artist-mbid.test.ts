import { assert, assertEquals } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { Demuxer, Dictionary, Muxer } from 'node-av';
import { openStore } from '../src/store/index.ts';
import { rawSql } from '../src/store/testing.ts';
import { seedFirstUser } from '../src/users.ts';
import { createUserService } from '../src/user.ts';
import { createLibraries } from '../src/libraries.ts';
import { createLibrary } from '../src/library.ts';
import { createState } from '../src/state.ts';
import { createAnnotation } from '../src/annotation.ts';
import { createListens } from '../src/listens.ts';
import { scanLibrary } from '../src/scan.ts';
import { stableId } from '../src/albums.ts';
import { facade } from '../src/facade.ts';
import { loadLayers } from '../src/layers.ts';
import { tagged } from './helpers/tagged.ts';

const low = '11111111-1111-4111-8111-111111111111';
const high = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const other = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

// Same real-packet FLAC remux pattern as metadata-h7.test.ts.
async function flac(path: string, tags: Record<string, string>) {
  await using input = await Demuxer.open('tests/fixtures/media/clip.flac');
  await using output = await Muxer.open(path, {
    input,
    format: 'flac',
    configure(ctx) {
      using dict = Dictionary.fromObject(tags);
      ctx.metadata = dict;
    },
  });
  const mapping = new Map(
    input.streams.map((stream) => [stream.index, output.addStream(stream)]),
  );
  for await (const packet of input.packets()) {
    if (!packet) continue;
    try {
      await output.writePacket(packet, mapping.get(packet.streamIndex)!);
    } finally {
      packet.free();
    }
  }
  await output.close();
}

Deno.test('artist MBIDs: real tags, all ArtistID3 consumers, retagging and upgrade', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'artist-mbid-' });
  const root = `${dir}/music`;
  await Deno.mkdir(root);
  let store = await openStore(`${dir}/data`);
  const cfg = {
    listen: undefined,
    dataDir: `${dir}/data`,
    user: 'admin',
    password: 'test',
    secret: 'secret',
  };
  const mp3Tags = (id: string) => ({
    TIT2: 'First',
    TALB: 'Majority Album',
    // Melofon reads the first name/id, not the second credit.
    TPE1: 'Majority\0Second Credit',
    TXXX: `MusicBrainz Artist Id\0${id}\0${other}`,
  });
  try {
    await seedFirstUser(store, cfg);
    const library = await createLibraries(store).add('Music', root);
    await tagged(`${root}/a.mp3`, mp3Tags(low));
    await flac(`${root}/b.flac`, {
      title: 'Second',
      album: 'Majority Album',
      artist: 'Majority',
      MUSICBRAINZ_ARTISTID: high,
    });
    await flac(`${root}/c.flac`, {
      title: 'Album artist vote',
      album: 'Other Album',
      artist: 'Performer',
      album_artist: 'Majority',
      MUSICBRAINZ_ARTISTID: other,
      MUSICBRAINZ_ALBUMARTISTID: high,
    });
    // Reverse lexical/path order so a traversal-first tie implementation fails.
    await tagged(`${root}/d.mp3`, {
      TIT2: 'Tie high',
      TALB: 'Tie Album',
      TPE1: 'Tie',
      TXXX: `MusicBrainz Artist Id\0${high}`,
    });
    await tagged(`${root}/e.mp3`, {
      TIT2: 'Tie low',
      TALB: 'Tie Album',
      TPE1: 'Tie',
      TXXX: `MusicBrainz Artist Id\0${low}`,
    });
    await tagged(`${root}/f.mp3`, {
      TIT2: 'Album only',
      TALB: 'Album Only',
      TPE2: 'Album Only\0Other Album Credit',
      TXXX: `MusicBrainz Album Artist Id\0${low}\0${other}`,
    });
    await tagged(`${root}/g.mp3`, {
      TIT2: 'No id',
      TALB: 'Untagged Album',
      TPE1: 'Untagged',
    });
    // An id without its corresponding name must not attach to an inferred artist.
    await flac(`${root}/h.flac`, {
      title: 'Orphan album id',
      album: 'Untagged Album',
      artist: 'Untagged',
      MUSICBRAINZ_ALBUMARTISTID: other,
    });
    await tagged(`${root}/i.mp3`, { TIT2: 'Unknown', TALB: 'Unknown Album' });
    await tagged(`${root}/j.mp3`, {
      TIT2: 'Various one',
      TALB: 'Various Album',
      TPE1: 'Guest One',
    });
    await tagged(`${root}/k.mp3`, {
      TIT2: 'Various two',
      TALB: 'Various Album',
      TPE1: 'Guest Two',
    });
    // The same artist in both roles gets one vote per file, not a bonus vote.
    await flac(`${root}/l.flac`, {
      title: 'Double role',
      album: 'Double Album',
      artist: 'Double',
      album_artist: 'Double',
      MUSICBRAINZ_ARTISTID: high,
      MUSICBRAINZ_ALBUMARTISTID: high,
    });
    await tagged(`${root}/m.mp3`, {
      TIT2: 'Single role',
      TALB: 'Double Album',
      TPE1: 'Double',
      TXXX: `MusicBrainz Artist Id\0${low}`,
    });
    await scanLibrary(store);
    const app = async () => {
      const state = createState(store);
      return facade(
        await pathfinder({ roots: ['core/'], app: { store, cfg, state } }),
        await loadLayers({
          app: {
            cfg,
            state,
            library: createLibrary(store),
            libraries: createLibraries(store),
            user: createUserService(store, cfg),
            annotation: createAnnotation(store),
            listens: createListens(store),
          },
        }),
      );
    };
    const request = async (
      op: string,
      params: Record<string, string> = {},
      xml = false,
    ) => {
      const query = new URLSearchParams({
        u: 'admin',
        p: 'test',
        v: '1.16.1',
        c: 'g5',
        ...(!xml ? { f: 'json' } : {}),
        ...params,
      });
      const response = await (await app())(
        new Request(`http://x/rest/${op}?${query}`),
      );
      assertEquals(response.status, 200);
      return response;
    };
    const get = async (op: string, params: Record<string, string> = {}) => {
      const body =
        (await (await request(op, params)).json())['subsonic-response'];
      assertEquals(body.status, 'ok');
      return body;
    };
    const majorityId = await stableId('artist', 'Majority');
    const expected = new Map([
      ['Majority', high],
      ['Tie', low],
      ['Album Only', low],
      ['Double', low],
      ['Untagged', ''],
      ['[Unknown Artist]', ''],
      ['[Various Artists]', ''],
    ]);
    const listing = (await get('getArtists')).artists.index.flatMap(
      (
        index: {
          artist: { id: string; name: string; musicBrainzId: string }[];
        },
      ) => index.artist,
    );
    assertEquals(listing.length, expected.size);
    for (const artist of listing) {
      assertEquals(
        artist.musicBrainzId,
        expected.get(artist.name),
        artist.name,
      );
      const detail = (await get('getArtist', { id: artist.id })).artist;
      assertEquals(
        detail.musicBrainzId,
        expected.get(artist.name),
        artist.name,
      );
      const xml = await (await request('getArtist', { id: artist.id }, true))
        .text();
      if (artist.musicBrainzId) {
        assert(xml.includes(`musicBrainzId="${artist.musicBrainzId}"`));
      } else {
        // Existing XML empty-field representation: omit the empty attribute.
        assert(!/<artist\b[^>]*\bmusicBrainzId=/.test(xml));
      }
    }
    for (const op of ['search3', 'search2']) {
      const result = (await get(op, { query: 'Majority' }))[
        op === 'search3' ? 'searchResult3' : 'searchResult2'
      ];
      assertEquals(result.artist[0].musicBrainzId, high);
    }
    await get('star', { artistId: majorityId });
    assertEquals(
      (await get('getStarred2')).starred2.artist[0].musicBrainzId,
      high,
    );
    const scoped = (await get('getArtists', { musicFolderId: library.id }))
      .artists.index.flatMap(
        (index: { artist: { name: string; musicBrainzId: string }[] }) =>
          index.artist,
      );
    assertEquals(
      scoped.map((
        a: { name: string; musicBrainzId: string },
      ) => [a.name, a.musicBrainzId]),
      listing.map((
        a: { name: string; musicBrainzId: string },
      ) => [a.name, a.musicBrainzId]),
    );
    const songs = await store.catalog.listSongs({ offset: 0, size: 100 });
    const first = songs.find((song) => song.path.endsWith('/a.mp3'))!;
    assertEquals(first.metadata?.artistMbid, low);
    const albumVote = songs.find((song) => song.path.endsWith('/c.flac'))!;
    assertEquals(albumVote.metadata?.albumArtistMbid, high);
    assertEquals(
      (await store.catalog.artistById(await stableId('artist', 'Performer')))
        ?.musicBrainzId,
      other,
    );

    await tagged(`${root}/a.mp3`, mp3Tags(high));
    await flac(`${root}/b.flac`, {
      title: 'Second',
      album: 'Majority Album',
      artist: 'Majority',
      MUSICBRAINZ_ARTISTID: low,
    });
    await flac(`${root}/c.flac`, {
      title: 'Album artist vote',
      album: 'Other Album',
      artist: 'Performer',
      album_artist: 'Majority',
      MUSICBRAINZ_ARTISTID: other,
      MUSICBRAINZ_ALBUMARTISTID: low,
    });
    await flac(`${root}/l.flac`, {
      title: 'Double role',
      album: 'Double Album',
      artist: 'Double',
      album_artist: 'Double',
    });
    await tagged(`${root}/m.mp3`, {
      TIT2: 'Single role',
      TALB: 'Double Album',
      TPE1: 'Double',
    });
    await scanLibrary(store);
    assertEquals(
      (await get('getArtist', { id: majorityId })).artist.musicBrainzId,
      low,
    );
    assertEquals(
      (await get('getArtist', { id: await stableId('artist', 'Double') }))
        .artist.musicBrainzId,
      '',
    );
    const retagged = await store.catalog.getSong(first.id);
    assertEquals(retagged?.firstSeenMs, first.firstSeenMs);
    assertEquals(retagged?.albumId, first.albumId);
    assertEquals((await get('getStarred2')).starred2.artist[0].id, majorityId);

    // A genuine pre-g5 table shape: reopen must migrate, leaving facts unknown
    // until a scan. Kept identities and the star survive the upgrade.
    const q = rawSql(store);
    await q.run('ALTER TABLE artists DROP COLUMN musicbrainz_id');
    await q.run('ALTER TABLE files DROP COLUMN artist_mbid');
    await q.run('ALTER TABLE files DROP COLUMN album_artist_mbid');
    await store.close();
    store = await openStore(`${dir}/data`);
    assertEquals(
      (await get('getArtist', { id: majorityId })).artist.musicBrainzId,
      '',
    );
    assertEquals(
      (await store.catalog.getSong(first.id))?.metadata?.artistMbid,
      null,
    );
    assertEquals(
      (await store.catalog.getSong(albumVote.id))?.metadata?.albumArtistMbid,
      null,
    );
    await scanLibrary(store);
    assertEquals(
      (await get('getArtist', { id: majorityId })).artist.musicBrainzId,
      low,
    );
    const migrated = await store.catalog.getSong(first.id);
    assertEquals(migrated?.metadata?.artistMbid, high);
    assertEquals(
      (await store.catalog.getSong(albumVote.id))?.metadata?.albumArtistMbid,
      low,
    );
    assertEquals(migrated?.firstSeenMs, first.firstSeenMs);
    assertEquals(migrated?.albumId, first.albumId);
    assertEquals(
      (await get('getStarred2')).starred2.artist[0].musicBrainzId,
      low,
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
