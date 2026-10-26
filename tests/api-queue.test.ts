import { assert, assertEquals } from '@std/assert';
import { apiFixture, error, iso } from './helpers/api.ts';
import { createClientQueue } from '../src/clientqueue.ts';
import { createLibraries } from '../src/libraries.ts';
import { createLibrary } from '../src/library.ts';
import { createAnnotation } from '../src/annotation.ts';
import { createListens } from '../src/listens.ts';
import { scanLibrary } from '../src/scan.ts';

const path = '/api/v1/me/queue';
interface Queue {
  songIds: string[];
  currentIndex: number;
  positionMs: number;
  changedAt: string;
  changedBy: string | null;
}

async function fixture() {
  let songIds: string[] = [];
  const f = await apiFixture({
    allLayers: true,
    services: async (f) => {
      const libraries = createLibraries(f.store);
      await libraries.add(
        'Music',
        await Deno.realPath('tests/fixtures/library'),
      );
      await scanLibrary(f.store);
      const library = createLibrary(f.store);
      songIds = (await library.listSongs({ offset: 0, size: 100 }))
        .filter((song) => song.title !== null).map((song) => song.id);
      assert(songIds.length >= 3);
      return {
        clientQueue: createClientQueue(f.store),
        libraries,
        library,
        annotation: createAnnotation(f.store),
        listens: createListens(f.store),
      };
    },
  });
  async function read(credential: string): Promise<{ queue: Queue | null }> {
    const r = await f.get(path, credential);
    assertEquals(r.status, 200, await r.clone().text());
    return r.json();
  }
  async function save(credential: string, body: unknown) {
    const r = await f.json(path, 'PUT', body, credential);
    assertEquals(r.status, 200, await r.clone().text());
    return await r.json() as { queue: Queue | null };
  }
  async function rest(op: string, params: [string, string][] = []) {
    const query = new URLSearchParams([
      ['u', 'admin'],
      ['p', 'password-admin'],
      ['v', '1.16.1'],
      ['c', 'OpenSubsonic device'],
      ['f', 'json'],
      ...params,
    ]);
    const r = await f.get(`/rest/${op}?${query}`);
    assertEquals(r.status, 200);
    const body = (await r.json())['subsonic-response'];
    assertEquals(body.status, 'ok', JSON.stringify(body));
    return body;
  }
  return { ...f, songIds, read, save, rest };
}

Deno.test('API saved queue: cookie and Bearer devices round-trip core values and clear without events', async () => {
  const f = await fixture();
  try {
    const cookie = await f.login(
      'cookie',
      'admin',
      'password-admin',
      'Browser',
    );
    const bearer = await f.login('bearer', 'admin', 'password-admin', 'Phone');
    const beforeEvents = [...f.notifications];
    assertEquals(await f.read(cookie.credential), { queue: null });
    const [a, b] = f.songIds;
    for (
      const [login, device] of [[cookie, 'Browser'], [bearer, 'Phone']] as const
    ) {
      const input = { songIds: [a, b, a], currentIndex: 2, positionMs: 42000 };
      const before = Date.now();
      const result = await f.save(login.credential, input);
      assert(result.queue);
      assertEquals(Object.keys(result), ['queue']);
      assertEquals(Object.keys(result.queue).sort(), [
        'changedAt',
        'changedBy',
        'currentIndex',
        'positionMs',
        'songIds',
      ]);
      assertEquals(result.queue.songIds, input.songIds);
      assertEquals(result.queue.currentIndex, 2);
      assertEquals(result.queue.positionMs, 42000);
      assertEquals(result.queue.changedBy, device);
      iso(result.queue.changedAt);
      assert(Date.parse(result.queue.changedAt) >= before);
      assert(Date.parse(result.queue.changedAt) <= Date.now());
      assertEquals(await f.read(cookie.credential), result);
      assertEquals(await f.read(bearer.credential), result);
    }
    const defaults = await f.save(cookie.credential, { songIds: [b] });
    assertEquals(defaults.queue?.currentIndex, 0);
    assertEquals(defaults.queue?.positionMs, 0);
    assertEquals(await f.save(bearer.credential, { songIds: [] }), {
      queue: null,
    });
    assertEquals(await f.read(cookie.credential), { queue: null });
    assertEquals(f.notifications, beforeEvents);
  } finally {
    await f.close();
  }
});

Deno.test('API saved queue: authentication, Origin and method guards apply through the facade', async () => {
  const f = await fixture();
  try {
    await error(await f.get(path), 401, 'unauthenticated');
    await error(
      await f.json(path, 'PUT', { songIds: [] }),
      401,
      'unauthenticated',
    );
    const cookie = await f.login();
    const bearer = await f.login('bearer');
    for (const login of [cookie, bearer]) {
      for (const origin of ['http://foreign.home', 'null']) {
        await error(
          await f.json(path, 'PUT', { songIds: [] }, login.credential, origin),
          403,
          'origin',
        );
      }
      // Reads are side-effect free, so a foreign Origin is allowed.
      const read = await f.get(path, login.credential, {
        Origin: 'http://foreign.home',
      });
      assertEquals(read.status, 200);
      await read.json();
      for (const method of ['POST', 'PATCH', 'DELETE']) {
        const r = await f.json(path, method, {}, login.credential);
        assertEquals(r.headers.get('allow')?.split(', ').sort(), [
          'GET',
          'PUT',
        ]);
        await error(r, 405, 'method_not_allowed');
      }
    }
    await error(
      await f.json(path, 'PUT', { songIds: [] }, cookie.credential, null),
      403,
      'origin',
    );
    const r = await f.json(
      path,
      'PUT',
      { songIds: [] },
      bearer.credential,
      null,
    );
    assertEquals(r.status, 200);
    assertEquals(await r.json(), { queue: null });
    assert(f.peers.every((peer) => peer !== '127.0.0.1' && peer !== '::1'));
  } finally {
    await f.close();
  }
});

Deno.test('API saved queue: invalid fields reject atomically and JSON errors retain stage-1 shapes', async () => {
  const f = await fixture();
  try {
    const { credential } = await f.login();
    const songIds = f.songIds.slice(0, 2);
    const before = await f.save(credential, {
      songIds,
      currentIndex: 1,
      positionMs: 900,
    });
    for (
      const body of [
        {},
        { songIds: null },
        { songIds: 'id' },
        { songIds: {} },
        { songIds: [1] },
        { songIds: [null] },
        { songIds: [true] },
        ...['currentIndex', 'positionMs'].flatMap((key) =>
          [-1, 0.5, '0', null, true, 9007199254740992].map((value) => ({
            songIds,
            [key]: value,
          }))
        ),
        { songIds, currentIndex: 2 },
      ]
    ) {
      await error(
        await f.json(path, 'PUT', body, credential),
        400,
        'invalid_field',
      );
      assertEquals(await f.read(credential), before);
    }
    await error(
      await f.json(path, 'PUT', { songIds, changedBy: 'forged' }, credential),
      400,
      'unknown_field',
    );
    for (const body of ['{bad', 'null', '[]']) {
      await error(
        await f.request(path, {
          method: 'PUT',
          headers: {
            Cookie: credential,
            Origin: f.origin,
            'Content-Type': 'application/json',
          },
          body,
        }),
        400,
        'not_json',
      );
    }
    await error(
      await f.request(path, {
        method: 'PUT',
        headers: {
          Cookie: credential,
          Origin: f.origin,
          'Content-Type': 'text/plain',
        },
        body: '{}',
      }),
      415,
      'unsupported_media_type',
    );
    assertEquals(await f.read(credential), before);
  } finally {
    await f.close();
  }
});

Deno.test('API saved queue: per-user isolation and bidirectional OpenSubsonic sharing', async () => {
  const f = await fixture();
  try {
    const a = await f.login();
    await f.auth.users.create(f.admin.id, {
      username: 'bob',
      password: 'password-bob',
      role: 'user',
    });
    const b = await f.login('bearer', 'bob', 'password-bob', 'Bob phone');
    const [one, two, three] = f.songIds;
    const saved = await f.save(a.credential, {
      songIds: [one, two, one],
      currentIndex: 2,
      positionMs: 1234,
    });
    assertEquals(await f.read(b.credential), { queue: null });
    const pq = (await f.rest('getPlayQueue')).playQueue;
    assertEquals(pq.entry.map((e: { id: string }) => e.id), [one, two, one]);
    assertEquals(pq.current, one);
    assertEquals(pq.position, 1234);
    assertEquals(pq.changed, saved.queue!.changedAt);
    assertEquals(pq.changedBy, 'Device');
    const indexed = (await f.rest('getPlayQueueByIndex')).playQueueByIndex;
    assertEquals(indexed.currentIndex, 2);
    await f.save(b.credential, { songIds: [three], positionMs: 77 });
    await f.rest('savePlayQueue', [
      ['id', three],
      ['id', two],
      ['current', two],
      ['position', '2500'],
    ]);
    const fromRest = (await f.read(a.credential)).queue!;
    assertEquals(fromRest.songIds, [three, two]);
    assertEquals(fromRest.currentIndex, 1);
    assertEquals(fromRest.positionMs, 2500);
    assertEquals(fromRest.changedBy, 'OpenSubsonic device');
    await f.rest('savePlayQueueByIndex', [
      ['id', one],
      ['id', two],
      ['id', one],
      ['currentIndex', '2'],
      ['position', '3500'],
    ]);
    assertEquals((await f.read(a.credential)).queue!.currentIndex, 2);
    assertEquals((await f.read(b.credential)).queue!.songIds, [three]);
    assertEquals((await f.read(b.credential)).queue!.positionMs, 77);
    await f.rest('savePlayQueue');
    assertEquals(await f.read(a.credential), { queue: null });
  } finally {
    await f.close();
  }
});

Deno.test('API saved queue: core removes unknown ids without pointer drift and preserves null changedBy', async () => {
  const f = await fixture();
  try {
    const { credential } = await f.login();
    const [a, b] = f.songIds;
    const filtered = await f.save(credential, {
      songIds: ['gone', a, b, a],
      currentIndex: 3,
      positionMs: 111,
    });
    assertEquals(filtered.queue?.songIds, [a, b, a]);
    assertEquals(filtered.queue?.currentIndex, 2);
    assertEquals(filtered.queue?.positionMs, 111);
    const missingCurrent = await f.save(credential, {
      songIds: [a, 'gone', b],
      currentIndex: 1,
      positionMs: 111,
    });
    assertEquals(missingCurrent.queue?.songIds, [a, b]);
    assertEquals(missingCurrent.queue?.currentIndex, 1);
    assertEquals(missingCurrent.queue?.positionMs, 0);
    assertEquals(await f.save(credential, { songIds: ['gone'] }), {
      queue: null,
    });
    await createClientQueue(f.store).save('admin', { trackIds: [a] });
    assertEquals((await f.read(credential)).queue?.changedBy, null);
  } finally {
    await f.close();
  }
});

Deno.test('API saved queue: 20,000 entries round-trip with an independently configurable streaming body cap', async () => {
  const f = await fixture();
  try {
    const { credential } = await f.login('bearer');
    const songIds = Array.from(
      { length: 20000 },
      (_, i) => f.songIds[i % f.songIds.length],
    );
    const input = { songIds, currentIndex: 19999, positionMs: 4567 };
    const encoded = JSON.stringify(input);
    assert(new TextEncoder().encode(encoded).length > 65536);
    const result = await f.save(credential, input);
    assertEquals(result.queue?.songIds, songIds);
    assertEquals(result.queue?.currentIndex, 19999);
    assertEquals(result.queue?.positionMs, 4567);
    assertEquals(await f.read(credential), result);
    // Larger permission is local to PUT queue; other routes retain their cap.
    await error(
      await f.json('/api/v1/me/preferences', 'PATCH', {
        preferences: { 'ui.large': encoded },
      }, credential),
      413,
      'too_large',
    );
    await f.state.set('melofon.queueJsonMaxBytes', '128');
    await error(await f.json(path, 'PUT', input, credential), 413, 'too_large');
    // No Content-Length: verify byte counting before buffering as well.
    await error(
      await f.request(path, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${credential}`,
          Origin: f.origin,
          'Content-Type': 'application/json',
        },
        body: new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(encoded));
            c.close();
          },
        }),
      }),
      413,
      'too_large',
    );
    assertEquals(await f.read(credential), result);
    assertEquals(await f.save(credential, { songIds: [] }), { queue: null });
  } finally {
    await f.close();
  }
});
