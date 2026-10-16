// tests/emptyok.test.ts — M3 empty-ok stubs: features melofon is not
// building (podcasts, chat, shares, radio, similar/top, infos) return the
// correct empty payload, golden-tested in BOTH JSON and XML — never the
// dispatch fallback's "Not implemented" envelope, never an uncaught 500.
// getAvatar serves the same placeholder tile as a missing cover.
import { assertEquals } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { openStore } from '../src/store/index.ts';
import { seedFirstUser } from '../src/users.ts';
import { createScan } from '../src/scan.ts';
import { createLibraries } from '../src/libraries.ts';
import { createUserService } from '../src/user.ts';
import { createLibrary } from '../src/library.ts';
import { createArtwork } from '../src/artwork.ts';
import { loadLayers } from '../src/layers.ts';
import { facade } from '../src/facade.ts';

const AUTH = 'u=admin&p=test&v=1.16.1&c=melofon-test';

async function setup() {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-empty-' });
  const store = await openStore(dir);
  const db = store.legacy;
  const cfg = {
    listen: undefined,
    dataDir: dir,
    user: 'admin',
    password: 'test',
    secret: 's3cret',
    version: '0.0.0-test',
  };
  await seedFirstUser(store, cfg);
  const libraries = createLibraries(db);
  await libraries.add('Music', 'tests/fixtures/library');
  const scan = createScan(db);
  await scan.run();
  const library = createLibrary(db);
  const bag = {
    cfg,
    libraries,
    scan,
    user: createUserService(store, cfg),
    library,
    artwork: createArtwork(library),
  };
  const core = await pathfinder({ roots: ['core/'], app: { store, cfg } });
  const app = facade(core, await loadLayers({ app: bag }));
  return {
    db,
    app,
    close: async () => {
      db.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<subsonic-response xmlns="http://subsonic.org/restapi" status="ok" ' +
  'version="1.16.1" type="melofon" ' +
  'serverVersion="0.0.0-test" openSubsonic="true">';

// op → [JSON payload, XML element]
const EMPTY_OK: [string, Record<string, unknown>, string][] = [
  ['getPodcasts', { podcasts: { channel: [] } }, '<podcasts/>'],
  [
    'getNewestPodcasts',
    { newestPodcasts: { episode: [] } },
    '<newestPodcasts/>',
  ],
  ['getChatMessages', { chatMessages: { chatMessage: [] } }, '<chatMessages/>'],
  ['getShares', { shares: { share: [] } }, '<shares/>'],
  [
    'getInternetRadioStations',
    { internetRadioStations: { internetRadioStation: [] } },
    '<internetRadioStations/>',
  ],
  ['getSimilarSongs', { similarSongs: { song: [] } }, '<similarSongs/>'],
  ['getSimilarSongs2', { similarSongs2: { song: [] } }, '<similarSongs2/>'],
  ['getTopSongs', { topSongs: { song: [] } }, '<topSongs/>'],
  ['getArtistInfo', { artistInfo: {} }, '<artistInfo/>'],
  ['getArtistInfo2', { artistInfo2: {} }, '<artistInfo2/>'],
  ['getAlbumInfo', { albumInfo: {} }, '<albumInfo/>'],
  ['getAlbumInfo2', { albumInfo2: {} }, '<albumInfo2/>'],
];

Deno.test('empty-ok ops return the golden empty payload as JSON and XML', async () => {
  const { app, close } = await setup();
  try {
    for (const [op, jsonPayload, xmlElement] of EMPTY_OK) {
      const jsonRes = await app(
        new Request(`http://x/rest/${op}?${AUTH}&f=json`),
      );
      assertEquals(jsonRes.status, 200, `${op} JSON status`);
      const json = await jsonRes.json();
      assertEquals(
        json,
        {
          'subsonic-response': {
            status: 'ok',
            version: '1.16.1',
            type: 'melofon',
            serverVersion: '0.0.0-test',
            openSubsonic: true,
            ...jsonPayload,
          },
        },
        `${op} JSON body`,
      );

      const xmlRes = await app(
        new Request(`http://x/rest/${op}?${AUTH}`),
      );
      assertEquals(xmlRes.status, 200, `${op} XML status`);
      assertEquals(
        await xmlRes.text(),
        `${XML_HEAD}${xmlElement}</subsonic-response>`,
        `${op} XML body`,
      );
    }
  } finally {
    await close();
  }
});

Deno.test('getAvatar serves the cover placeholder tile', async () => {
  const { app, close } = await setup();
  try {
    const avatar = await app(
      new Request(`http://x/rest/getAvatar?${AUTH}&username=admin`),
    );
    assertEquals(avatar.status, 200);
    assertEquals(avatar.headers.get('content-type'), 'image/png');
    const avatarBytes = new Uint8Array(await avatar.arrayBuffer());
    // PNG magic.
    assertEquals([...avatarBytes.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]);

    const cover = await app(
      new Request(`http://x/rest/getCoverArt?${AUTH}&id=no-such-cover`),
    );
    assertEquals(
      avatarBytes,
      new Uint8Array(await cover.arrayBuffer()),
      'avatar and missing cover are the same tile',
    );
  } finally {
    await close();
  }
});
