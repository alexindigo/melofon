import { assert, assertEquals } from '@std/assert';
import { Demuxer } from 'node-av';
import { Buffer } from 'node:buffer';
import { rawSql } from '../src/store/testing.ts';
import { scanLibrary } from '../src/scan.ts';
import { h9Setup, type Playlist, quote } from './helpers/h9.ts';

Deno.test('H9 playlist visibility, rights, readonly, username and artwork share core authorization', async (t) => {
  const s = await h9Setup();
  try {
    const songId = s.songs[0].id;
    const create = async (user: string, name: string, public_?: boolean) =>
      (await s.ok(
        'createPlaylist',
        {
          name,
          songId,
          ...(public_ === undefined ? {} : { public: String(public_) }),
        },
        user,
        true,
      )).playlist;
    const a = await create('alice', 'Alice private');
    const ap = await create('alice', 'Alice public', true);
    const b = await create('bob', 'Bob private');
    const bp = await create('bob', 'Bob public', true);
    const admin = await create('admin', 'Admin private');
    const ids = (rows: Playlist[]) => rows.map((r) => r.id).sort();
    await t.step(
      'list and get expose own plus public, admins all; owner and readonly are caller-relative',
      async () => {
        assertEquals([a.public, a.readonly, a.owner], [false, false, 'alice']);
        assertEquals(
          ids((await s.ok('getPlaylists', {}, 'alice')).playlists.playlist),
          ids([a, ap, bp]),
        );
        assertEquals(
          ids((await s.ok('getPlaylists', {}, 'bob')).playlists.playlist),
          ids([ap, b, bp]),
        );
        assertEquals(
          ids((await s.ok('getPlaylists')).playlists.playlist),
          ids([a, ap, b, bp, admin]),
        );
        for (
          const [user, list, readonly] of [['alice', a, false], [
            'bob',
            ap,
            true,
          ], ['admin', a, true]] as const
        ) {
          const got =
            (await s.ok('getPlaylist', { id: list.id }, user)).playlist;
          assertEquals([got.owner, got.readonly], ['alice', readonly]);
        }
        await s.error(70, 'getPlaylist', { id: a.id }, 'bob');
        for (const user of ['alice', 'bob', 'admin']) {
          await s.error(70, 'getPlaylist', { id: 'unknown' }, user);
        }
      },
    );
    await t.step(
      'non-owner updates and replacement return 50 when visible, 70 when hidden, including admins',
      async () => {
        for (
          const [user, list, code] of [['bob', ap, 50], ['bob', a, 70], [
            'admin',
            a,
            50,
          ]] as const
        ) {
          await s.error(code, 'updatePlaylist', {
            playlistId: list.id,
            name: 'stolen',
            public: 'true',
            songIdToAdd: 'unknown',
          }, user);
          await s.error(
            code,
            'createPlaylist',
            { playlistId: list.id, songId },
            user,
          );
        }
        assertEquals(
          (await s.ok('getPlaylist', { id: a.id }, 'alice')).playlist.name,
          a.name,
        );
        await s.error(50, 'deletePlaylist', { id: ap.id }, 'bob');
        await s.error(70, 'deletePlaylist', { id: a.id }, 'bob');
        await s.ok('deletePlaylist', { id: b.id });
        await s.error(70, 'getPlaylist', { id: b.id });
      },
    );
    await t.step(
      'username is admin-only and selects the target own plus public view',
      async () => {
        for (const user of ['alice', 'bob']) {
          for (const username of [user, 'unknown']) {
            await s.error(50, 'getPlaylists', { username }, user);
          }
        }
        await s.error(70, 'getPlaylists', { username: 'unknown' });
        const rows =
          (await s.ok('getPlaylists', { username: 'bob' })).playlists.playlist;
        assertEquals(ids(rows), ids([ap, bp]));
        assertEquals(
          rows.every((p) => p.readonly),
          true,
          'readonly uses caller, not target user',
        );
      },
    );
    await t.step(
      'public toggles gate cover art even after the image is cached',
      async () => {
        const cover = async (user: string) => {
          const res = await s.request('getCoverArt', { id: a.coverArt }, user);
          assertEquals(res.status, 200);
          assert(res.headers.get('content-type')?.startsWith('image/'));
          const bytes = new Uint8Array(await res.arrayBuffer());
          const demux = await Demuxer.open(Buffer.from(bytes));
          try {
            assert(demux.video());
            assert(demux.video()!.codecpar.width > 0);
            assert(demux.video()!.codecpar.height > 0);
          } finally {
            await demux.close();
          }
          return bytes;
        };
        const bytes = await cover('alice');
        assertEquals(await cover('admin'), bytes);
        await s.error(70, 'getCoverArt', { id: a.coverArt }, 'bob');
        await s.ok(
          'updatePlaylist',
          { playlistId: a.id, public: 'true' },
          'alice',
          true,
        );
        assertEquals(
          (await s.ok('getPlaylist', { id: a.id }, 'bob')).playlist.public,
          true,
        );
        assertEquals(await cover('bob'), bytes);
        await s.ok('createPlaylist', {
          playlistId: a.id,
          songId,
          public: 'false',
        }, 'alice');
        await s.error(70, 'getPlaylist', { id: a.id }, 'bob');
        await s.error(70, 'getCoverArt', { id: a.coverArt }, 'bob');
        await s.ok(
          'updatePlaylist',
          { playlistId: a.id, public: 'ON' },
          'alice',
        );
        const xml = await s.request(
          'getPlaylist',
          { id: a.id, f: 'xml' },
          'bob',
        );
        assert(
          /owner="alice" public="true" readonly="true"/.test(await xml.text()),
        );
        await s.ok('updatePlaylist', { playlistId: a.id, public: '' }, 'alice');
        await s.error(70, 'getPlaylist', { id: a.id }, 'bob');
        await s.ok('deletePlaylist', { id: ap.id }, 'alice');
        await s.error(70, 'getPlaylist', { id: ap.id });
      },
    );
    await t.step(
      'OwnTone lists and search stay scoped to seeded-user own playlists',
      async () => {
        const rows = (await s.own('library/playlists')).items;
        assertEquals(rows.map((p: { name: string }) => p.name), [admin.name]);
        const search = await s.own('search?query=public&type=playlist');
        assertEquals(search.playlists.items, []);
      },
    );
  } finally {
    await s.close();
  }
});

Deno.test('H9 visible occurrences govern entries, counts, duration, atomic removal and OwnTone', async (t) => {
  const s = await h9Setup();
  try {
    const [a, missing, b] = s.songs;
    const list = (await s.ok('createPlaylist', {
      name: 'Kept',
      songId: [a.id, missing.id, b.id, a.id],
    })).playlist;
    await rawSql(s.store).run(
      `DELETE FROM files WHERE id = ${quote(missing.id)}`,
    );
    const check = async (expected: string[]) => {
      const got = (await s.ok('getPlaylist', { id: list.id })).playlist;
      assertEquals(got.entry.map((e) => e.id), expected);
      assertEquals(got.songCount, expected.length);
      const duration = expected.reduce(
        (sum, id) => sum + s.songs.find((song) => song.id === id)!.duration_ms,
        0,
      );
      assertEquals(got.duration, Math.round(duration / 1000));
      const rows = (await s.ok('getPlaylists')).playlists.playlist;
      assertEquals([rows[0].songCount, rows[0].duration], [
        got.songCount,
        got.duration,
      ]);
      const own = (await s.own('library/playlists')).items[0];
      const tracks = await s.own(`library/playlists/${own.id}/tracks`);
      assertEquals([own.item_count, tracks.total, tracks.items.length], [
        expected.length,
        expected.length,
        expected.length,
      ]);
      return got;
    };
    await t.step(
      'missing middle entry and duplicates are not counted but remain stored',
      async () => {
        await check([a.id, b.id, a.id]);
      },
    );
    await t.step(
      'visible index removes the selected occurrence and never the hidden row',
      async () => {
        await s.ok('updatePlaylist', {
          playlistId: list.id,
          songIndexToRemove: ['1', '1', '999'],
        });
        await check([a.id, a.id]);
        assertEquals(
          await rawSql(s.store).all(
            'SELECT track_id FROM playlist_tracks ORDER BY position',
          ),
          [a.id, missing.id, a.id].map((track_id) => ({ track_id })),
        );
        await s.ok('updatePlaylist', {
          playlistId: list.id,
          songIndexToRemove: '1',
          songIdToAdd: ['unknown', b.id],
        });
        await check([a.id, b.id]);
      },
    );
    await t.step(
      'unknown add succeeds and a returning stable song reappears in stored order',
      async () => {
        await scanLibrary(s.store);
        await check([a.id, missing.id, b.id]);
        assertEquals(
          await rawSql(s.store).all(
            'SELECT track_id FROM playlist_tracks ORDER BY position',
          ),
          [a.id, missing.id, 'unknown', b.id].map((track_id) => ({ track_id })),
        );
      },
    );
    await t.step(
      'concurrent indexed edits serialize against each operation visible list',
      async () => {
        await s.ok('createPlaylist', {
          playlistId: list.id,
          songId: [a.id, 'unknown', b.id, a.id],
        });
        await Promise.all(
          [0, 1].map(() =>
            s.ok('updatePlaylist', {
              playlistId: list.id,
              songIndexToRemove: '1',
            })
          ),
        );
        await check([a.id]);
        assertEquals(
          await rawSql(s.store).all(
            'SELECT track_id FROM playlist_tracks ORDER BY position',
          ),
          [a.id, 'unknown'].map((track_id) => ({ track_id })),
        );
      },
    );
  } finally {
    await s.close();
  }
});
