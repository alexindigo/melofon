import { assert, assertEquals } from '@std/assert';
import { createLookupRunner } from '../src/lookups/runner.ts';
import { rawSql } from '../src/store/testing.ts';
import { eventually, lookupManifest, lookupPlugin } from './helpers/lookup.ts';
import { tagged } from './helpers/tagged.ts';
import { referenceFixture } from './helpers/reference.ts';

Deno.test('reference fallback: every seed genre, no missing/seed songs, real Worker values win without local top songs', async () => {
  const f = await referenceFixture();
  let runner: Awaited<ReturnType<typeof createLookupRunner>> | undefined;
  try {
    for (
      const [name, genre] of Object.entries({
        seed: 'Rock\0Jazz',
        rock: 'Rock',
        jazz: 'Jazz',
        both: 'Jazz\0Rock',
        other: 'Classical',
        blank: '',
      })
    ) {
      await tagged(`${f.root}/${name}.mp3`, {
        TIT2: name,
        TPE1: 'Artist',
        TALB: 'Album',
        ...(genre ? { TCON: genre } : {}),
      });
    }
    await f.scan.run();
    const songs = await f.store.catalog.listSongs({ offset: 0, size: 100 });
    const song = (title: string) => songs.find((s) => s.title === title)!;
    assertEquals(song('seed').metadata?.genres, ['Rock', 'Jazz']);
    runner = await createLookupRunner({
      store: f.store,
      state: f.state,
      dataDir: `${f.dir}/data`,
      builtin: `${f.dir}/empty`,
    });
    let reference = runner.reference;
    assertEquals(
      new Set(await reference.similarTracks(song('seed').id, 100, 'admin')),
      new Set(['rock', 'jazz', 'both'].map((t) => song(t).id)),
    );
    assertEquals(
      (await reference.similarTracks(song('seed').id, 1, 'admin')).length,
      1,
    );
    assertEquals(
      await reference.similarTracks(song('blank').id, 100, 'admin'),
      [],
    );
    assertEquals(await reference.similarTracks('unknown', 100, 'admin'), []);
    assertEquals(
      await reference.similarTracks(song('seed').id, 0, 'admin'),
      [],
    );
    assertEquals(
      await reference.topTracks(song('seed').artistId!, 100, 'admin'),
      [],
    );
    await rawSql(f.store).run(
      `UPDATE file_identity SET present = false WHERE id = '${
        song('jazz').id
      }'`,
    );
    assertEquals(
      new Set(await reference.similarTracks(song('seed').id, 100, 'admin')),
      new Set(['rock', 'both'].map((t) => song(t).id)),
    );
    await runner.close();
    await lookupPlugin(
      `${f.dir}/data/plugins/lookups`,
      `export default { similar() { return { values: { 'track.similar': [ { title:'seed', artist:'Artist' }, { title:'other', artist:'Artist' }, { title:'other', artist:'Artist' }, { title:'Unavailable', artist:'Nobody' } ] } }; } };`,
      'fixture',
      lookupManifest({
        capabilities: [{
          id: 'similar',
          accepts: 'track',
          provides: ['track.similar'],
          requires: [],
        }],
        network: { hosts: [], ratePerMinute: 600000 },
      }),
    );
    runner = await createLookupRunner({
      store: f.store,
      state: f.state,
      dataDir: `${f.dir}/data`,
      builtin: `${f.dir}/empty`,
    });
    reference = runner.reference;
    const first = await reference.similarTracks(song('seed').id, 100, 'admin');
    assertEquals(first.length, 2);
    assert(
      first.every((id) => ['rock', 'both'].some((t) => song(t).id === id)),
      'first request uses local fallback',
    );
    await eventually(async () =>
      (await f.store.reference.get('track', song('seed').id)).length > 0
    );
    assertEquals(
      await reference.similarTracks(song('seed').id, 100, 'admin'),
      [song('other').id],
      'stored plugin list wins, even outside seed genres; seed and duplicates dropped',
    );
    const http = await f.consumer(reference);
    for (
      const id of await reference.similarTracks(song('seed').id, 100, 'admin')
    ) assertEquals((await http('getSong', { id })).song.title, 'other');
    await f.state.set('lookups.plugin.fixture.enabled', 'false');
    assertEquals(
      new Set(await reference.similarTracks(song('seed').id, 100, 'admin')),
      new Set(['rock', 'both'].map((t) => song(t).id)),
      'disabled provider returns to fallback',
    );
    await f.state.set('lookups.plugin.fixture.enabled', 'true');
    await Deno.remove(`${f.root}/other.mp3`);
    await f.scan.run();
    assertEquals(
      await reference.similarTracks(song('seed').id, 100, 'admin'),
      [],
      'unmatched plugin value is not replaced by local guesses',
    );
  } finally {
    await runner?.close();
    await f.close();
  }
});
