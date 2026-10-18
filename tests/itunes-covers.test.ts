import { assert, assertEquals, assertRejects } from '@std/assert';
import plugin from '../lookups/itunes-covers/index.ts';
import { parseManifest } from '../src/lookups/manifest.ts';
import { createLookupNetwork } from '../src/lookups/net.ts';

const lookup = plugin['album-cover'];
type Context = Parameters<typeof lookup>[1];
const album = (
  name: string | null = 'Abbey Road',
  albumArtist: string | null = 'The Beatles',
) => ({ id: 'album-1', name, albumArtist });
const fixture = async (name: string) =>
  JSON.parse(await Deno.readTextFile(`tests/fixtures/itunes/${name}.json`));

async function withResponse(
  response: Response,
  fn: (ctx: Context, hits: URL[]) => Promise<void>,
) {
  const hits: URL[] = [];
  const server = Deno.serve(
    { hostname: '127.0.0.1', port: 0, onListen() {} },
    (request) => {
      hits.push(new URL(request.url));
      return response;
    },
  );
  const controller = new AbortController();
  const network = createLookupNetwork({
    fixtures: { 'itunes.apple.com': `http://127.0.0.1:${server.addr.port}` },
  });
  try {
    await fn({
      fetch(input, init) {
        assertEquals(new URL(input).origin, 'https://itunes.apple.com');
        return network.fetch(
          {
            plugin: 'itunes-covers',
            hosts: ['itunes.apple.com'],
            ratePerMinute: 20,
            signal: controller.signal,
          },
          String(input),
          init,
          { timeoutMs: 5000, maxBytes: 1024 * 1024 },
        );
      },
      settings: { countries: ['us', 'ru'] },
      signal: controller.signal,
    }, hits);
  } finally {
    controller.abort();
    await server.shutdown();
  }
}

Deno.test('iTunes manifest declares one album capability, requested hosts, rate and country defaults', async () => {
  const manifest = parseManifest(
    JSON.parse(await Deno.readTextFile('lookups/itunes-covers/manifest.json')),
    'itunes-covers',
  );
  assertEquals(manifest.capabilities, [{
    id: 'album-cover',
    accepts: 'album',
    provides: ['album.image.front'],
    requires: [],
  }]);
  assertEquals(manifest.network.hosts, ['itunes.apple.com', '*.mzstatic.com']);
  assertEquals(manifest.network.ratePerMinute, 20);
  assertEquals(manifest.settings.countries.default, ['us', 'ru']);
});

Deno.test('iTunes exact match returns strong, 1200 artwork and complete evidence; query is album plus artist', async () => {
  await withResponse(
    Response.json(await fixture('exact')),
    async (ctx, hits) => {
      const result = await lookup(album(), ctx);
      assert('candidates' in result);
      assertEquals(result.candidates, [{
        target: { type: 'album', id: 'album-1' },
        confidence: 'strong',
        values: {
          'album.image.front': {
            url:
              'https://is1-ssl.mzstatic.com/image/thumb/Music/abbey-road.jpg/1200x1200bb.jpg',
          },
        },
        evidence: {
          collectionId: 1441164426,
          collectionName: 'Abbey Road',
          artistName: 'The Beatles',
          country: 'us',
          albumSimilarity: 1,
          artistSimilarity: 1,
          editionNotesIgnored: false,
        },
      }]);
      assertEquals(hits.length, 1);
      assertEquals(hits[0].pathname, '/search');
      assertEquals(Object.fromEntries(hits[0].searchParams), {
        entity: 'album',
        limit: '8',
        term: 'Abbey Road The Beatles',
        country: 'us',
      });
    },
  );
});

Deno.test('iTunes close match is medium and stores actual similarity scores', async () => {
  await withResponse(Response.json(await fixture('close')), async (ctx) => {
    const result = await lookup(album(), ctx);
    assert('candidates' in result);
    assertEquals(result.candidates.length, 1);
    assertEquals(result.candidates[0].confidence, 'medium');
    assertEquals(result.candidates[0].evidence.albumSimilarity, 1 - 1 / 11);
    // Leading articles are kept: "the beatles" vs "the beatle".
    assertEquals(result.candidates[0].evidence.artistSimilarity, 1 - 1 / 11);
  });
});

for (const name of ['unrelated', 'empty']) {
  Deno.test(`iTunes ${name} response yields no candidates`, async () => {
    await withResponse(Response.json(await fixture(name)), async (ctx) => {
      assertEquals(await lookup(album(), ctx), { candidates: [] });
    });
  });
}

Deno.test('iTunes normalizes accents, punctuation, case and spaces', async () => {
  const data = await fixture('exact');
  data.results[0].collectionName = '  ÁBBEY--ROAD!! ';
  data.results[0].artistName = 'THE  BÉATLES';
  await withResponse(Response.json(data), async (ctx) => {
    const result = await lookup(album(), ctx);
    assert('candidates' in result);
    assertEquals(result.candidates[0].confidence, 'strong');
  });
});

// Matching keeps leading articles (user decision 2026-10-18): a different
// article is a different title, never a strong match.
for (
  const [ours, theirs, ourArtist, theirArtist, confidence] of [
    [
      'A Night at the Opera',
      'The Night at the Opera',
      'Queen',
      'Queen',
      'medium',
    ],
    [
      'A Night at the Opera',
      'The Night at the Opera',
      'Queen',
      'DJ Someone',
      null,
    ],
    // 'the beatles' vs 'beatles': 1 - 4/11 < .75, so a missing article is no match.
    ['Abbey Road', 'Abbey Road', 'The Beatles', 'Beatles', null],
  ] as const
) {
  Deno.test(`iTunes keeps leading articles: ${ours}/${ourArtist} vs ${theirs}/${theirArtist}: ${confidence ?? 'dropped'}`, async () => {
    const data = await fixture('exact');
    data.results[0].collectionName = theirs;
    data.results[0].artistName = theirArtist;
    await withResponse(Response.json(data), async (ctx) => {
      const result = await lookup(album(ours, ourArtist), ctx);
      assert('candidates' in result);
      assertEquals(
        result.candidates.map((c) => c.confidence),
        confidence ? [confidence] : [],
      );
    });
  });
}

// Edition notes (user decision 2026-10-18): equal only once bracketed edition
// notes are removed is medium, never strong; other brackets are the name.
for (
  const [ours, theirs, confidence, ignored] of [
    ['Abbey Road', 'Abbey Road (Remastered)', 'medium', true],
    ['Abbey Road', 'Abbey Road (Remastered 2009)', 'medium', true],
    [
      'Abbey Road',
      'Abbey Road (Super Deluxe Edition) [2019 Remix & Remaster]',
      'medium',
      true,
    ],
    ['Abbey Road', 'Abbey Road (50th Anniversary Edition)', 'medium', true],
    ['Abbey Road (Remastered)', 'Abbey Road', 'medium', true],
    ['Abbey Road (Remastered)', 'Abbey Road (Remastered)', 'strong', false],
    ['Live Killers', 'Live Killers (Live)', null, false],
    ['Abbey Road', 'Abbey Road (Vol. 2)', null, false],
  ] as const
) {
  Deno.test(`iTunes edition notes: ${ours} vs ${theirs}: ${confidence ?? 'dropped'}`, async () => {
    const data = await fixture('exact');
    data.results[0].collectionName = theirs;
    await withResponse(Response.json(data), async (ctx) => {
      const result = await lookup(album(ours), ctx);
      assert('candidates' in result);
      assertEquals(
        result.candidates.map((c) => c.confidence),
        confidence ? [confidence] : [],
      );
      if (confidence) {
        assertEquals(
          result.candidates[0].evidence.editionNotesIgnored,
          ignored,
        );
      }
    });
  });
}

for (
  const [name, artist, confidence] of [
    ['Abbey Road', null, 'medium'],
    ['Abbey Roads', null, null],
    ['Abbey Road', 'Miles Davis', null],
    ['Unrelated', 'The Beatles', null],
    // 43 / 50 = .86, 3 / 4 = .75: both thresholds are inclusive.
    ['x'.repeat(43) + 'y'.repeat(7), 'abcz', 'medium'],
    ['x'.repeat(42) + 'y'.repeat(8), 'abcz', null],
    ['x'.repeat(43) + 'y'.repeat(7), 'abzz', null],
  ] as const
) {
  Deno.test(`iTunes confidence ${name}/${artist}: ${confidence ?? 'dropped'}`, async () => {
    const data = await fixture('exact');
    if (name.startsWith('xxx')) {
      data.results[0].collectionName = 'x'.repeat(50);
      data.results[0].artistName = 'abcd';
    }
    await withResponse(Response.json(data), async (ctx, hits) => {
      const result = await lookup(album(name, artist), ctx);
      assert('candidates' in result);
      assertEquals(result.candidates.length, confidence ? 1 : 0);
      if (confidence) assertEquals(result.candidates[0].confidence, confidence);
      if (artist === null) {
        assertEquals(hits[0].searchParams.get('term'), name);
        if (confidence) {
          assertEquals(result.candidates[0].evidence.artistSimilarity, null);
        }
      }
    });
  });
}

for (
  const [name, artist, countries, expected] of [
    ['Группа крови', 'Кино', ['us', 'ru'], 'ru'],
    ['Abbey Road', 'Кино', ['us', 'ru'], 'us'],
    ['Группа крови', 'Кино', ['us'], 'us'],
    ['Abbey Road', 'The Beatles', ['ru'], 'ru'],
    ['Abbey Road', 'The Beatles', ['gb', 'ru'], 'gb'],
  ] as const
) {
  Deno.test(`iTunes store for ${name} from ${countries}: ${expected}`, async () => {
    const data = await fixture(name === 'Группа крови' ? 'cyrillic' : 'exact');
    await withResponse(Response.json(data), async (ctx, hits) => {
      ctx.settings.countries = [...countries];
      const result = await lookup(album(name, artist), ctx);
      assertEquals(hits[0].searchParams.get('country'), expected);
      if (name === 'Группа крови') {
        assert('candidates' in result);
        assertEquals(result.candidates[0].confidence, 'strong');
        assertEquals(result.candidates[0].evidence.country, expected);
        assertEquals(hits[0].searchParams.get('term'), 'Группа крови Кино');
      }
    });
  });
}

Deno.test('iTunes null/empty names and an empty country list make no requests', async () => {
  await withResponse(
    Response.json(await fixture('exact')),
    async (ctx, hits) => {
      for (const name of [null, '', '---']) {
        assertEquals(await lookup(album(name), ctx), { candidates: [] });
      }
      ctx.settings.countries = [];
      assertEquals(await lookup(album(), ctx), { candidates: [] });
      assertEquals(hits, []);
    },
  );
});

Deno.test('iTunes recorded 429 response requests retry after the supplied seconds', async () => {
  const data = await fixture('429');
  await withResponse(Response.json(data.body, data), async (ctx) => {
    assertEquals(await lookup(album(), ctx), {
      retryAfter: 120,
      reason: 'iTunes search HTTP 429',
    });
  });
});

for (const status of [429, 503]) {
  for (const value of [null, 'invalid', '0']) {
    Deno.test(`iTunes ${status} retry header ${value} honors zero or defaults to 600s`, async () => {
      await withResponse(
        new Response('', {
          status,
          headers: value === null ? {} : { 'Retry-After': value },
        }),
        async (ctx) => {
          assertEquals(await lookup(album(), ctx), {
            retryAfter: value === '0' ? 0 : 600,
            reason: `iTunes search HTTP ${status}`,
          });
        },
      );
    });
  }
}

Deno.test('iTunes Retry-After also accepts an HTTP date', async () => {
  const after = Date.now() + 120000;
  await withResponse(
    new Response('', {
      status: 503,
      headers: { 'Retry-After': new Date(after).toUTCString() },
    }),
    async (ctx) => {
      const before = Date.now();
      const result = await lookup(album(), ctx);
      const finished = Date.now();
      assert('retryAfter' in result);
      const date = Math.floor(after / 1000) * 1000;
      assert(
        result.retryAfter >= Math.max(0, Math.ceil((date - finished) / 1000)),
      );
      assert(
        result.retryAfter <= Math.max(0, Math.ceil((date - before) / 1000)),
      );
    },
  );
});

for (const status of [400, 404, 500]) {
  Deno.test(`iTunes HTTP ${status} throws an error`, async () => {
    await withResponse(new Response('error', { status }), async (ctx) => {
      await assertRejects(() => lookup(album(), ctx), Error, `HTTP ${status}`);
    });
  });
}

for (const body of ['{', 'null', '{}', '{"results":{}}', '{"results":[{}]}']) {
  Deno.test(`iTunes malformed response ${body} throws`, async () => {
    await withResponse(new Response(body), async (ctx) => {
      await assertRejects(() => lookup(album(), ctx));
    });
  });
}
