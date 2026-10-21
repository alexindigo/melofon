// H1C common protocol: client versions, login mechanism errors, empty-value
// normalization, JSONP and binary-operation XML errors, driven through the
// real facade/loadLayers with a recording service bag. The facade tests use
// only existing routes so the unchanged predecessor fails them behaviourally.
// Pure-function units load the plugin modules at run time (see unitModule).
import { assert, assertEquals } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { facade } from '../src/facade.ts';
import { loadLayers } from '../src/layers.ts';

const USER = { username: 'fixture', displayName: 'Fixture' };
const AUTH = { u: 'fixture', p: 'secret', v: '1.16.1', c: 'h1c' };
const VERSION = '0.0.0-h1c';
const XML = 'application/xml; charset=utf-8';
const TEXT_XML = 'text/xml; charset=utf-8';
const JSONP_KEY = 'opensubsonic.jsonp';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

interface Calls {
  auth: string[][];
  authMd5: string[][];
  state: string[];
}

async function router(
  jsonp: string | null = null,
  version = VERSION,
) {
  const calls: Calls = { auth: [], authMd5: [], state: [] };
  const none = () => Promise.resolve(null);
  const app = {
    cfg: { version },
    user: {
      auth(username: string, password: string) {
        calls.auth.push([username, password]);
        return Promise.resolve(
          username === 'fixture' && password === 'secret' ? USER : null,
        );
      },
      authMd5(username: string, token: string, salt: string) {
        calls.authMd5.push([username, token, salt]);
        return Promise.resolve(
          username === 'fixture' && token === 'token' && salt === 'salt'
            ? USER
            : null,
        );
      },
    },
    state: {
      declare() {},
      get(key: string) {
        calls.state.push(key);
        return Promise.resolve(key === JSONP_KEY ? jsonp : null);
      },
    },
    library: {
      getSong: none,
      songPath: none,
      getAlbum: none,
      getArtist: none,
      artistById: none,
      albumsByArtist: () => Promise.resolve([]),
    },
    playlists: { get: none },
    artwork: {
      cover: () => Promise.resolve(new Response(PNG)),
      placeholder: () => new Response(PNG),
    },
  };
  const core = await pathfinder({ roots: ['core/'], app: {} });
  return { calls, app: facade(core, await loadLayers({ app })) };
}

type App = Awaited<ReturnType<typeof router>>['app'];

function query(values: Record<string, string>): string {
  return new URLSearchParams(values).toString();
}

async function get(app: App, op: string, values: Record<string, string>) {
  return await app(new Request(`http://x/rest/${op}?${query(values)}`));
}

interface Outcome {
  status: string;
  code?: number;
  message?: string;
  contentType: string | null;
  body: Record<string, unknown>;
  raw: string;
}

// Every rendered envelope must keep the server-identity claims unchanged.
function claims(envelope: Record<string, unknown>, version = VERSION) {
  assertEquals(envelope.version, '1.16.1');
  assertEquals(envelope.type, 'melofon');
  assertEquals(envelope.serverVersion, version);
  assertEquals(envelope.openSubsonic, true);
}

async function outcome(res: Response, version = VERSION): Promise<Outcome> {
  const contentType = res.headers.get('content-type');
  const raw = await res.text();
  if (contentType?.startsWith('application/json')) {
    const body = JSON.parse(raw)['subsonic-response'];
    claims(body, version);
    const error = body.error as { code: number; message: string } | undefined;
    return {
      status: body.status,
      code: error?.code,
      message: error?.message,
      contentType,
      body,
      raw,
    };
  }
  const attrs = (tag: string) => {
    const match = new RegExp(`<${tag}( [^>]*?)/?>`).exec(raw);
    const out: Record<string, string> = {};
    for (const [, k, v] of match?.[1].matchAll(/ ([\w]+)="([^"]*)"/g) ?? []) {
      out[k] = v;
    }
    return out;
  };
  assert(raw.startsWith('<?xml version="1.0" encoding="UTF-8"?>'), raw);
  const root = attrs('subsonic-response');
  assertEquals(root.xmlns, 'http://subsonic.org/restapi');
  claims({ ...root, openSubsonic: root.openSubsonic === 'true' }, version);
  const error = attrs('error');
  return {
    status: root.status,
    code: error.code === undefined ? undefined : Number(error.code),
    message: error.message,
    contentType,
    body: root,
    raw,
  };
}

async function json(app: App, op: string, values: Record<string, string>) {
  return await outcome(await get(app, op, { ...values, f: 'json' }));
}

const CONFLICT = 'Multiple conflicting authentication mechanisms provided.';
const UNSUPPORTED = 'Provided authentication mechanism not supported.';
const MISSING = 'Required parameter is missing';
const WRONG = 'Wrong username or password';

Deno.test('H1C versions: compatible and unparseable client versions authenticate', async () => {
  const { app } = await router();
  for (
    const v of ['1.16.1', '1.16.9', '1.13.0', '1.7.0', '1.6.0', 'abc', '1']
  ) {
    assertEquals((await json(app, 'ping', { ...AUTH, v })).status, 'ok', v);
  }
  assertEquals(
    (await json(app, 'ping', { ...AUTH, v: '1.16.x' })).status,
    'ok',
  );
});

Deno.test('H1C versions: newer clients get 30 and an older major gets 20', async () => {
  const { app, calls } = await router();
  for (
    const v of [
      '1.17.0',
      '2.0.0',
      '1.99999999999999999999',
      '1.017.0',
      '10.0',
    ]
  ) {
    const value = await json(app, 'ping', { ...AUTH, v });
    assertEquals([value.status, value.code], ['failed', 30], v);
    assertEquals(
      value.message,
      'Incompatible Subsonic REST protocol version. Server must upgrade.',
    );
  }
  for (const v of ['0.9.0', '0.99', '00.16.1']) {
    const value = await json(app, 'ping', { ...AUTH, v });
    assertEquals([value.status, value.code], ['failed', 20], v);
    assertEquals(
      value.message,
      'Incompatible Subsonic REST protocol version. Client must upgrade.',
    );
  }
  assertEquals(calls.auth, []);
});

Deno.test('H1C versions: an empty v is missing', async () => {
  const { app } = await router();
  const value = await json(app, 'ping', { ...AUTH, v: '' });
  assertEquals([value.code, value.message], [10, MISSING]);
});

Deno.test('H1C API keys alone are unsupported (42); with u/p/t/s they conflict (43)', async () => {
  const { app, calls } = await router();
  const alone = await json(app, 'ping', { apiKey: 'key', v: '1.16.1', c: 'h' });
  assertEquals([alone.code, alone.message], [42, UNSUPPORTED]);
  const combos: Record<string, string>[] = [
    { u: 'fixture' },
    { p: 'secret' },
    { t: 'token' },
    { s: 'salt' },
    { u: 'fixture', p: 'secret' },
    { u: 'fixture', t: 'token', s: 'salt' },
    { u: 'fixture', p: 'secret', t: 'token', s: 'salt' },
  ];
  for (const combo of combos) {
    const value = await json(app, 'ping', {
      ...combo,
      apiKey: 'key',
      v: '1.16.1',
      c: 'h',
    });
    assertEquals([value.code, value.message], [43, CONFLICT], query(combo));
  }
  assertEquals([calls.auth, calls.authMd5], [[], []]);
});

Deno.test('H1C a password together with token or salt conflicts (43)', async () => {
  const { app, calls } = await router();
  const extras: Record<string, string>[] = [
    { t: 'token' },
    { s: 'salt' },
    { t: 'token', s: 'salt' },
  ];
  for (const extra of extras) {
    const value = await json(app, 'ping', { ...AUTH, ...extra });
    assertEquals([value.code, value.message], [43, CONFLICT], query(extra));
  }
  assertEquals([calls.auth, calls.authMd5], [[], []]);
});

Deno.test('H1C incomplete credentials are code 10, not 40', async () => {
  const { app, calls } = await router();
  const base = { u: 'fixture', v: '1.16.1', c: 'h1c' };
  const extras: Record<string, string>[] = [
    { t: 'token' },
    { s: 'salt' },
    {},
    { p: '' },
  ];
  for (const extra of extras) {
    const value = await json(app, 'ping', { ...base, ...extra });
    assertEquals([value.code, value.message], [10, MISSING], query(extra));
  }
  assertEquals([calls.auth, calls.authMd5], [[], []]);
});

Deno.test('H1C empty u/v/c/p/t/s/apiKey count as not sent; form values still win', async () => {
  const post = async (app: App, form: Record<string, string>, q: string) =>
    await outcome(
      await app(
        new Request(`http://x/rest/ping?${q}`, {
          method: 'POST',
          body: new URLSearchParams({ ...form, f: 'json' }),
        }),
      ),
    );
  const valid = query(AUTH);
  for (const name of ['u', 'v', 'c', 'p']) {
    const { app, calls } = await router();
    const value = await post(app, { [name]: '' }, valid);
    assertEquals([value.code, value.message], [10, MISSING], name);
    assertEquals([calls.auth, calls.authMd5], [[], []], name);
  }
  {
    // The empty winning p is absent, so the query token pair is the login.
    const { app, calls } = await router();
    const value = await post(
      app,
      { p: '' },
      query({ u: 'fixture', t: 'token', s: 'salt', v: '1.16.1', c: 'h' }),
    );
    assertEquals(value.status, 'ok');
    assertEquals(calls.authMd5, [['fixture', 'token', 'salt']]);
    assertEquals(calls.auth, []);
  }
  for (const name of ['t', 's']) {
    const { app, calls } = await router();
    const value = await post(
      app,
      { [name]: '' },
      query({ u: 'fixture', t: 'token', s: 'salt', v: '1.16.1', c: 'h' }),
    );
    assertEquals([value.code, value.message], [10, MISSING], name);
    assertEquals(calls.authMd5, [], name);
  }
  {
    const { app, calls } = await router();
    const value = await post(app, { apiKey: '' }, `${valid}&apiKey=key`);
    assertEquals(value.status, 'ok');
    assertEquals(calls.auth, [['fixture', 'secret']]);
  }
  {
    // Query empties are absent too; a nonempty form value still wins.
    const { app } = await router();
    const value = await post(app, AUTH, 't=&s=&apiKey=');
    assertEquals(value.status, 'ok');
  }
});

Deno.test('H1C decision order: mechanism errors, then missing fields, then version, then verification', async () => {
  const { app, calls } = await router();
  const conflict = await json(app, 'ping', {
    u: 'fixture',
    p: 'secret',
    t: 'token',
    c: 'h',
  });
  assertEquals(conflict.code, 43);
  const apiKey = await json(app, 'ping', { apiKey: 'key', c: 'h' });
  assertEquals(apiKey.code, 42);
  const missingC = await json(app, 'ping', {
    u: 'fixture',
    p: 'secret',
    v: '2.0.0',
  });
  assertEquals(missingC.code, 10);
  const missingCredentials = await json(app, 'ping', {
    u: 'fixture',
    v: '0.1.0',
    c: 'h',
  });
  assertEquals(missingCredentials.code, 10);
  assertEquals(calls.auth, []);
  const newer = await json(app, 'ping', { ...AUTH, p: 'wrong', v: '1.17.0' });
  assertEquals(newer.code, 30);
  const older = await json(app, 'ping', { ...AUTH, p: 'wrong', v: '0.9.0' });
  assertEquals(older.code, 20);
  assertEquals(calls.auth, []);
  const wrong = await json(app, 'ping', { ...AUTH, p: 'wrong' });
  assertEquals([wrong.code, wrong.message], [40, WRONG]);
  assertEquals(calls.auth, [['fixture', 'wrong']]);
});

Deno.test('H1C discovery stays public with conflicting credentials and f=jsonp', async () => {
  const off = await router();
  const publicCases: Record<string, string>[] = [
    { apiKey: 'key', u: 'x', p: 'y', t: 'z', f: 'json' },
    { apiKey: 'key', f: 'json' },
    { p: 'y', s: 'z', v: '9.0.0', f: 'json' },
  ];
  for (const values of publicCases) {
    const value = await outcome(
      await get(off.app, 'getOpenSubsonicExtensions', values),
    );
    assertEquals(value.status, 'ok', query(values));
  }
  const xml = await get(off.app, 'getOpenSubsonicExtensions.view', {
    f: 'jsonp',
    callback: 'cb',
    apiKey: 'key',
  });
  assertEquals(xml.headers.get('content-type'), XML);
  assertEquals((await outcome(xml)).status, 'ok');
  const on = await router('on');
  const res = await get(on.app, 'getOpenSubsonicExtensions', {
    f: 'jsonp',
    callback: 'cb',
    apiKey: 'key',
    u: 'x',
  });
  assertEquals(res.headers.get('content-type'), 'application/javascript');
  const raw = await res.text();
  assert(raw.startsWith('cb(') && raw.endsWith(')'), raw);
  const value = JSON.parse(raw.slice(3, -1))['subsonic-response'];
  claims(value);
  assertEquals(value.openSubsonicExtensions, [
    { name: 'formPost', versions: [1] },
    { name: 'transcodeOffset', versions: [1] },
    { name: 'transcoding', versions: [1] },
    { name: 'songLyrics', versions: [1, 2] },
    { name: 'indexBasedQueue', versions: [1] },
    { name: 'playbackReport', versions: [1] },
    { name: 'topSongsByArtistId', versions: [1] },
  ]);
  assertEquals(on.calls.auth, []);
});

Deno.test('H1C JSONP off: f=jsonp is an unrecognized format and renders XML', async () => {
  for (const setting of [null, 'off', 'ON', 'true', '']) {
    const { app, calls } = await router(setting);
    const res = await get(app, 'ping', {
      ...AUTH,
      f: 'jsonp',
      callback: 'cb',
    });
    assertEquals(res.headers.get('content-type'), XML, String(setting));
    const value = await outcome(res);
    assertEquals(value.status, 'ok');
    assert(!value.raw.includes('cb('));
    assertEquals(calls.state, [JSONP_KEY]);
  }
});

Deno.test('H1C JSONP on: callback(json) with script content type and nosniff', async () => {
  const { app } = await router('on');
  for (
    const [op, values] of [
      ['ping', AUTH],
      ['ping', { ...AUTH, p: 'wrong' }],
    ] as const
  ) {
    const res = await get(app, op, {
      ...values,
      f: 'jsonp',
      callback: 'angular.callbacks._0',
    });
    assertEquals(res.status, 200);
    assertEquals(res.headers.get('content-type'), 'application/javascript');
    assertEquals(res.headers.get('x-content-type-options'), 'nosniff');
    const raw = await res.text();
    const prefix = 'angular.callbacks._0(';
    assert(raw.startsWith(prefix) && raw.endsWith(')'), raw);
    const envelope = JSON.parse(raw.slice(prefix.length, -1));
    claims(envelope['subsonic-response']);
    assertEquals(
      raw,
      `${prefix}${JSON.stringify(envelope)})`,
      'callback wraps exactly the JSON envelope',
    );
  }
  const failed = await get(app, 'ping', {
    ...AUTH,
    p: 'wrong',
    f: 'jsonp',
    callback: '$cb',
  });
  const raw = await failed.text();
  const value = JSON.parse(raw.slice(4, -1))['subsonic-response'];
  assertEquals([value.status, value.error.code], ['failed', 40]);
  const miss = await get(app, 'jukeboxControl', {
    ...AUTH,
    f: 'jsonp',
    callback: '_',
  });
  assertEquals(miss.status, 404);
  assertEquals(miss.headers.get('content-type'), 'application/javascript');
  assert((await miss.text()).startsWith('_({'));
});

Deno.test('H1C JSONP escapes U+2028 and U+2029 inside the callback body', async () => {
  const version = '0.0.0-h1c\u2028line\u2029paragraph';
  const { app } = await router('on', version);
  const res = await get(app, 'ping', { ...AUTH, f: 'jsonp', callback: 'cb' });
  const raw = await res.text();
  assert(!raw.includes('\u2028') && !raw.includes('\u2029'), raw);
  assert(raw.includes('\\u2028line\\u2029paragraph'), raw);
  const value = JSON.parse(raw.slice(3, -1))['subsonic-response'];
  claims(value, version);
  const plain = await get(app, 'ping', { ...AUTH, f: 'json' });
  assertEquals((await outcome(plain, version)).status, 'ok');
});

Deno.test('H1C JSONP missing/invalid callbacks are plain JSON errors and never reflected', async () => {
  const { app, calls } = await router('on');
  const missing = await get(app, 'ping', { ...AUTH, f: 'jsonp' });
  assertEquals(missing.headers.get('content-type'), 'application/json');
  const m = await outcome(missing);
  assertEquals([m.status, m.code, m.message], ['failed', 10, MISSING]);
  for (
    const callback of [
      'alert(1)//',
      '1abc',
      'a-b',
      'a b',
      '<script>',
      'cb;evil',
      '',
      'cb\u2028',
    ]
  ) {
    const res = await get(app, 'ping', { ...AUTH, f: 'jsonp', callback });
    assertEquals(res.headers.get('content-type'), 'application/json');
    const value = await outcome(res);
    assertEquals(
      [value.status, value.code, value.message],
      ['failed', 0, 'invalid callback parameter'],
      callback,
    );
    if (callback !== '') assert(!value.raw.includes(callback), callback);
  }
  // Callback errors precede discovery, mechanism, missing and version checks.
  const first: Record<string, string>[] = [
    { f: 'jsonp', callback: 'a-b' },
    { f: 'jsonp', callback: 'a-b', apiKey: 'k', u: 'x' },
    { ...AUTH, v: '9.0.0', f: 'jsonp', callback: 'a-b' },
  ];
  for (const values of first) {
    const value = await outcome(await get(app, 'ping', values));
    assertEquals(value.code, 0, query(values));
  }
  const discovery = await outcome(
    await get(app, 'getOpenSubsonicExtensions', { f: 'jsonp' }),
  );
  assertEquals([discovery.status, discovery.code], ['failed', 10]);
  const conflictMissing = await outcome(
    await get(app, 'ping', { ...AUTH, t: 'token', f: 'jsonp' }),
  );
  assertEquals(conflictMissing.code, 10);
  assertEquals([calls.auth, calls.authMd5], [[], []]);
});

Deno.test('H1C the JSONP setting is read only for f=jsonp', async () => {
  for (const f of [undefined, 'xml', 'json', 'JSONP', 'jsonp ', 'JSON']) {
    const { app, calls } = await router('on');
    const values: Record<string, string> = { ...AUTH };
    if (f !== undefined) values.f = f;
    const res = await get(app, 'ping', values);
    assertEquals(calls.state, [], String(f));
    if (f !== 'json') assertEquals(res.headers.get('content-type'), XML);
    await res.body?.cancel();
  }
  const { app, calls } = await router('on');
  await (await get(app, 'ping', { ...AUTH, f: 'jsonp', callback: 'cb' }))
    .text();
  assertEquals(calls.state, [JSONP_KEY]);
});

const BINARY = [
  'stream',
  'stream.view',
  'download',
  'download.view',
  'getCoverArt',
  'getCoverArt.view',
  'getAvatar',
  'getAvatar.view',
  'hls.m3u8',
];

Deno.test('H1C XML errors from stream/download/getCoverArt/getAvatar/hls.m3u8 use text/xml', async () => {
  const { app } = await router();
  for (const op of BINARY) {
    for (const method of ['GET', 'POST']) {
      const body = query({ ...AUTH, p: 'wrong', id: 'missing' });
      const res = await app(
        method === 'GET'
          ? new Request(`http://x/rest/${op}?${body}`)
          : new Request(`http://x/rest/${op}`, {
            method,
            body: new URLSearchParams(body),
          }),
      );
      assertEquals(res.headers.get('content-type'), TEXT_XML, op + method);
      const value = await outcome(res);
      assertEquals([value.status, value.code], ['failed', 40], op);
    }
    const version = await get(app, op, { ...AUTH, v: '2.0.0', id: 'x' });
    assertEquals(version.headers.get('content-type'), TEXT_XML, op);
    assertEquals((await outcome(version)).code, 30, op);
    const missing = await get(app, op, { u: 'fixture', v: '1.16.1', c: 'h' });
    assertEquals(missing.headers.get('content-type'), TEXT_XML, op);
    assertEquals((await outcome(missing)).code, 10, op);
  }
  for (const op of ['stream', 'download.view', 'hls.m3u8']) {
    const res = await get(app, op, { ...AUTH, id: 'missing' });
    assertEquals(res.headers.get('content-type'), TEXT_XML, op);
    const value = await outcome(res);
    assertEquals([value.code, value.message], [
      70,
      'The requested data was not found',
    ], op);
  }
  const noId = await get(app, 'getCoverArt', AUTH);
  assertEquals(noId.headers.get('content-type'), TEXT_XML);
  assertEquals((await outcome(noId)).code, 10);
});

Deno.test('H1C other XML responses stay application/xml', async () => {
  const { app } = await router();
  for (
    const [op, values] of [
      ['ping', { ...AUTH, p: 'wrong' }],
      ['ping', AUTH],
      ['getLicense', { ...AUTH, v: '2.0.0' }],
      ['hls/segment.ts', { ...AUTH, p: 'wrong' }],
      ['streamXYZ', AUTH],
      ['stream.viewXYZ', AUTH],
      ['jukeboxControl', AUTH],
      ['getOpenSubsonicExtensions', {}],
    ] as const
  ) {
    const res = await get(app, op, values);
    assertEquals(res.headers.get('content-type'), XML, op);
    await outcome(res);
  }
});

Deno.test('H1C JSON errors on binary operations still follow f=json', async () => {
  const { app } = await router();
  for (const op of BINARY) {
    const res = await get(app, op, { ...AUTH, p: 'wrong', f: 'json' });
    assertEquals(res.headers.get('content-type'), 'application/json', op);
    assertEquals((await outcome(res)).code, 40, op);
  }
  const notFound = await get(app, 'stream', {
    ...AUTH,
    id: 'missing',
    f: 'json',
  });
  assertEquals(notFound.headers.get('content-type'), 'application/json');
  assertEquals((await outcome(notFound)).code, 70);
});

Deno.test('H1C every envelope still reports protocol 1.16.1 and unchanged server identity', async () => {
  const { app } = await router();
  for (const f of ['json', 'xml']) {
    for (
      const values of [AUTH, { ...AUTH, p: 'wrong' }, { ...AUTH, v: '2.0' }]
    ) {
      const res = await get(app, 'ping', { ...values, f });
      const value = await outcome(res);
      assertEquals(value.body.version, '1.16.1');
    }
  }
});

// Pure-function units. The modules are new in H1C, so they load through a
// computed specifier: the unchanged predecessor can type-check and run the
// facade regressions above, where these units fail on the absent module and
// are not counted as behavioural red.
interface ProtocolModule {
  API_VERSION: string;
  checkVersion(version: string): 'compatible' | 'client-old' | 'server-old';
  operationName(pathname: string, ext: string | undefined): string;
  BINARY_OPERATIONS: ReadonlySet<string>;
}
interface CredentialsModule {
  classifyCredentials(values: {
    u: string | null;
    p: string | null;
    t: string | null;
    s: string | null;
    apiKey: string | null;
  }): { kind: string; [key: string]: unknown };
  winningValue(params: URLSearchParams, name: string): string | null;
}
async function unitModule<T>(name: string): Promise<T> {
  const specifier = new URL(`../layers/opensubsonic/${name}`, import.meta.url);
  return await import(specifier.href) as T;
}

Deno.test('unit: version compatibility compares exact digit strings', async () => {
  const { API_VERSION, checkVersion } = await unitModule<ProtocolModule>(
    'protocol.ts',
  );
  assertEquals(API_VERSION, '1.16.1');
  const expected: Record<string, string> = {
    '1.16.1': 'compatible',
    '1.16.9': 'compatible',
    '1.16.99999999999999999999': 'compatible',
    '1.13.0': 'compatible',
    '1.7.0': 'compatible',
    '1.6.0': 'compatible',
    '1.0': 'compatible',
    '01.016.000': 'compatible',
    '1.17.0': 'server-old',
    '1.017': 'server-old',
    '1.99999999999999999999': 'server-old',
    '2.0.0': 'server-old',
    '99999999999999999999.0': 'server-old',
    '0.9.0': 'client-old',
    '0.99999999999999999999': 'client-old',
    '000.16.1': 'client-old',
    'abc': 'compatible',
    '1': 'compatible',
    '1.16.x': 'compatible',
    '1..16': 'compatible',
    '.1.16': 'compatible',
    '1.16.': 'compatible',
    '-1.0': 'compatible',
    '+2.0': 'compatible',
    ' 2.0': 'compatible',
    '２.0': 'compatible',
  };
  for (const [v, result] of Object.entries(expected)) {
    assertEquals(checkVersion(v), result, v);
  }
});

Deno.test('unit: credential classification of winning values', async () => {
  const { classifyCredentials, winningValue } = await unitModule<
    CredentialsModule
  >('credentials.ts');
  type Values = Parameters<CredentialsModule['classifyCredentials']>[0];
  const none: Values = { u: null, p: null, t: null, s: null, apiKey: null };
  const kind = (values: Partial<Values>) =>
    classifyCredentials({ ...none, ...values }).kind;
  assertEquals(kind({ apiKey: 'k' }), 'unsupported');
  for (const extra of ['u', 'p', 't', 's']) {
    assertEquals(kind({ apiKey: 'k', [extra]: 'x' }), 'conflict', extra);
  }
  assertEquals(kind({ u: 'a', p: 'b', t: 'c' }), 'conflict');
  assertEquals(kind({ u: 'a', p: 'b', s: 'c' }), 'conflict');
  assertEquals(kind({ p: 'b', t: 'c', s: 'd' }), 'conflict');
  assertEquals(kind({ u: 'a' }), 'missing');
  assertEquals(kind({ u: 'a', t: 'c' }), 'missing');
  assertEquals(kind({ u: 'a', s: 'c' }), 'missing');
  assertEquals(kind({ p: 'b' }), 'missing');
  assertEquals(kind({ t: 'c', s: 'd' }), 'missing');
  assertEquals(kind({}), 'missing');
  assertEquals(classifyCredentials({ ...none, u: 'a', p: 'b' }), {
    kind: 'password',
    username: 'a',
    password: 'b',
  });
  assertEquals(classifyCredentials({ ...none, u: 'a', t: 'c', s: 'd' }), {
    kind: 'token',
    username: 'a',
    token: 'c',
    salt: 'd',
  });
  const params = new URLSearchParams('u=&u=query&p=x&p=&t=0');
  assertEquals(winningValue(params, 'u'), null);
  assertEquals(winningValue(params, 'p'), 'x');
  assertEquals(winningValue(params, 't'), '0');
  assertEquals(winningValue(params, 's'), null);
});

Deno.test('unit: operation names strip only a routed .view suffix', async () => {
  const { operationName, BINARY_OPERATIONS } = await unitModule<
    ProtocolModule
  >('protocol.ts');
  assertEquals(operationName('/stream', undefined), 'stream');
  assertEquals(operationName('/stream.view', '.view'), 'stream');
  assertEquals(operationName('/stream.view', undefined), 'stream.view');
  assertEquals(operationName('/streamXYZ', 'XYZ'), 'streamXYZ');
  assertEquals(operationName('/stream.view/', '.view'), 'stream.view/');
  assertEquals(operationName('/hls.m3u8', undefined), 'hls.m3u8');
  assertEquals(operationName('/hls/segment.ts', undefined), 'hls/segment.ts');
  assertEquals(
    [...BINARY_OPERATIONS].sort(),
    ['download', 'getAvatar', 'getCoverArt', 'hls.m3u8', 'stream'],
  );
});
