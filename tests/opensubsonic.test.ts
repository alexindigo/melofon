// tests/opensubsonic.test.ts — the opensubsonic hat end to end (in-process):
// auth (password, enc: hex, md5 token, failures), the XML/JSON envelope,
// ping/getLicense, unknown-op and 404 shapes, and facade dispatch into the
// layer. Fixture library + seeded admin/test user per test.
import { assert, assertEquals } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { openDb } from '../src/db.ts';
import { seedFirstUser } from '../src/users.ts';
import { scanLibrary } from '../src/scan.ts';
import { createLibraries } from '../src/libraries.ts';
import { createUserService } from '../src/user.ts';
import { createLibrary } from '../src/library.ts';
import { facade } from '../src/facade.ts';
import { loadLayers } from '../src/layers.ts';

const AUTH = 'u=admin&p=test&v=1.16.1&c=melofon-test';

async function setup() {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-os-' });
  const db = await openDb(dir);
  const cfg = {
    listen: undefined,
    dataDir: dir,
    user: 'admin',
    password: 'test',
    secret: 's3cret',
    version: '0.0.0-test',
  };
  await seedFirstUser(db, cfg);
  const libraries = createLibraries(db);
  await libraries.add('Music', 'tests/fixtures/library');
  await scanLibrary(db);
  const bag = {
    cfg,
    libraries,
    user: createUserService(db, cfg),
    library: createLibrary(db),
  };
  const core = await pathfinder({ roots: ['core/'], app: { db, cfg } });
  const app = facade(core, await loadLayers({ app: bag }));
  return {
    db,
    dir,
    app,
    close: async () => {
      db.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

async function jsonBody(res: Response) {
  const body = await res.json();
  return (body as Record<string, Record<string, unknown>>)[
    'subsonic-response'
  ];
}

Deno.test('ping returns the ok envelope as JSON', async () => {
  const { app, close } = await setup();
  try {
    const res = await app(
      new Request(`http://x/rest/ping?${AUTH}&f=json`),
    );
    assertEquals(res.status, 200);
    const body = await jsonBody(res);
    assertEquals(body.status, 'ok');
    assertEquals(body.version, '1.16.1');
    assertEquals(body.type, 'melofon');
    assertEquals(body.serverVersion, '0.0.0-test');
    assertEquals(body.openSubsonic, true);
  } finally {
    await close();
  }
});

Deno.test('ping defaults to the XML envelope', async () => {
  const { app, close } = await setup();
  try {
    const res = await app(new Request(`http://x/rest/ping?${AUTH}`));
    assertEquals(res.status, 200);
    assert(res.headers.get('content-type')?.startsWith('application/xml'));
    const text = await res.text();
    assert(text.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
    assert(
      text.includes(
        '<subsonic-response xmlns="http://subsonic.org/restapi" status="ok"',
      ),
    );
    assert(text.includes('type="melofon"'));
    assert(text.includes('openSubsonic="true"'));
  } finally {
    await close();
  }
});

Deno.test('wrong password and unknown user share the generic code-40 body', async () => {
  const { app, close } = await setup();
  try {
    const badPass = await app(
      new Request(
        'http://x/rest/ping?u=admin&p=wrong&v=1.16.1&c=t&f=json',
      ),
    );
    assertEquals(badPass.status, 200); // Navidrome: errors ride HTTP 200
    const badPassBody = await jsonBody(badPass);
    assertEquals(badPassBody.status, 'failed');
    assertEquals(
      (badPassBody.error as { code: number; message: string }).code,
      40,
    );
    assertEquals(
      (badPassBody.error as { message: string }).message,
      'Wrong username or password',
    );

    const noUser = await app(
      new Request('http://x/rest/ping?u=ghost&p=test&v=1.16.1&c=t&f=json'),
    );
    assertEquals(await jsonBody(noUser), badPassBody); // no user enumeration
  } finally {
    await close();
  }
});

Deno.test('missing u/v/c is code 10; no credentials at all is code 40', async () => {
  const { app, close } = await setup();
  try {
    const noUser = await app(
      new Request('http://x/rest/ping?v=1.16.1&c=t&f=json'),
    );
    assertEquals(
      ((await jsonBody(noUser)).error as { code: number }).code,
      10,
    );
    const noCreds = await app(
      new Request('http://x/rest/ping?u=admin&v=1.16.1&c=t&f=json'),
    );
    assertEquals(
      ((await jsonBody(noCreds)).error as { code: number }).code,
      40,
    );
  } finally {
    await close();
  }
});

Deno.test('enc: hex password authenticates', async () => {
  const { app, close } = await setup();
  try {
    // hex('test') = 74657374
    const res = await app(
      new Request(
        'http://x/rest/ping?u=admin&p=enc:74657374&v=1.16.1&c=t&f=json',
      ),
    );
    assertEquals((await jsonBody(res)).status, 'ok');
  } finally {
    await close();
  }
});

Deno.test('md5 token+salt authenticates; a bad token fails', async () => {
  const { app, db, close } = await setup();
  try {
    const res = await db.conn.runAndReadAll(
      `SELECT md5('test' || 'c19b2d') AS h`,
    );
    const token = (res.getRowObjects() as { h: string }[])[0].h;
    const ok = await app(
      new Request(
        `http://x/rest/ping?u=admin&t=${token}&s=c19b2d&v=1.16.1&c=t&f=json`,
      ),
    );
    assertEquals((await jsonBody(ok)).status, 'ok');

    const bad = await app(
      new Request(
        'http://x/rest/ping?u=admin&t=00000000000000000000000000000000&s=c19b2d&v=1.16.1&c=t&f=json',
      ),
    );
    assertEquals(
      ((await jsonBody(bad)).error as { code: number }).code,
      40,
    );
  } finally {
    await close();
  }
});

Deno.test('getLicense is valid in both formats', async () => {
  const { app, close } = await setup();
  try {
    const json = await app(
      new Request(`http://x/rest/getLicense?${AUTH}&f=json`),
    );
    assertEquals(
      ((await jsonBody(json)).license as { valid: boolean }).valid,
      true,
    );
    const xml = await app(new Request(`http://x/rest/getLicense?${AUTH}`));
    assert((await xml.text()).includes('<license valid="true"/>'));
  } finally {
    await close();
  }
});

Deno.test('POST form credentials authenticate (formpost model)', async () => {
  const { app, close } = await setup();
  try {
    const res = await app(
      new Request('http://x/rest/ping', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: `${AUTH}&f=json`,
      }),
    );
    assertEquals(res.status, 200);
    assertEquals((await jsonBody(res)).status, 'ok');
  } finally {
    await close();
  }
});

Deno.test('unknown op is a 404 envelope, not code 0', async () => {
  const { app, close } = await setup();
  try {
    const res = await app(
      new Request(`http://x/rest/jukeboxControl?${AUTH}&f=json`),
    );
    assertEquals(res.status, 404);
    const body = await jsonBody(res);
    assertEquals(body.status, 'failed');
    assertEquals(body.type, 'melofon');
  } finally {
    await close();
  }
});

Deno.test('a miss under /rest/ renders the Subsonic envelope, not pathfinder JSON', async () => {
  const { app, close } = await setup();
  try {
    const res = await app(
      new Request(`http://x/rest/deep/path?${AUTH}&f=json`),
    );
    assertEquals(res.status, 404);
    const body = await jsonBody(res);
    assertEquals(body.status, 'failed');
    assertEquals(body.type, 'melofon');
  } finally {
    await close();
  }
});

Deno.test('facade dispatches /rest/ping into the opensubsonic layer', async () => {
  const { app, close } = await setup();
  try {
    const res = await app(
      new Request(`http://x/rest/ping?${AUTH}&f=json`),
    );
    assertEquals(res.status, 200);
    assertEquals((await jsonBody(res)).status, 'ok');
  } finally {
    await close();
  }
});

// .view is paused until pathfinder ships the optional suffix (pathfinder
// TODO.md): one route directory must accept both /rest/ping and
// /rest/ping.view without a greedy capture. Un-ignore when the dependency
// bumps; do not add ping.view/ twin folders.
Deno.test({
  name: 'GET /rest/ping.view dispatches like /rest/ping',
  ignore: true,
  fn: async () => {
    const { app, close } = await setup();
    try {
      const res = await app(
        new Request(`http://x/rest/ping.view?${AUTH}&f=json`),
      );
      assertEquals(res.status, 200);
      assertEquals((await jsonBody(res)).status, 'ok');
    } finally {
      await close();
    }
  },
});

Deno.test('loadLayers mounts rest at /rest: bare /rest/ping answers through the facade', async () => {
  const { app, close } = await setup();
  try {
    const res = await app(new Request(`http://x/rest/ping?${AUTH}&f=json`));
    assertEquals(res.status, 200);
    assertEquals((await jsonBody(res)).status, 'ok');

    // The force prefix composes with the mount: /_opensubsonic/rest/ping.
    const forced = await app(
      new Request(`http://x/_opensubsonic/rest/ping?${AUTH}&f=json`),
    );
    assertEquals(forced.status, 200);
    assertEquals((await jsonBody(forced)).status, 'ok');

    // /restping is not the /rest mount: no per-op route matches the whole
    // segment, so it falls to the layer's 404 envelope.
    const notMount = await app(
      new Request(`http://x/restping?${AUTH}&f=json`),
    );
    assertEquals(notMount.status, 404);
  } finally {
    await close();
  }
});
