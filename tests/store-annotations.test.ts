import { assert, assertEquals, assertRejects } from '@std/assert';
import { createAnnotationsStore } from '../src/store/annotations.ts';
import { domainFixture } from './helpers/store.ts';

Deno.test('store.annotations.classify looks up artist then album then song and requires a user', async () => {
  const t = await domainFixture(createAnnotationsStore);
  try {
    assertEquals(await t.domain.classify('alice', 'artist'), 'artist');
    assertEquals(await t.domain.classify('alice', 'album'), 'album');
    assertEquals(await t.domain.classify('alice', 'song'), 'song');
    assertEquals(await t.domain.classify('alice', "unknown'"), null);
    await t.run("INSERT INTO artists VALUES ('song', 'Collision')");
    await t.run(
      "INSERT INTO albums (id, name, album_artist_id) VALUES ('song', 'Collision', 'artist')",
    );
    assertEquals(await t.domain.classify('alice', 'song'), 'artist');
    await t.run("DELETE FROM artists WHERE id = 'song'");
    assertEquals(await t.domain.classify('alice', 'song'), 'album');
    await assertRejects(
      () => t.domain.classify('unknown', 'song'),
      Error,
      'unknown user',
    );
  } finally {
    await t.close();
  }
});

Deno.test('store.annotations.latestTargetType uses the latest sequence and isolates users', async () => {
  const t = await domainFixture(createAnnotationsStore);
  try {
    assertEquals(await t.domain.latestTargetType('alice', 'gone'), null);
    await t.domain.appendStarEvent('alice', 'gone', 'album', 'star');
    await t.domain.appendStarEvent('alice', 'gone', 'song', 'unstar');
    await t.domain.appendStarEvent('bob', 'gone', 'artist', 'star');
    assertEquals(await t.domain.latestTargetType('alice', 'gone'), 'song');
    assertEquals(await t.domain.latestTargetType('bob', 'gone'), 'artist');
  } finally {
    await t.close();
  }
});

Deno.test('store.annotations.appendStarEvent appends every action with plain epoch times', async () => {
  const t = await domainFixture(createAnnotationsStore);
  try {
    const before = Date.now();
    for (const action of ['star', 'star', 'unstar'] as const) {
      await t.domain.appendStarEvent('alice', "song'", 'song', action);
    }
    const facts = (await t.domain.facts('alice', ["song'"]))["song'"];
    assertEquals(facts.events.map((e) => e.action), ['star', 'star', 'unstar']);
    assertEquals(facts.starred, false);
    for (const event of facts.events) {
      assert(event.atMs >= before && event.atMs <= Date.now());
    }
    await assertRejects(
      () => t.domain.appendStarEvent('unknown', 'song', 'song', 'star'),
      Error,
      'unknown user',
    );
    assertEquals(await t.domain.likes('song'), { likes: 0, users: 0 });
  } finally {
    await t.close();
  }
});

Deno.test('store.annotations.setRating upserts only the requesting user rating', async () => {
  const t = await domainFixture(createAnnotationsStore);
  try {
    await t.domain.setRating('alice', "song'", 1);
    await t.domain.setRating('bob', "song'", 3);
    await t.domain.setRating('alice', "song'", 5);
    assertEquals(await t.domain.facts('alice', ["song'"]), {
      "song'": { starred: false, events: [], userRating: 5, averageRating: 4 },
    });
    assertEquals(
      (await t.domain.facts('bob', ["song'"]))["song'"].userRating,
      3,
    );
  } finally {
    await t.close();
  }
});

Deno.test('store.annotations.clearRating removes only the requested row and tolerates absence', async () => {
  const t = await domainFixture(createAnnotationsStore);
  try {
    await t.domain.setRating('alice', 'song', 1);
    await t.domain.setRating('bob', 'song', 2);
    await t.domain.clearRating('alice', 'song');
    await t.domain.clearRating('alice', 'song');
    assertEquals((await t.domain.facts('alice', ['song'])).song, {
      starred: false,
      events: [],
      userRating: null,
      averageRating: 2,
    });
  } finally {
    await t.close();
  }
});

Deno.test('store.annotations.starred returns live latest stars with complete history and shared folder scope', async () => {
  const t = await domainFixture(createAnnotationsStore);
  try {
    await t.run("INSERT INTO libraries VALUES ('folder', 'Music', '/music')");
    await t.run("UPDATE files SET library_id = 'folder'");
    for (
      const [id, kind] of [['song', 'song'], ['album', 'album'], [
        'artist',
        'artist',
      ]] as const
    ) {
      await t.domain.appendStarEvent('alice', id, kind, 'star');
      await t.domain.appendStarEvent('alice', id, kind, 'unstar');
      await t.domain.appendStarEvent('alice', id, kind, 'star');
    }
    await t.domain.appendStarEvent('alice', 'orphan', 'song', 'star');
    const items = await t.domain.starred('alice', { folderId: 'folder' });
    assertEquals(items.map((i) => [i.targetId, i.targetType]), [
      ['album', 'album'],
      ['artist', 'artist'],
      ['song', 'song'],
    ]);
    for (const item of items) {
      assertEquals(item.events.map((e) => e.action), [
        'star',
        'unstar',
        'star',
      ]);
    }
    assertEquals(await t.domain.starred('alice'), items);
    assertEquals(await t.domain.starred('bob'), []);
    assertEquals(await t.domain.starred('alice', { folderId: "missing'" }), []);
    await t.domain.appendStarEvent('alice', 'song', 'song', 'unstar');
    await t.run("DELETE FROM albums WHERE id = 'album'");
    assertEquals((await t.domain.starred('alice')).map((i) => i.targetId), [
      'artist',
    ]);
    assertEquals(await t.domain.starred('alice', { folderId: 'folder' }), []);
  } finally {
    await t.close();
  }
});

Deno.test('store.annotations.facts includes defaults and orphans, deduplicates ids and keeps averages unrounded', async () => {
  const t = await domainFixture(createAnnotationsStore);
  try {
    await t.run("INSERT INTO users VALUES ('w', 'carol', 'encrypted', now())");
    await t.domain.setRating('alice', 'orphan', 1);
    await t.domain.setRating('bob', 'orphan', 1);
    await t.domain.setRating('carol', 'orphan', 2);
    await t.domain.appendStarEvent('alice', 'orphan', 'album', 'star');
    const facts = await t.domain.facts('alice', [
      'missing',
      'orphan',
      'orphan',
    ]);
    assertEquals(Object.keys(facts), ['missing', 'orphan']);
    assertEquals(facts.missing, {
      starred: false,
      events: [],
      userRating: null,
      averageRating: null,
    });
    assertEquals(facts.orphan.userRating, 1);
    assertEquals(facts.orphan.averageRating, 4 / 3);
    assertEquals(facts.orphan.starred, true);
    assertEquals(facts.orphan.events.length, 1);
    assertEquals(await t.domain.facts('alice', []), {});
    await assertRejects(
      () => t.domain.facts('unknown', []),
      Error,
      'unknown user',
    );
  } finally {
    await t.close();
  }
});

Deno.test('store.annotations.likes counts every like and distinct users without subtracting unstars', async () => {
  const t = await domainFixture(createAnnotationsStore);
  try {
    assertEquals(await t.domain.likes('song'), { likes: 0, users: 0 });
    await t.domain.appendStarEvent('alice', 'song', 'song', 'star');
    await t.domain.appendStarEvent('alice', 'song', 'song', 'star');
    await t.domain.appendStarEvent('alice', 'song', 'song', 'unstar');
    await t.domain.appendStarEvent('bob', 'song', 'song', 'star');
    assertEquals(await t.domain.likes('song'), { likes: 3, users: 2 });
  } finally {
    await t.close();
  }
});
