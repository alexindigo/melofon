import { assert, assertAlmostEquals, assertEquals } from '@std/assert';
import { Buffer } from 'node:buffer';
import { Demuxer, Dictionary, Muxer } from 'node-av';
import { parseFile } from 'music-metadata';
import { pathfinder } from '@pathfinder/pathfinder';
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
import { createMedia } from '../src/media.ts';
import { facade } from '../src/facade.ts';
import { loadLayers } from '../src/layers.ts';
import { tagged } from './helpers/tagged.ts';
import { createTagReader } from '../src/scan-tags.ts';

const MP3 =
  'tests/fixtures/library/Fixture Artist/Fixture Album/01 - First Song.mp3';
const recording = '11111111-2222-3333-4444-555555555555';
const release = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

// Fixture-only ID3 frames; preserve real compressed audio packets.
async function mp3(path: string, extras: [string, string][] = []) {
  const original = Buffer.from(await Deno.readFile(MP3));
  const size = (
    n: number,
  ) => [n >> 21 & 127, n >> 14 & 127, n >> 7 & 127, n & 127];
  const skip = 10 + original[6] * 2097152 + original[7] * 16384 +
    original[8] * 128 + original[9];
  const tags: [string, string][] = [
    ['TIT2', 'Metadata Song'],
    ['TPE1', 'Metadata Artist'],
    ['TALB', 'Metadata Album'],
    ['TPE2', 'Metadata Artist'],
    ['TPOS', '2'],
    ['TRCK', '3'],
    ['TCON', 'Jazz\0Fusion'],
    ['TMOO', 'Calm\0Bright'],
    ['TSOT', 'Song Sort'],
    ['TSOA', 'Album Sort'],
    ['TBPM', '123'],
    ['TSST', 'Bonus disc'],
    ['TSRC', 'USAAA1234567\0USBBB1234567'],
    ['TDRL', '2024-02-03'],
    ['TDOR', '1999-04'],
    ['TCMP', '1'],
    ['TPUB', 'Label One\0Label Two'],
    ['TXXX', `MusicBrainz Album Id\0${release}`],
    ['TXXX', 'MusicBrainz Album Type\0album\0live'],
    ['TXXX', 'ALBUMVERSION\0Deluxe'],
    ['TXXX', 'ITUNESADVISORY\u00001'],
    ['TXXX', 'REPLAYGAIN_TRACK_GAIN\u00000 dB'],
    ['TXXX', 'REPLAYGAIN_ALBUM_GAIN\0-4.5 dB'],
    ['TXXX', 'REPLAYGAIN_TRACK_PEAK\u00001.25'],
    ['TXXX', 'REPLAYGAIN_ALBUM_PEAK\u00001.5'],
    ['TXXX', 'R128_TRACK_GAIN\0-2560'],
    ...extras,
  ];
  const frames = tags.map(([id, value]) => {
    const bytes = Buffer.from(value);
    const payload = Buffer.concat([Buffer.from([3]), bytes]);
    return Buffer.concat([
      Buffer.from(id),
      Buffer.from(size(payload.length)),
      Buffer.from([0, 0]),
      payload,
    ]);
  });
  const ufid = Buffer.concat([
    Buffer.from('http://musicbrainz.org\0'),
    Buffer.from(recording),
  ]);
  frames.push(
    Buffer.concat([
      Buffer.from('UFID'),
      Buffer.from(size(ufid.length)),
      Buffer.from([0, 0]),
      ufid,
    ]),
  );
  const comment = Buffer.from('\x03eng\0Metadata comment');
  frames.push(
    Buffer.concat([
      Buffer.from('COMM'),
      Buffer.from(size(comment.length)),
      Buffer.from([0, 0]),
      comment,
    ]),
  );
  const length = frames.reduce((sum, frame) => sum + frame.length, 0);
  await Deno.writeFile(
    path,
    Buffer.concat([
      Buffer.from([73, 68, 51, 4, 0, 0, ...size(length)]),
      ...frames,
      original.subarray(skip),
    ]),
  );
}

async function remux(
  path: string,
  format: 'flac' | 'm4a' | 'opus',
  tags: Record<string, string>,
) {
  const seed = `${path}.seed`;
  if (format === 'opus') {
    const encoded = (await createMedia().transcodeAudio(MP3, 'opus'))!;
    await Deno.writeFile(
      seed,
      new Uint8Array(await new Response(encoded.stream).arrayBuffer()),
    );
    await encoded.completion;
  } else await Deno.copyFile(`tests/fixtures/media/clip.${format}`, seed);
  try {
    await using input = await Demuxer.open(seed);
    await using output = await Muxer.open(path, {
      input,
      format: format === 'm4a' ? 'mp4' : format === 'opus' ? 'ogg' : format,
      configure(ctx) {
        using dict = Dictionary.fromObject(tags);
        ctx.metadata = dict;
      },
    });
    const mapping = new Map(input.streams.map((stream) => {
      const index = output.addStream(stream);
      if (format === 'opus') {
        using dict = Dictionary.fromObject(tags);
        output.getStream(index)!.metadata = dict;
      }
      return [stream.index, index];
    }));
    for await (const packet of input.packets()) {
      if (!packet) continue;
      try {
        await output.writePacket(packet, mapping.get(packet.streamIndex)!);
      } finally {
        packet.free();
      }
    }
    await output.close();
  } finally {
    await Deno.remove(seed);
  }
}

// Fixture-only ISO BMFF tags. moov follows mdat in these generated files, so
// growing ilst never changes a media chunk offset. Product writes use node-av.
async function m4aTags(path: string) {
  const bytes = Buffer.from(await Deno.readFile(path));
  const atom = (name: string, payload: Uint8Array) => {
    const result = Buffer.alloc(payload.length + 8);
    result.writeUInt32BE(result.length);
    result.write(name, 4, 4, 'latin1');
    result.set(payload, 8);
    return result;
  };
  const data = (text: string) =>
    atom(
      'data',
      Buffer.concat([Buffer.from([0, 0, 0, 1, 0, 0, 0, 0]), Buffer.from(text)]),
    );
  const freeform = (key: string, text: string) =>
    atom(
      '----',
      Buffer.concat([
        atom(
          'mean',
          Buffer.concat([Buffer.alloc(4), Buffer.from('com.apple.iTunes')]),
        ),
        atom('name', Buffer.concat([Buffer.alloc(4), Buffer.from(key)])),
        data(text),
      ]),
    );
  const locate = (name: string, start: number, end: number): number => {
    for (let at = start; at + 8 <= end;) {
      const length = bytes.readUInt32BE(at);
      assert(length >= 8 && at + length <= end);
      if (bytes.toString('latin1', at + 4, at + 8) === name) return at;
      at += length;
    }
    throw new Error(`Missing fixture atom ${name}`);
  };
  const moov = locate('moov', 0, bytes.length);
  const udta = locate('udta', moov + 8, moov + bytes.readUInt32BE(moov));
  const meta = locate('meta', udta + 8, udta + bytes.readUInt32BE(udta));
  const ilst = locate('ilst', meta + 12, meta + bytes.readUInt32BE(meta));
  const insert = ilst + bytes.readUInt32BE(ilst);
  const tags = Buffer.concat([
    ...Object.entries({
      'MusicBrainz Track Id': recording,
      'MusicBrainz Album Id': release,
      replaygain_track_gain: '0 dB',
      replaygain_track_peak: '1.25',
      R128_ALBUM_GAIN: '-2560',
      ISRC: 'USAAA1234567',
      MOOD: 'Calm',
      LABEL: 'Native Label',
      'MusicBrainz Album Type': 'album',
      RELEASEDATE: '2024-02',
      ORIGINALDATE: '2001',
      ALBUMVERSION: 'Native edition',
      DISCSUBTITLE: 'Native disc',
    }).map(([key, value]) => freeform(key, value)),
    atom('sonm', data('Song sort')),
    atom('soal', data('Album sort')),
    atom('rtng', atom('data', Buffer.from([0, 0, 0, 21, 0, 0, 0, 0, 2]))),
  ]);
  const result = Buffer.concat([
    bytes.subarray(0, insert),
    tags,
    bytes.subarray(insert),
  ]);
  for (const at of [moov, udta, meta, ilst]) {
    result.writeUInt32BE(bytes.readUInt32BE(at) + tags.length, at);
  }
  await Deno.writeFile(path, result);
}

async function setup(prepare: (root: string) => Promise<unknown>) {
  const dir = await Deno.makeTempDir({ prefix: 'metadata-h7-' });
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
  await seedFirstUser(store, cfg);
  await createLibraries(store).add('Music', root);
  await prepare(root);
  const scan = () => scanLibrary(store);
  await scan();
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
      c: 'h7',
      ...(!xml ? { f: 'json' } : {}),
      ...params,
    });
    return (await app())(new Request(`http://x/rest/${op}?${query}`));
  };
  const get = async (op: string, params: Record<string, string> = {}) =>
    (await (await request(op, params)).json())['subsonic-response'];
  return {
    root,
    dir,
    get,
    request,
    scan,
    store: () => store,
    songs: () => store.catalog.listSongs({ offset: 0, size: 100 }),
    async reopen() {
      await store.close();
      store = await openStore(`${dir}/data`);
    },
    async close() {
      await store.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

Deno.test('H7 ID3v2.4 facts reach getSong, getAlbum and search3 JSON/XML', async () => {
  const s = await setup((root) => mp3(`${root}/song.mp3`));
  try {
    const [song] = await s.songs();
    for (const op of ['getSong', 'getAlbum', 'search3']) {
      const params: Record<string, string> = op === 'getSong'
        ? { id: song.id }
        : op === 'getAlbum'
        ? { id: song.albumId! }
        : { query: 'Metadata' };
      const response = await s.get(op, params);
      assertEquals(response.status, 'ok');
      const child = op === 'getSong'
        ? response.song
        : op === 'getAlbum'
        ? response.album.song[0]
        : response.searchResult3.song[0];
      assertEquals(child.discNumber, 2);
      assertEquals(child.mediaType, 'song');
      assertEquals(child.musicBrainzId, recording);
      assertEquals(child.genres, [{ name: 'Jazz' }, { name: 'Fusion' }]);
      assertEquals(child.genre, 'Jazz');
      assertEquals(child.moods, ['Calm', 'Bright']);
      assertEquals(child.isrc, ['USAAA1234567', 'USBBB1234567']);
      assertEquals(child.comment, 'Metadata comment');
      assertEquals(child.sortName, 'Song Sort');
      assertEquals(child.bpm, 123);
      assertEquals(child.explicitStatus, 'explicit');
      assertEquals(child.replayGain, {
        trackGain: 0,
        albumGain: -4.5,
        trackPeak: 1.25,
        albumPeak: 1.5,
      });
      const details = (await createMedia().describeAudio(song.path))!;
      assertEquals(child.samplingRate, details.audioSamplerate);
      assertEquals(child.channelCount, details.audioChannels);
      assertEquals(child.bitRate, Math.round(details.audioBitrate! / 1000));
      const xml = await (await s.request(op, params, true)).text();
      assert(
        xml.includes('discNumber="2"') && xml.includes('mediaType="song"'),
      );
      assert(xml.includes('<replayGain trackGain="0"'));
      assert(xml.includes('<genres name="Fusion"/>'));
      if (op !== 'getSong') {
        const album = op === 'getAlbum'
          ? response.album
          : response.searchResult3.album[0];
        assertEquals(album.musicBrainzId, release);
        assertEquals(album.recordLabels, [{ name: 'Label One' }, {
          name: 'Label Two',
        }]);
        assertEquals(album.releaseTypes, ['album', 'live']);
        assertEquals(album.releaseDate, { year: 2024, month: 2, day: 3 });
        assertEquals(album.originalReleaseDate, { year: 1999, month: 4 });
        assertEquals(album.discTitles, [{ disc: 2, title: 'Bonus disc' }]);
        assertEquals(album.version, 'Deluxe');
        assertEquals(album.sortName, 'Album Sort');
        assertEquals(album.explicitStatus, 'explicit');
        assertEquals(album.isCompilation, true);
        assert(xml.includes('<releaseDate year="2024" month="2" day="3"/>'));
      }
    }
  } finally {
    await s.close();
  }
});

for (const format of ['flac', 'm4a', 'opus'] as const) {
  Deno.test(`H7 ${format} actual tags and selected audio facts reach the facade`, async () => {
    const s = await setup((root) =>
      remux(`${root}/song.${format}`, format, {
        title: 'Metadata Song',
        album: 'Metadata Album',
        artist: 'Metadata Artist',
        album_artist: 'Metadata Artist',
        disc: '3',
        genre: 'Jazz',
        comment: 'Native comment',
        REPLAYGAIN_TRACK_GAIN: '0 dB',
        REPLAYGAIN_TRACK_PEAK: '1.3',
        R128_ALBUM_GAIN: '-2560',
      })
    );
    try {
      const [song] = await s.songs();
      const child = (await s.get('getSong', { id: song.id })).song;
      const meta = await parseFile(song.path);
      assertEquals(child.title, meta.common.title);
      assertEquals(child.comment, 'Native comment');
      assertEquals(child.discNumber, 3);
      assertEquals(child.genres, [{ name: 'Jazz' }]);
      const details = (await createMedia().describeAudio(song.path))!;
      assertEquals(child.samplingRate, details.audioSamplerate);
      assertEquals(child.channelCount, details.audioChannels);
      assertEquals(child.bitDepth, details.audioBitdepth ?? 0);
      if (format !== 'm4a') {
        assertEquals(child.replayGain.trackGain, 0);
        assertAlmostEquals(child.replayGain.trackPeak, 1.3);
        assertEquals(child.replayGain.albumGain, -5);
      }
      assert(!('baseGain' in child.replayGain));
      for (const op of ['getSong', 'getAlbum', 'search3']) {
        const params: Record<string, string> = op === 'getSong'
          ? { id: song.id }
          : op === 'getAlbum'
          ? { id: song.albumId! }
          : { query: 'Metadata' };
        const xml = await (await s.request(op, params, true)).text();
        assert(xml.includes(`samplingRate="${details.audioSamplerate}"`));
        assert(xml.includes('comment="Native comment"'));
      }
    } finally {
      await s.close();
    }
  });
}

Deno.test('H7 unknown supported facts have JSON defaults and XML omissions', async () => {
  const s = await setup((root) => tagged(`${root}/song.mp3`, {}));
  try {
    const [song] = await s.songs();
    const child = (await s.get('getSong', { id: song.id })).song;
    for (
      const key of ['musicBrainzId', 'sortName', 'explicitStatus', 'comment']
    ) assertEquals(child[key], '');
    for (const key of ['genres', 'moods', 'isrc']) assertEquals(child[key], []);
    assertEquals(child.bpm, 0);
    assertEquals(child.replayGain, {});
    assertEquals(child.mediaType, 'song');
    const album = (await s.get('getAlbum', { id: song.albumId! })).album;
    assertEquals(album.releaseDate, {});
    assertEquals(album.originalReleaseDate, {});
    assertEquals(album.discTitles, []);
    assertEquals(album.isCompilation, false);
    const xml = await (await s.request('getAlbum', { id: song.albumId! }, true))
      .text();
    for (
      const fragment of [
        '<replayGain',
        '<releaseDate',
        '<originalReleaseDate',
        ' explicitStatus=',
        ' comment=',
        ' isCompilation=',
      ]
    ) assert(!xml.includes(fragment), fragment);
  } finally {
    await s.close();
  }
});

Deno.test('H7 M4A native freeform facts, R128 fallback and clean advisory reach JSON/XML consumers', async () => {
  const s = await setup(async (root) => {
    const path = `${root}/song.m4a`;
    await remux(path, 'm4a', {
      title: 'Metadata Song',
      album: 'Metadata Album',
      artist: 'Artist',
      disc: '1',
    });
    await m4aTags(path);
  });
  try {
    const [song] = await s.songs();
    for (const op of ['getSong', 'getAlbum', 'search3']) {
      const params: Record<string, string> = op === 'getSong'
        ? { id: song.id }
        : op === 'getAlbum'
        ? { id: song.albumId! }
        : { query: 'Metadata' };
      const response = await s.get(op, params);
      const child = op === 'getSong'
        ? response.song
        : op === 'getAlbum'
        ? response.album.song[0]
        : response.searchResult3.song[0];
      assertEquals(child.musicBrainzId, recording);
      assertEquals(child.replayGain, {
        trackGain: 0,
        trackPeak: 1.25,
        albumGain: -5,
      });
      assertEquals(child.isrc, ['USAAA1234567']);
      assertEquals(child.moods, ['Calm']);
      assertEquals(child.sortName, 'Song sort');
      assertEquals(child.explicitStatus, 'clean');
      const xml = await (await s.request(op, params, true)).text();
      assert(xml.includes(`musicBrainzId="${recording}"`));
      assert(xml.includes('explicitStatus="clean"'));
      if (op !== 'getSong') {
        const album = op === 'getAlbum'
          ? response.album
          : response.searchResult3.album[0];
        assertEquals(album.musicBrainzId, release);
        assertEquals(album.recordLabels, [{ name: 'Native Label' }]);
        assertEquals(album.releaseDate, { year: 2024, month: 2 });
        assertEquals(album.originalReleaseDate, { year: 2001 });
        assertEquals(album.discTitles, [{ disc: 1, title: 'Native disc' }]);
        assertEquals(album.version, 'Native edition');
        assertEquals(album.sortName, 'Album sort');
        assertEquals(album.explicitStatus, 'clean');
      }
    }
  } finally {
    await s.close();
  }
});

Deno.test('H7 reopen and rescan fill derived metadata without changing kept user state', async () => {
  const s = await setup((root) => mp3(`${root}/song.mp3`));
  try {
    const [song] = await s.songs();
    const q = rawSql(s.store());
    await q.run(`INSERT INTO ratings SELECT id, '${song.id}', 4 FROM users`);
    await q.run(
      `INSERT INTO listens SELECT id, '${song.id}', now(), 1000, 'h7' FROM users`,
    );
    await q.run(
      `INSERT INTO playlists SELECT 'playlist', id, 'Kept', NULL, now(), now() FROM users`,
    );
    await q.run(
      `INSERT INTO playlist_tracks VALUES ('playlist', 0, '${song.id}')`,
    );
    await q.run(
      `INSERT INTO star_events (user_id, target_id, target_type, action, occurred_at) SELECT id, '${song.id}', 'song', 'star', now() FROM users`,
    );
    await q.run(`INSERT INTO candidates
      (id, entity_type, entity_id, kind, source, confidence, state, image_hash, image_ext, library_id, origin, found_at, decided_at, details)
      VALUES ('kept-candidate', 'album', '${song.albumId}', 'fields', 'test', 'strong', 'rejected', 'hash', 'json', '${song.libraryId}', 'test', now(), now(), '{"title":"Keep my decision"}')`);
    const tables = [
      'users',
      'ratings',
      'listens',
      'playlists',
      'playlist_tracks',
      'star_events',
      'candidates',
    ];
    const before = await Promise.all(
      tables.map((table) => q.all(`SELECT * FROM ${table}`)),
    );
    // Model an older catalog: nullable facts are absent until its next scan.
    await q.run('ALTER TABLE files DROP COLUMN track_gain');
    await q.run('ALTER TABLE files DROP COLUMN recording_mbid');
    await s.reopen();
    await s.scan();
    const after = await Promise.all(
      tables.map((table) => rawSql(s.store()).all(`SELECT * FROM ${table}`)),
    );
    assertEquals(after, before);
    const child = (await s.get('getSong', { id: song.id })).song;
    assertEquals(child.musicBrainzId, recording);
    assertEquals(child.replayGain.trackGain, 0);
    assertEquals((await s.songs())[0].firstSeenMs, song.firstSeenMs);
  } finally {
    await s.close();
  }
});

Deno.test('H7 Navidrome list delimiters, first legacy genre and album genre agree across the facade', async () => {
  const s = await setup((root) =>
    mp3(`${root}/song.mp3`, [
      ['TCON', 'Jazz;Fusion/World,Rock'],
      ['TMOO', 'Calm;Bright/Sad'],
      ['TXXX', 'MusicBrainz Album Type\0ep,remix'],
    ])
  );
  try {
    const [song] = await s.songs();
    const child = (await s.get('getSong', { id: song.id })).song;
    assertEquals(
      child.genres,
      ['Jazz', 'Fusion', 'World', 'Rock'].map((name) => ({ name })),
    );
    assertEquals(child.genre, 'Jazz');
    assertEquals(child.moods, ['Calm', 'Bright', 'Sad']);
    const album = (await s.get('getAlbum', { id: song.albumId! })).album;
    assertEquals(album.genre, child.genre);
    assertEquals(album.genres, child.genres);
    assertEquals(album.releaseTypes, ['album', 'live', 'ep', 'remix']);
  } finally {
    await s.close();
  }
});

Deno.test('H7 standard M4A edition date and Vorbis publisher aliases are preserved', async () => {
  const s = await setup(async (root) => {
    await Deno.mkdir(`${root}/m4a`);
    await Deno.mkdir(`${root}/flac`);
    await remux(`${root}/m4a/song.m4a`, 'm4a', {
      title: 'Song',
      album: 'M4A',
      date: '2022-05-06',
    });
    await remux(`${root}/flac/song.flac`, 'flac', {
      title: 'Song',
      album: 'FLAC',
      PUBLISHER: 'Publisher',
      MUSICBRAINZ_ALBUMCOMMENT: 'Special edition',
    });
  });
  try {
    for (const song of await s.songs()) {
      const album = (await s.get('getAlbum', { id: song.albumId! })).album;
      if (song.suffix === 'm4a') {
        assertEquals(album.releaseDate, { year: 2022, month: 5, day: 6 });
      } else {
        assertEquals(album.recordLabels, [{ name: 'Publisher' }]);
        assertEquals(album.version, 'Special edition');
      }
    }
  } finally {
    await s.close();
  }
});

Deno.test('H7 parser timeout terminates synchronous work, skips that file and completes the scan', async () => {
  const s = await setup(async (root) => {
    await mp3(`${root}/slow.mp3`);
    await mp3(`${root}/fast.mp3`);
  });
  try {
    const state = createState(s.store());
    const workerPath = `${s.dir}/slow-worker.ts`;
    const production =
      new URL('../src/scan-tags-worker.ts', import.meta.url).href;
    await Deno.writeTextFile(
      workerPath,
      `import ${JSON.stringify(production)};
      addEventListener('message', (event) => {
        if (event.data.path.endsWith('/slow.mp3')) { while (true) {} }
      });`,
    );
    const reader = createTagReader(state, new URL(`file://${workerPath}`));
    assertEquals(await state.getTyped('scan.tagParseTimeoutSeconds'), 30);
    await state.set('scan.tagParseTimeoutSeconds', '0.5');
    const events: { kind: string; error: string }[] = [];
    const counts = await scanLibrary(
      s.store(),
      undefined,
      {
        event(kind, facts) {
          events.push({
            kind,
            error: String('error' in facts ? facts.error : ''),
          });
        },
      },
      undefined,
      { state, tagReader: reader },
    );
    assertEquals(
      [counts.files, counts.skipped],
      [1, 1],
      JSON.stringify(events),
    );
    assert(
      events.some((event) =>
        event.kind === 'scan_tags_failed' &&
        event.error.includes('exceeded 0.5 seconds')
      ),
    );
    const [song] = await s.songs();
    assert(song.path.endsWith('/fast.mp3'));
    assertEquals(
      (await s.get('getSong', { id: song.id })).song.musicBrainzId,
      recording,
    );
  } finally {
    await s.close();
  }
});

Deno.test('H7 byte budget rejects oversized tags before payload read and continues to valid media', async () => {
  const s = await setup(async (root) => {
    await tagged(`${root}/large.mp3`, { TIT2: 'x'.repeat(10000) });
    await tagged(`${root}/small.mp3`, { TIT2: 'Small' });
  });
  try {
    const state = createState(s.store());
    using reader = createTagReader(state);
    await state.set('scan.tagParseMaxBytes', '8192');
    const counts = await scanLibrary(
      s.store(),
      undefined,
      undefined,
      undefined,
      { state, tagReader: reader },
    );
    assertEquals([counts.files, counts.skipped], [1, 1]);
    const [song] = await s.songs();
    assertEquals((await s.get('getSong', { id: song.id })).song.title, 'Small');
  } finally {
    await s.close();
  }
});

Deno.test('H7 album aggregation merges tags, requires date agreement and gives explicit precedence', async () => {
  const s = await setup(async (root) => {
    await remux(`${root}/a.flac`, 'flac', {
      title: 'A',
      artist: 'Artist',
      album: 'Mixed',
      album_artist: 'Artist',
      MUSICBRAINZ_ALBUMID: release,
      LABEL: 'First',
      RELEASETYPE: 'album',
      MOOD: 'Calm',
      RELEASEDATE: '2024-03',
      ORIGINALDATE: '2000',
      COMPILATION: '0',
      ITUNESADVISORY: '2',
      ALBUMVERSION: 'First version',
      ALBUMSORT: 'Sorted',
      disc: '1',
      DISCSUBTITLE: 'Main',
    });
    await remux(`${root}/b.flac`, 'flac', {
      title: 'B',
      artist: 'Artist',
      album: 'Mixed',
      album_artist: 'Artist',
      MUSICBRAINZ_ALBUMID: 'other',
      LABEL: 'Second',
      RELEASETYPE: 'live',
      MOOD: 'Bright',
      RELEASEDATE: '2024-04',
      ORIGINALDATE: '2000',
      COMPILATION: '1',
      ITUNESADVISORY: '1',
      ALBUMVERSION: 'Second version',
      disc: '2',
      DISCSUBTITLE: 'Bonus',
    });
    await remux(`${root}/c.flac`, 'flac', {
      title: 'C',
      artist: 'Artist',
      album: 'Mixed',
      album_artist: 'Artist',
      MUSICBRAINZ_ALBUMID: release,
      LABEL: 'First',
      RELEASEDATE: '2024-03',
      ORIGINALDATE: '2000',
    });
  });
  try {
    const [song] = await s.songs();
    let album = (await s.get('getAlbum', { id: song.albumId! })).album;
    assertEquals(album.musicBrainzId, release);
    assertEquals(album.recordLabels, [{ name: 'First' }, { name: 'Second' }]);
    assertEquals(album.releaseTypes, ['album', 'live']);
    assertEquals(album.moods, ['Calm', 'Bright']);
    assertEquals(album.releaseDate, {});
    assertEquals(album.originalReleaseDate, { year: 2000 });
    assertEquals(album.isCompilation, true);
    assertEquals(album.explicitStatus, 'explicit');
    assertEquals(album.version, 'First version');
    assertEquals(album.sortName, 'Sorted');
    assertEquals(album.discTitles, [{ disc: 1, title: 'Main' }, {
      disc: 2,
      title: 'Bonus',
    }]);
    await Deno.remove(`${s.root}/b.flac`);
    await s.scan();
    album = (await s.get('getAlbum', { id: song.albumId! })).album;
    assertEquals(album.explicitStatus, 'clean');
    assertEquals(album.releaseDate, { year: 2024, month: 3 });
  } finally {
    await s.close();
  }
});

Deno.test('H7 multiple audio streams report the stream selected by the playback engine', async () => {
  const s = await setup(async (root) => {
    const opusPath = `${root}/.second`;
    const encoded = (await createMedia().transcodeAudio(MP3, 'opus', {
      sampleRate: 48000,
      channels: 2,
    }))!;
    await Deno.writeFile(
      opusPath,
      new Uint8Array(await new Response(encoded.stream).arrayBuffer()),
    );
    await encoded.completion;
    await using first = await Demuxer.open(MP3);
    await using second = await Demuxer.open(opusPath);
    await using output = await Muxer.open(`${root}/multi.mkv`, {
      format: 'matroska',
      input: first,
    });
    const a = first.audio()!, b = second.audio()!;
    const aIndex = output.addStream(a), bIndex = output.addStream(b);
    for (
      const [input, stream, index] of [[first, a, aIndex], [
        second,
        b,
        bIndex,
      ]] as const
    ) {
      for await (const packet of input.packets(stream.index)) {
        if (!packet) continue;
        try {
          await output.writePacket(packet, index);
        } finally {
          packet.free();
        }
      }
    }
    await output.close();
    await Deno.remove(opusPath);
  });
  try {
    const [song] = await s.songs();
    await using input = await Demuxer.open(song.path);
    const streams = input.streams.filter((stream) =>
      stream.codecpar.sampleRate > 0
    );
    assertEquals(streams.length, 2);
    assertEquals(
      streams.map((
        stream,
      ) => [
        stream.codecpar.sampleRate,
        stream.codecpar.channelLayout.nbChannels,
      ]),
      [[44100, 1], [48000, 2]],
    );
    const child = (await s.get('getSong', { id: song.id })).song;
    assertEquals([child.samplingRate, child.channelCount], [
      input.audio()!.codecpar.sampleRate,
      input.audio()!.codecpar.channelLayout.nbChannels,
    ]);
    const pcm = await createMedia().decodePcm(song.path);
    assert(pcm);
    let bytes = 0;
    for await (const chunk of pcm) bytes += chunk.length;
    assert(bytes > 0);
  } finally {
    await s.close();
  }
});
