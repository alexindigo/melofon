import { assertEquals, assertRejects } from '@std/assert';
import { openStore } from '../src/store/index.ts';
import { createSpeakersStore } from '../src/store/speakers.ts';
import { rawSql } from '../src/store/testing.ts';
import { domainFixture } from './helpers/store.ts';

function speaker(id = "speaker'") {
  return {
    id,
    name: "Room's speaker",
    type: 'AirPlay',
    host: 'speaker.home',
    port: 7000,
    selected: true,
    volume: 42,
    model: 'AppleTV3,1',
    connectionStrategy: 'owntone',
  };
}

Deno.test('speaker store adopted save/update/delete is durable and ignores are independent identities', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-speaker-store-' });
  let store = await openStore(dir);
  try {
    assertEquals(await store.speakers.loadAdopted(), []);
    assertEquals(await store.speakers.loadIgnored(), []);
    await store.speakers.saveIgnored("ignored'");
    await store.speakers.saveIgnored("ignored'");
    await store.speakers.saveAdopted(speaker());
    await store.close();
    store = await openStore(dir);
    assertEquals(await store.speakers.loadAdopted(), [speaker()]);
    assertEquals(await store.speakers.loadIgnored(), ["ignored'"]);
    assertEquals(await store.playback.loadOutputs(), [speaker()]);
    const replacement = {
      id: speaker().id,
      name: 'Renamed',
      type: 'Other',
      selected: false,
      volume: 9,
      connectionStrategy: 'melofon',
    };
    await store.speakers.saveAdopted(replacement);
    await store.close();
    store = await openStore(dir);
    assertEquals(await store.speakers.loadAdopted(), [replacement]);
    assertEquals(await store.speakers.deleteAdopted('missing'), false);
    assertEquals(await store.speakers.deleteAdopted(speaker().id), true);
    assertEquals(await store.speakers.deleteAdopted(speaker().id), false);
    await store.close();
    store = await openStore(dir);
    assertEquals(await store.speakers.loadAdopted(), []);
    assertEquals(await store.playback.loadOutputs(), []);
    assertEquals(await store.speakers.loadIgnored(), ["ignored'"]);
    assertEquals(await store.speakers.deleteIgnored("ignored'"), true);
    assertEquals(await store.speakers.deleteIgnored("ignored'"), false);
    await store.close();
    store = await openStore(dir);
    assertEquals(await store.speakers.loadIgnored(), []);
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('speaker migration adopts every legacy row exactly once and new preference saves do not adopt', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-speaker-upgrade-' });
  let store = await openStore(dir);
  try {
    // Recreate the pre-feature schema/ledger through the supported raw seam.
    await store.playback.saveOutput(speaker('selected'));
    await store.playback.saveOutput({
      ...speaker('unselected'),
      selected: false,
    });
    await rawSql(store).run(
      "INSERT INTO output_state (id, selected, volume) VALUES ('no-endpoint', false, 17)",
    );
    const before = await store.playback.loadOutputs();
    await rawSql(store).run('ALTER TABLE output_state DROP COLUMN adopted');
    await rawSql(store).run('DROP TABLE speaker_ignores');
    await rawSql(store).run("DELETE FROM migrations WHERE id = 'speakers-001'");
    await store.close();
    store = await openStore(dir);
    assertEquals(await store.speakers.loadAdopted(), before);
    assertEquals(await store.speakers.loadIgnored(), []);
    assertEquals(
      await rawSql(store).all(
        "SELECT id FROM migrations WHERE id = 'speakers-001'",
      ),
      [{ id: 'speakers-001' }],
    );
    await store.playback.saveOutput(speaker('new-discovery'));
    // Ordinary preference writes preserve existing adoption but cannot grant it.
    await store.playback.saveOutput({ ...speaker('selected'), volume: 61 });
    await store.speakers.deleteAdopted('unselected');
    await store.speakers.saveIgnored('ignored-after-upgrade');
    await store.close();
    store = await openStore(dir);
    assertEquals(
      await store.speakers.loadAdopted(),
      before
        .filter((row) => row.id !== 'unselected')
        .map((row) => row.id === 'selected' ? { ...row, volume: 61 } : row),
    );
    assertEquals(await store.speakers.deleteAdopted('new-discovery'), false);
    assertEquals(await store.speakers.loadIgnored(), ['ignored-after-upgrade']);
    assertEquals(
      (await store.playback.loadOutputs()).some((row) =>
        row.id === 'new-discovery'
      ),
      true,
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('speaker adoption atomically replaces an ignore marker and rejects ignored adoption overlap', async () => {
  const t = await domainFixture(createSpeakersStore);
  try {
    await t.domain.saveIgnored(speaker().id);
    t.failCommit();
    await assertRejects(
      () => t.domain.saveAdopted(speaker()),
      Error,
      'injected commit failure',
    );
    assertEquals(await t.domain.loadAdopted(), []);
    assertEquals(await t.domain.loadIgnored(), [speaker().id]);
    await t.domain.saveAdopted(speaker());
    assertEquals(await t.domain.loadIgnored(), []);
    assertEquals(await t.domain.loadAdopted(), [speaker()]);
    await assertRejects(
      () => t.domain.saveIgnored(speaker().id),
      Error,
      'must be forgotten',
    );
    assertEquals(await t.domain.loadIgnored(), []);
    assertEquals(await t.domain.loadAdopted(), [speaker()]);
  } finally {
    await t.close();
  }
});

Deno.test('speaker adoption rolls back ignore removal on a real database constraint failure', async () => {
  const t = await domainFixture(createSpeakersStore);
  try {
    await t.domain.saveIgnored(speaker().id);
    await assertRejects(
      () =>
        t.domain.saveAdopted({
          ...speaker(),
          selected: null as unknown as boolean,
        }),
      Error,
      'Constraint',
    );
    assertEquals(await t.domain.loadAdopted(), []);
    assertEquals(await t.domain.loadIgnored(), [speaker().id]);
    await t.domain.saveAdopted(speaker());
    assertEquals(await t.domain.loadAdopted(), [speaker()]);
  } finally {
    await t.close();
  }
});

Deno.test('speaker deletion and ignore report commit failures without losing prior state', async () => {
  const t = await domainFixture(createSpeakersStore);
  try {
    await t.domain.saveAdopted(speaker());
    t.failCommit();
    await assertRejects(
      () => t.domain.deleteAdopted(speaker().id),
      Error,
      'injected commit failure',
    );
    assertEquals(await t.domain.loadAdopted(), [speaker()]);
    t.failCommit();
    await assertRejects(
      () => t.domain.saveIgnored('other'),
      Error,
      'injected commit failure',
    );
    assertEquals(await t.domain.loadIgnored(), []);
    await t.domain.deleteAdopted(speaker().id);
    await t.domain.saveIgnored(speaker().id);
    assertEquals(await t.domain.loadAdopted(), []);
    assertEquals(await t.domain.loadIgnored(), [speaker().id]);
  } finally {
    await t.close();
  }
});

Deno.test('speaker store serializes competing ownership writes with one winning lifetime', async () => {
  const t = await domainFixture(createSpeakersStore);
  try {
    await Promise.all([
      t.domain.saveIgnored(speaker().id),
      t.domain.saveAdopted(speaker()),
      t.domain.saveOutput({ ...speaker(), volume: 71 }),
    ]);
    assertEquals(await t.domain.loadAdopted(), [{ ...speaker(), volume: 71 }]);
    assertEquals(await t.domain.loadIgnored(), []);
    const results = await Promise.allSettled([
      t.domain.saveAdopted(speaker()),
      t.domain.saveIgnored(speaker().id),
    ]);
    assertEquals(results.map((result) => result.status), [
      'fulfilled',
      'rejected',
    ]);
    assertEquals(await t.domain.loadAdopted(), [speaker()]);
    assertEquals(await t.domain.loadIgnored(), []);
  } finally {
    await t.close();
  }
});

Deno.test('speaker semantic operations explicitly reject a closed store', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-speaker-closed-' });
  const store = await openStore(dir);
  try {
    await store.close();
    for (
      const operation of [
        () => store.speakers.saveAdopted(speaker()),
        () => store.speakers.deleteAdopted(speaker().id),
        () => store.speakers.loadAdopted(),
        () => store.speakers.saveIgnored('other'),
        () => store.speakers.deleteIgnored('other'),
        () => store.speakers.loadIgnored(),
      ]
    ) {
      await assertRejects(operation, Error, 'Store is closed');
    }
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
