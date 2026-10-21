// tests/emptyok.test.ts — M3 empty-ok stubs: features melofon is not
// building (podcasts, chat, shares, album infos) return the
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
import { createState } from '../src/state.ts';
import { facade } from '../src/facade.ts';
import { createReference } from '../src/reference.ts';
import { createRadio } from '../src/radio.ts';
import { createPodcasts } from '../src/podcasts.ts';

const AUTH = 'u=admin&p=test&v=1.16.1&c=melofon-test';

async function setup() {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-empty-' });
  const store = await openStore(dir);
  const db = store;
  const cfg = {
    listen: undefined,
    dataDir: dir,
    user: 'admin',
    password: 'test',
    secret: 's3cret',
    version: '0.0.0-test',
  };
  await seedFirstUser(store, cfg);
  const libraries = createLibraries(store);
  await libraries.add('Music', 'tests/fixtures/library');
  const scan = createScan(store);
  await scan.run();
  const library = createLibrary(store);
  const state = createState(store);
  const podcasts = await createPodcasts({ store, state, dataDir: dir });
  const bag = {
    state,
    podcasts,
    radio: createRadio(store),
    reference: createReference({
      store,
      state,
      providers: () => Promise.resolve([]),
      enqueue: () => Promise.resolve(),
    }),
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
      await podcasts.close();
      await db.close();
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
  ['getTopSongs', { topSongs: { song: [] } }, '<topSongs/>'],
  ['getAlbumInfo', { albumInfo: {} }, '<albumInfo/>'],
  ['getAlbumInfo2', { albumInfo: {} }, '<albumInfo/>'],
];

Deno.test('empty-ok ops return the golden empty payload as JSON and XML', async () => {
  const { app, close } = await setup();
  try {
    for (const [op, jsonPayload, xmlElement] of EMPTY_OK) {
      const args = op === 'getTopSongs' ? '&artist=not-in-library' : '';
      const jsonRes = await app(
        new Request(`http://x/rest/${op}?${AUTH}&f=json${args}`),
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
        new Request(`http://x/rest/${op}?${AUTH}${args}`),
      );
      assertEquals(xmlRes.status, 200, `${op} XML status`);
      assertEquals(
        await xmlRes.text(),
        `${XML_HEAD}${xmlElement}</subsonic-response>`,
        `${op} XML body`,
      );
    }
    // These are implemented endpoints now, with spec-required arguments.
    for (
      const op of [
        'getSimilarSongs',
        'getSimilarSongs2',
        'getTopSongs',
        'getArtistInfo',
        'getArtistInfo2',
      ]
    ) {
      const json = await app(new Request(`http://x/rest/${op}?${AUTH}&f=json`));
      assertEquals((await json.json())['subsonic-response'].error.code, 10);
      const xml = await app(new Request(`http://x/rest/${op}?${AUTH}`));
      assertEquals(
        await xml.text(),
        `${
          XML_HEAD.replace('status="ok"', 'status="failed"')
        }<error code="10" message="Required parameter is missing"/></subsonic-response>`,
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
      new Request(`http://x/rest/getCoverArt?${AUTH}&id=no-such-cover&f=json`),
    );
    // Unknown entity ≠ known entity without art (Navidrome media_retrieval.go:74-76).
    assertEquals((await cover.json())['subsonic-response'].error.code, 70);
  } finally {
    await close();
  }
});
