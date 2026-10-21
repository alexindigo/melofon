import { assertEquals, assertMatch, assertThrows } from '@std/assert';
import { discoverLookups, parseManifest } from '../src/lookups/manifest.ts';
import { lookupManifest, lookupPlugin } from './helpers/lookup.ts';

Deno.test('reference capabilities use typed vocabulary without candidates or photos', () => {
  const artist = {
    id: 'artist',
    accepts: 'artist',
    provides: [
      'artist.biography',
      'artist.url',
      'artist.id.mbid',
      'artist.similar',
      'artist.topTracks',
    ],
    requires: ['artist.id.mbid'],
  };
  const track = {
    id: 'track',
    accepts: 'track',
    provides: ['track.similar'],
    requires: ['track.id.isrc'],
  };
  const capabilities = [artist, track];
  assertEquals(
    parseManifest(lookupManifest({ capabilities }), 'fixture').capabilities,
    capabilities,
  );
  for (
    const capability of [
      { ...artist, provides: ['artist.biography', 'album.image.front'] },
      { ...artist, provides: ['artist.biography', 'artist.image.primary'] },
      { ...artist, provides: ['artist.unknown'] },
      { ...artist, provides: ['track.similar'] },
      { ...track, provides: ['artist.similar'] },
      { ...artist, provides: [] },
      { ...artist, provides: ['artist.url', 'artist.url'] },
    ]
  ) {
    assertThrows(() =>
      parseManifest(lookupManifest({ capabilities: [capability] }), 'fixture')
    );
  }
});

Deno.test('lookup manifest contract, identity, capabilities and settings are strict', () => {
  const manifest = parseManifest(lookupManifest(), 'fixture');
  assertEquals([
    manifest.id,
    manifest.entry,
    manifest.settings.behavior.default,
  ], ['fixture', 'index.ts', 'found']);
  for (
    const overrides of [
      { contract: 2 },
      { id: 'other' },
      { unknown: true },
      { capabilities: [] },
      { entry: '../outside.ts' },
      { entry: '/index.ts' },
      {
        capabilities: [{
          id: 'x',
          accepts: 'track',
          provides: ['album.image.front'],
        }],
      },
      {
        capabilities: [{
          id: 'x',
          accepts: 'album',
          provides: ['album.image.back'],
        }],
      },
      {
        capabilities: [{
          id: 'x',
          accepts: 'album',
          provides: ['album.image.front'],
          requires: ['unknown.field'],
        }],
      },
      { network: { hosts: ['https://bad.test'], ratePerMinute: 1 } },
      { network: { hosts: [], ratePerMinute: 0 } },
      {
        settings: {
          type: 'object',
          properties: { foo: { type: 'integer', default: 'bad' } },
        },
      },
      {
        settings: {
          type: 'object',
          properties: { foo: { type: 'string', unknown: true } },
        },
      },
    ]
  ) assertThrows(() => parseManifest(lookupManifest(overrides), 'fixture'));
});
Deno.test('lookup manifests parse declared requires vocabulary and reject nested unknown keys', () => {
  const capability = {
    id: 'cover',
    accepts: 'album',
    provides: ['album.image.front'],
    requires: [
      'album.id.mbid',
      'album.id.itunes',
      'track.id.mbid',
      'album.name',
      'file.track',
    ],
  };
  assertEquals(
    parseManifest(lookupManifest({ capabilities: [capability] }), 'fixture')
      .capabilities[0].requires,
    capability.requires,
  );
  assertThrows(() =>
    parseManifest(
      lookupManifest({ capabilities: [{ ...capability, extra: 1 }] }),
      'fixture',
    )
  );
  assertThrows(() =>
    parseManifest(
      lookupManifest({ capabilities: [capability, capability] }),
      'fixture',
    )
  );
  assertThrows(() =>
    parseManifest(
      lookupManifest({ network: { hosts: [], ratePerMinute: 1, extra: 1 } }),
      'fixture',
    )
  );
});
Deno.test('operator lookups override builtins; a broken copy is failed without fallback', async () => {
  const dir = await Deno.makeTempDir();
  try {
    await lookupPlugin(`${dir}/builtin`);
    const override = await lookupPlugin(
      `${dir}/data/plugins/lookups`,
      undefined,
      'fixture',
      lookupManifest({ name: 'Override' }),
    );
    assertEquals(
      (await discoverLookups(`${dir}/builtin`, `${dir}/data`))[0].manifest
        ?.name,
      'Override',
    );
    await Deno.writeTextFile(`${override}/manifest.json`, '{}');
    const failed = (await discoverLookups(`${dir}/builtin`, `${dir}/data`))[0];
    assertEquals(failed.manifest, undefined);
    assertEquals(failed.dir, override);
    assertMatch(failed.error!, /Unsupported lookup contract/);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
Deno.test('lookup entry symlinks cannot escape their plugin folder', async () => {
  const dir = await Deno.makeTempDir();
  try {
    const plugin = await lookupPlugin(`${dir}/lookups`);
    await Deno.writeTextFile(`${dir}/outside.ts`, 'export default {};');
    await Deno.remove(`${plugin}/index.ts`);
    await Deno.symlink(`${dir}/outside.ts`, `${plugin}/index.ts`);
    assertMatch(
      (await discoverLookups(`${dir}/lookups`, `${dir}/data`))[0].error!,
      /escapes/,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
