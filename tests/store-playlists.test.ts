import { assert, assertEquals, assertRejects } from '@std/assert';
import { createPlaylistsStore } from '../src/store/playlists.ts';
import { domainFixture } from './helpers/store.ts';

async function fixture() {
  const t = await domainFixture(createPlaylistsStore);
  await t.run("UPDATE files SET duration_ms = 1250 WHERE id = 'song'");
  await t.run(
    "INSERT INTO files (id, path, duration_ms) VALUES ('second', '/second', 2750)",
  );
  return t;
}

// Real DuckDB constraint failures, not a mocked connection/commit. The fixture
// alone adds referential integrity to force failures after earlier writes.
async function constrainTracks(t: Awaited<ReturnType<typeof fixture>>) {
  await t.run('DROP TABLE playlist_tracks');
  await t.run(`CREATE TABLE playlist_tracks (
    playlist_id VARCHAR NOT NULL,
    position INTEGER NOT NULL,
    track_id VARCHAR NOT NULL REFERENCES files(id),
    PRIMARY KEY (playlist_id, position)
  )`);
}

Deno.test('store.playlists.list sorts owned playlists and returns numeric aggregates', async () => {
  const t = await fixture();
  try {
    const z = await t.domain.create('alice', 'Z', ['song', 'song', 'missing']);
    const a = await t.domain.create('alice', "A'", []);
    await t.domain.create('bob', 'B', ['second']);
    assertEquals(await t.domain.list('alice'), [
      {
        id: a.id,
        name: "A'",
        comment: null,
        owner: 'alice',
        public: false,
        createdAtMs: a.createdAtMs,
        changedAtMs: a.changedAtMs,
        songCount: 0,
        durationMs: 0,
      },
      {
        id: z.id,
        name: 'Z',
        comment: null,
        owner: 'alice',
        public: false,
        createdAtMs: z.createdAtMs,
        changedAtMs: z.changedAtMs,
        songCount: 2,
        durationMs: 2500,
      },
    ]);
    await assertRejects(() => t.domain.list('unknown'), Error, 'unknown user');
  } finally {
    await t.close();
  }
});

Deno.test('store.playlists.get returns visible order and duplicates, retains orphans and scopes to owner', async () => {
  const t = await fixture();
  try {
    const created = await t.domain.create('alice', 'Mix', [
      'second',
      'song',
      'second',
      "gone'",
    ]);
    assertEquals(await t.domain.get('alice', created.id), created);
    assertEquals(created.trackIds, ['second', 'song', 'second']);
    assertEquals(
      await t.all('SELECT track_id FROM playlist_tracks ORDER BY position'),
      ['second', 'song', 'second', "gone'"].map((track_id) => ({ track_id })),
    );
    assertEquals(created.durationMs, 6750);
    assertEquals(await t.domain.get('bob', created.id), null);
    assertEquals(await t.domain.get('alice', "missing'"), null);
  } finally {
    await t.close();
  }
});

Deno.test('store.playlists.create persists metadata and ordered zero-based positions', async () => {
  const t = await fixture();
  try {
    const before = Date.now();
    const row = await t.domain.create('alice', "Mix'", ['song', 'second']);
    assert(row.id.length > 0);
    assertEquals(row.name, "Mix'");
    assertEquals(row.comment, null);
    assert(row.createdAtMs >= before && row.createdAtMs <= Date.now());
    assertEquals(row.changedAtMs, row.createdAtMs);
    assertEquals(row.songCount, 2);
    assertEquals(row.durationMs, 4000);
    assertEquals(
      await t.all(
        'SELECT position, track_id FROM playlist_tracks ORDER BY position',
      ),
      [
        { position: 0, track_id: 'song' },
        { position: 1, track_id: 'second' },
      ],
    );
    assertEquals(await t.domain.get('alice', row.id), row);
  } finally {
    await t.close();
  }
});

Deno.test('store.playlists.setTracks replaces all positions and guards ownership', async () => {
  const t = await fixture();
  try {
    const row = await t.domain.create('alice', 'Mix', ['song', 'second']);
    assertEquals(await t.domain.setTracks('bob', row.id, []), null);
    assertEquals(await t.domain.setTracks('alice', 'missing', []), null);
    const changed = (await t.domain.setTracks('alice', row.id, [
      'second',
      'second',
      'song',
    ]))!;
    assertEquals(changed.trackIds, ['second', 'second', 'song']);
    assertEquals(changed.durationMs, 6750);
    assertEquals(changed.createdAtMs, row.createdAtMs);
    assert(changed.changedAtMs >= row.changedAtMs);
    assertEquals((await t.domain.setTracks('alice', row.id, []))!.songCount, 0);
  } finally {
    await t.close();
  }
});

Deno.test('store.playlists.update applies metadata, removes original positions and appends without losing order', async () => {
  const t = await fixture();
  try {
    const row = await t.domain.create('alice', 'Mix', [
      'song',
      'second',
      'song',
    ]);
    assertEquals(await t.domain.update('bob', row.id, { name: 'Other' }), null);
    assertEquals(await t.domain.update('alice', 'missing', {}), null);
    const updated = (await t.domain.update('alice', row.id, {
      name: "New'",
      comment: "Comment'",
      removeAtPositions: [0, 0, 2, 999, -1],
      addTrackIds: ['song'],
    }))!;
    assertEquals(updated.name, "New'");
    assertEquals(updated.comment, "Comment'");
    assertEquals(updated.trackIds, ['second', 'song']);
    assertEquals(updated.durationMs, 4000);
    assertEquals(
      (await t.domain.update('alice', row.id, { comment: '' }))!.comment,
      '',
    );
    assertEquals((await t.domain.update('alice', row.id, {}))!.trackIds, [
      'second',
      'song',
    ]);
  } finally {
    await t.close();
  }
});

Deno.test('store.playlists.delete removes metadata and tracks only for the owner', async () => {
  const t = await fixture();
  try {
    const row = await t.domain.create('alice', 'Mix', ['song', 'second']);
    assertEquals(await t.domain.delete('bob', row.id), false);
    assertEquals(await t.domain.delete('alice', 'missing'), false);
    assertEquals(await t.domain.delete('alice', row.id), true);
    assertEquals(await t.domain.get('alice', row.id), null);
    assertEquals(await t.all('SELECT * FROM playlist_tracks'), []);
    assertEquals(await t.domain.delete('alice', row.id), false);
  } finally {
    await t.close();
  }
});

Deno.test('store.playlists.create rolls back metadata and earlier tracks on a real constraint failure', async () => {
  const t = await fixture();
  try {
    await constrainTracks(t);
    await assertRejects(
      () => t.domain.create('alice', 'Lost', ['song', 'missing']),
      Error,
      'Constraint',
    );
    assertEquals(await t.domain.list('alice'), []);
    assertEquals(await t.all('SELECT * FROM playlist_tracks'), []);
    assertEquals(
      (await t.domain.create('alice', 'Next', ['second'])).trackIds,
      ['second'],
    );
  } finally {
    await t.close();
  }
});

Deno.test('store.playlists.setTracks restores deleted tracks and timestamps on a real constraint failure', async () => {
  const t = await fixture();
  try {
    await constrainTracks(t);
    const row = await t.domain.create('alice', 'Keep', ['song', 'second']);
    await assertRejects(
      () => t.domain.setTracks('alice', row.id, ['second', 'missing']),
      Error,
      'Constraint',
    );
    assertEquals(await t.domain.get('alice', row.id), row);
    assertEquals(
      (await t.domain.setTracks('alice', row.id, ['second']))!.trackIds,
      ['second'],
    );
  } finally {
    await t.close();
  }
});

Deno.test('store.playlists.update restores metadata, tracks and timestamps on a real constraint failure', async () => {
  const t = await fixture();
  try {
    await constrainTracks(t);
    const row = await t.domain.create('alice', 'Keep', ['song', 'second']);
    await assertRejects(
      () =>
        t.domain.update('alice', row.id, {
          name: 'Lost',
          comment: 'Lost',
          removeAtPositions: [0],
          addTrackIds: ['missing'],
        }),
      Error,
      'Constraint',
    );
    assertEquals(await t.domain.get('alice', row.id), row);
    assertEquals(
      (await t.domain.update('alice', row.id, { name: 'Next' }))!.name,
      'Next',
    );
  } finally {
    await t.close();
  }
});

Deno.test('store.playlists.delete restores earlier track deletion when a real dependent row blocks metadata deletion', async () => {
  const t = await fixture();
  try {
    const row = await t.domain.create('alice', 'Keep', ['song', 'second']);
    await t.run(
      'CREATE TABLE playlist_reference (playlist_id VARCHAR REFERENCES playlists(id))',
    );
    await t.run(`INSERT INTO playlist_reference VALUES ('${row.id}')`);
    await assertRejects(
      () => t.domain.delete('alice', row.id),
      Error,
      'Constraint',
    );
    assertEquals(await t.domain.get('alice', row.id), row);
    await t.run('DELETE FROM playlist_reference');
    assertEquals(await t.domain.delete('alice', row.id), true);
  } finally {
    await t.close();
  }
});
