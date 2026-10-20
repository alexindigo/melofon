import { assert, assertEquals, assertRejects, assertThrows } from '@std/assert';
import { Demuxer, Dictionary, Muxer } from 'node-av';
import { createReference } from '../src/reference.ts';
import { referenceSimilarity } from '../src/reference-matcher.ts';
import { parseReferenceValues } from '../src/lookups/reference-values.ts';
import type { ExternalTrack } from '../src/reference-types.ts';
import { rawSql } from '../src/store/testing.ts';
import { tagged } from './helpers/tagged.ts';
import { referenceFixture } from './helpers/reference.ts';

const artistMbid = '11111111-1111-4111-8111-111111111111';
const recording = '22222222-2222-4222-8222-222222222222';

Deno.test('reference matcher: real catalog, exact phases, fuzzy threshold, user ties and ordered artist resolution', async () => {
  const f = await referenceFixture();
  const capability = {
    id: 'artist',
    accepts: 'artist' as const,
    provides: [
      'artist.topTracks',
      'artist.similar',
    ] as ('artist.topTracks' | 'artist.similar')[],
    requires: [],
  };
  const reference = createReference({
    store: f.store,
    state: f.state,
    providers: () => Promise.resolve([{ plugin: 'fixture', capability }]),
    enqueue: async () => {},
  });
  try {
    const fixtures: Record<string, Record<string, string>> = {
      'isrc.mp3': {
        TIT2: 'ISRC result',
        TPE1: 'Other',
        TSRC: 'USAAA0100001\0USAAA0100004',
      },
      'a.mp3': {
        TIT2: 'Bohemian Rhapsody',
        TALB: 'Album A',
        TPE1: 'The Béatles',
        TXXX: `MusicBrainz Artist Id\0${artistMbid}`,
      },
      'b.mp3': {
        TIT2: 'Bohemian Rhapsody',
        TALB: 'Album B',
        TPE1: 'The Béatles',
        TXXX: `MusicBrainz Artist Id\0${artistMbid}`,
      },
      'near.mp3': { TIT2: 'Bohemian Rhapsody Live', TPE1: 'The Béatles' },
      'cover.mp3': {
        TIT2: 'Bohemian Rhapsody',
        TPE1: 'Impostor',
        TPE2: 'The Béatles',
      },
      'missing.mp3': { TIT2: 'Absent', TPE1: 'Gone', TSRC: 'USAAA0100099' },
    };
    for (const [path, tags] of Object.entries(fixtures)) {
      await tagged(`${f.root}/${path}`, tags);
    }
    // FLAC carries a recording MBID and two ISRCs; its real duration differs
    // from the MP3 fixtures, so proximity is tested without catalog mutation.
    await using input = await Demuxer.open('tests/fixtures/media/clip.flac');
    await using output = await Muxer.open(`${f.root}/long.flac`, {
      input,
      format: 'flac',
      configure(ctx) {
        using dict = Dictionary.fromObject({
          title: 'Bohemian Rhapsody',
          album: 'Album C',
          artist: 'The Béatles',
          MUSICBRAINZ_TRACKID: recording,
          ISRC: 'USAAA0100002; USAAA0100003',
        });
        ctx.metadata = dict;
      },
    });
    const stream = output.addStream(input.streams[0]);
    for await (const packet of input.packets()) {
      if (!packet) continue;
      try {
        await output.writePacket(packet, stream);
      } finally {
        packet.free();
      }
    }
    await output.close();
    await f.scan.run();
    const songs = await f.store.catalog.listSongs({ offset: 0, size: 100 });
    const byFile = (name: string) =>
      songs.find((s) => s.path.endsWith('/' + name))!;
    const a = byFile('a.mp3'), b = byFile('b.mp3'), long = byFile('long.flac');
    const artist = a.artistId!;
    assert(a.durationMs !== long.durationMs);
    const http = await f.consumer(reference);
    const top = async (tracks: ExternalTrack[], count = 100) => {
      await reference.record('artist', artist, 'fixture', capability.provides, {
        'artist.topTracks': tracks,
      });
      return reference.topTracks(artist, count, 'admin');
    };
    assertEquals(await f.state.getTyped('reference.matchThreshold'), 0.85);
    assert(
      Math.abs(referenceSimilarity('MARTHA', 'MARHTA') - 0.9611111111111111) <
        1e-12,
    );
    assertEquals(referenceSimilarity('Café', 'CAFE'), 1);
    assertEquals(referenceSimilarity('', 'abc'), 0);
    await assertRejects(() => f.state.set('reference.matchThreshold', '1.1'));
    const fuzzy = { title: 'Bohemian Rhapsody', artist: 'beatles' };
    await http('star', { id: byFile('cover.mp3').id });
    assertEquals(
      await top([{ ...fuzzy, durationMs: a.durationMs!, album: 'Album B' }]),
      [b.id],
      'a starred cover with this album artist is not this performer',
    );
    assertEquals(
      await top([{ ...fuzzy, mbid: recording, isrc: 'USAAA0100001' }]),
      [long.id],
      'recording beats ISRC and title',
    );
    assertEquals(
      await top([{ title: 'Wrong', mbid: artistMbid, isrc: 'USAAA0100001' }]),
      [byFile('isrc.mp3').id],
      'unknown recording falls through to ISRC',
    );
    assertEquals(byFile('isrc.mp3').metadata?.isrc, [
      'USAAA0100001',
      'USAAA0100004',
    ]);
    assertEquals(await top([{ title: 'Wrong', isrc: 'USAAA0100004' }]), [
      byFile('isrc.mp3').id,
    ], 'any tagged ISRC is eligible');
    const isrcs = long.metadata!.isrc!;
    assert(isrcs.length > 0);
    assertEquals(await top([{ title: 'Wrong', isrc: isrcs.at(-1) }]), [
      long.id,
    ]);
    assertEquals(await top([{ ...fuzzy, durationMs: long.durationMs! }]), [
      long.id,
    ]);
    await http('star', { id: b.id });
    assertEquals(await top([{ ...fuzzy, durationMs: a.durationMs! }]), [b.id]);
    assertEquals(await top([{ ...fuzzy, durationMs: long.durationMs! }]), [
      long.id,
    ], 'duration before preference');
    assertEquals(
      (await http('getSong', { id: b.id })).song.starred !== undefined,
      true,
    );
    await http('unstar', { id: b.id });
    await http('setRating', { id: a.id, rating: '4' });
    assertEquals(
      await top([{ ...fuzzy, durationMs: a.durationMs!, album: 'Album B' }]),
      [a.id],
      'rating before album',
    );
    await http('setRating', { id: a.id, rating: '3' });
    assertEquals(
      await top([{ ...fuzzy, durationMs: a.durationMs!, album: 'Album B' }]),
      [b.id],
      'album is final tie break',
    );
    // Another user's preference cannot affect this user's choice.
    await rawSql(f.store).run(
      "INSERT INTO users (id,name,password_enc,created_at,role) VALUES ('other','other','unused',now(),'user')",
    );
    await f.annotation.star('other', a.id);
    assertEquals(
      await top([{ ...fuzzy, durationMs: a.durationMs!, album: 'Album B' }]),
      [b.id],
    );
    assertEquals(await reference.topTracks(artist, 100, 'other'), [a.id]);
    assertEquals(
      await top([{
        ...fuzzy,
        artist: 'Other',
        artistMbid,
        durationMs: a.durationMs!,
        album: 'Album B',
      }]),
      [b.id],
      'artist MBID scopes fuzzy query before a conflicting local name',
    );
    const near = { title: 'Bohemian Rhapsody Remaster', artist: 'beatles' };
    assert(referenceSimilarity(near.title, fuzzy.title) >= 0.85);
    assert((await top([near])).length === 1);
    await f.state.set('reference.matchThreshold', '1');
    assertEquals(await top([near]), []);
    assertEquals(
      (await top([fuzzy])).length,
      1,
      'title threshold is inclusive',
    );
    assertEquals(
      await top([{ title: 'Entirely unrelated', artist: 'beatles' }]),
      [],
    );
    await f.state.set('reference.matchThreshold', '0.85');
    const exact = { title: 'Wrong', mbid: recording };
    const isrc = { title: 'Wrong', isrc: 'USAAA0100001' };
    assertEquals(
      await top([isrc, exact, exact, { title: 'Absent', artist: 'Nobody' }, {
        ...fuzzy,
        durationMs: a.durationMs!,
        album: 'Album B',
      }]),
      [byFile('isrc.mp3').id, long.id, b.id],
    );
    assertEquals(await reference.topTracks(artist, 1, 'admin'), [
      byFile('isrc.mp3').id,
    ]);
    assertEquals(await reference.topTracks(artist, 0, 'admin'), []);
    await reference.record('artist', artist, 'fixture', capability.provides, {
      'artist.similar': [
        { name: 'Other', mbid: artistMbid },
        { name: 'BEATLES' },
        { name: 'Ghost', mbid: recording },
        { name: 'Other' },
      ],
    });
    assertEquals(await reference.similarArtists(artist, 10), [
      { present: true, id: artist },
      { present: true, id: artist },
      { present: false, name: 'Ghost', mbid: recording },
      { present: true, id: byFile('isrc.mp3').artistId! },
    ]);
    await f.state.set('reference.ignoredArticles', '');
    assertEquals(await reference.similarArtists(artist, 2), [{
      present: true,
      id: artist,
    }, { present: false, name: 'BEATLES' }]);
    await Deno.remove(`${f.root}/missing.mp3`);
    await f.scan.run();
    assertEquals(
      await top([{ title: 'Absent', artist: 'Gone', isrc: 'USAAA0100099' }]),
      [],
    );
    // Explicit missing-identity flag is honored even while a catalog row exists.
    await rawSql(f.store).run(
      `UPDATE file_identity SET present = false WHERE id = '${long.id}'`,
    );
    assertEquals(
      await top([{ title: 'Wrong', mbid: recording, isrc: isrcs[0] }]),
      [],
    );
    assertThrows(() =>
      parseReferenceValues({
        'track.similar': [{ title: 'X', artistMbid: 'invalid' }],
      }, ['track.similar'])
    );
    assertEquals(
      parseReferenceValues({ 'track.similar': [{ title: 'X', artistMbid }] }, [
        'track.similar',
      ]),
      { 'track.similar': [{ title: 'X', artistMbid }] },
    );
  } finally {
    await f.close();
  }
});
