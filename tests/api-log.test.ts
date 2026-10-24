import { assert, assertEquals } from '@std/assert';
import { statusFixture } from './helpers/api-status.ts';
import { error, iso } from './helpers/api.ts';
import { parseLogfmt } from './helpers/logging.ts';

const base = '/api/v1/admin/log';
Deno.test('API log: ordered records, sequence paging, severity/component filters and logfmt download', async () => {
  const f = await statusFixture();
  try {
    const admin = (await f.login()).credential;
    f.logger.clear();
    f.lines.length = 0;
    f.logger.event('fixture_info', { payload: 'first' });
    f.logger.event('fixture_warn', { payload: 'second' });
    f.logger.event('hat_found', { hat: 'sample' });
    f.logger.event('fixture_error', { payload: 'last' });
    const page = async (query = '') => {
      const response = await f.get(base + query, admin, { Origin: f.origin });
      assertEquals(response.status, 200);
      return response.json();
    };
    const all = await page();
    assertEquals(all.records.map((r: { event: string }) => r.event), [
      'fixture_info',
      'fixture_warn',
      'hat_found',
      'fixture_error',
    ]);
    assertEquals(all.next, null);
    for (const [i, record] of all.records.entries()) {
      iso(record.time);
      assertEquals(record.sequence, all.records[0].sequence + i);
      assertEquals(record.fields.sequence, record.sequence);
    }
    const first = await page('?limit=2');
    assertEquals(first.records, all.records.slice(0, 2));
    assertEquals(first.next, first.records[1].sequence);
    const second = await page(`?limit=2&after=${first.next}`);
    assertEquals(second.records, all.records.slice(2));
    assertEquals(second.next, null);
    assertEquals((await page('?level=warn')).records, [
      all.records[1],
      all.records[3],
    ]);
    assertEquals((await page('?component=hats')).records, [all.records[2]]);
    assertEquals((await page('?level=error&component=logging')).records, [
      all.records[3],
    ]);
    assertEquals((await page('?component=unknown')).records, []);
    const pageSetting = await f.json('/api/v1/admin/settings', 'PATCH', {
      changes: [{ key: 'melofon.logPageRecords', value: 2 }],
    }, admin);
    assertEquals(pageSetting.status, 200);
    await pageSetting.text();
    assertEquals((await page()).records, all.records.slice(0, 2));
    const text = await f.get(`${base}/text`, admin);
    assert(text.headers.get('content-type')?.startsWith('text/plain'));
    assert(text.headers.get('content-disposition')?.includes('melofon.log'));
    const printed = await text.text();
    assertEquals(printed, f.lines.join(''));
    assertEquals(
      printed.trim().split('\n').map(parseLogfmt).map((r) => r.event),
      all.records.map((r: { event: string }) => r.event),
    );
  } finally {
    await f.close();
  }
});

Deno.test('API log: inherited authentication, Origin, strict query validation and ring-only clear', async () => {
  const f = await statusFixture();
  try {
    const admin = (await f.login()).credential;
    await f.auth.users.create(f.admin.id, {
      username: 'reader',
      password: 'password-reader',
      role: 'user',
    });
    const user =
      (await f.login('bearer', 'reader', 'password-reader')).credential;
    for (
      const [path, method] of [[base, 'GET'], [`${base}/text`, 'GET'], [
        base,
        'DELETE',
      ]]
    ) {
      await error(
        await f.json(path, method, undefined),
        401,
        'unauthenticated',
      );
      await error(
        await f.json(path, method, undefined, user),
        403,
        'forbidden',
      );
    }
    for (
      const q of [
        'after=-1',
        'after=1.5',
        'after=9007199254740992',
        'after=',
        'limit=0',
        'limit=1001',
        'limit=1e2',
        'level=warning',
        'level=',
        'component=',
        'component=a%20b',
        'unknown=1',
        'limit=1&limit=2',
      ]
    ) {
      await error(await f.get(`${base}?${q}`, admin), 400, 'invalid_field');
    }
    f.logger.clear();
    f.lines.length = 0;
    f.logger.event('fixture_info', { payload: 'keep durable sink' });
    const before =
      (await (await f.get(base, admin)).json()).records[0].sequence;
    await error(
      await f.json(base, 'DELETE', undefined, admin, 'http://foreign.home'),
      403,
      'origin',
    );
    assertEquals((await (await f.get(base, admin)).json()).records.length, 1);
    const cleared = await f.json(base, 'DELETE', undefined, admin);
    assertEquals(cleared.status, 204);
    assertEquals(await cleared.text(), '');
    assertEquals(await (await f.get(base, admin)).json(), {
      records: [],
      next: null,
    });
    assertEquals(await (await f.get(`${base}/text`, admin)).text(), '');
    assertEquals(f.lines.length, 1);
    f.logger.event('fixture_info', {});
    assertEquals(
      (await (await f.get(base, admin)).json()).records[0].sequence,
      before + 1,
    );
  } finally {
    await f.close();
  }
});

Deno.test('API log: registered secrets, credential queries and write-only settings never reach either read surface', async () => {
  const f = await statusFixture(true, true);
  try {
    const admin = (await f.login('bearer')).credential;
    f.state.declare('fixture.credential', { type: 'string', writeOnly: true });
    const secret = 'write-only-fixture-9247';
    const changed = await f.json('/api/v1/admin/settings', 'PATCH', {
      changes: [{ key: 'fixture.credential', value: secret }],
    }, admin);
    assertEquals(changed.status, 200);
    await changed.text();
    f.logger.registerSecrets(['registered-fixture-428']);
    const rest = await f.request(
      '/rest/ping?u=admin&p=password-admin&c=fixture&v=1.16.1&f=json',
    );
    assertEquals(rest.status, 200);
    assertEquals((await rest.json())['subsonic-response'].status, 'ok');
    f.logger.event('fixture_info', {
      payload: {
        value: `${secret} registered-fixture-428`,
        request: new Request(
          `${f.origin}/rest/ping?u=leak-user&p=leak-password&t=leak-token&s=leak-salt&apiKey=leak-api-key&safe=visible`,
        ),
      },
    });
    // Opaque dependency diagnostics use the same credential-syntax projection.
    f.logger.event('dependency_console', {
      method: 'warn',
      args: [
        `GET /rest/ping?u=opaque-user&p=opaque-password&t=opaque-token&s=opaque-salt&apiKey=opaque-key`,
      ],
    });
    const json = await (await f.get(base, admin)).text();
    const text = await (await f.get(`${base}/text`, admin)).text();
    for (const output of [json, text]) {
      for (
        const value of [
          secret,
          'password-admin',
          'registered-fixture-428',
          'leak-user',
          'leak-password',
          'leak-token',
          'leak-salt',
          'leak-api-key',
          'opaque-user',
          'opaque-password',
          'opaque-token',
          'opaque-salt',
          'opaque-key',
        ]
      ) assert(!output.includes(value), value);
      assert(output.includes('redacted'));
      assert(output.includes('visible'));
    }
  } finally {
    await f.close();
  }
});

Deno.test('API log: live owner-declared ring capacity bounds retention, resize, reset and clear keeps sequence', async () => {
  const f = await statusFixture();
  try {
    const admin = (await f.login('bearer')).credential;
    const settings =
      (await (await f.get('/api/v1/admin/settings', admin)).json()).settings;
    const setting = settings.find((s: { key: string }) =>
      s.key === 'log.ringRecords'
    );
    assertEquals(setting.owner, 'core');
    assertEquals(setting.value, 1000);
    assertEquals(setting.schema.minimum, 100);
    assertEquals(setting.schema.maximum, 20000);
    for (const value of [99, 20001]) {
      const invalid = await f.json('/api/v1/admin/settings', 'PATCH', {
        changes: [{ key: 'log.ringRecords', value }],
      }, admin);
      assertEquals(invalid.status, 400);
      await invalid.text();
    }
    const change = async (change: object) => {
      const response = await f.json('/api/v1/admin/settings', 'PATCH', {
        changes: [{ key: 'log.ringRecords', ...change }],
      }, admin);
      assertEquals(response.status, 200);
      await response.text();
    };
    await change({ value: 100 });
    f.logger.clear();
    for (let i = 0; i < 125; i++) {
      f.logger.event('fixture_info', { payload: i });
    }
    let records = (await (await f.get(base, admin)).json()).records;
    assertEquals(records.length, 100);
    assertEquals(records[0].fields.payload, 25);
    assertEquals(records.at(-1).fields.payload, 124);
    await change({ value: 200 });
    for (let i = 125; i < 200; i++) {
      f.logger.event('fixture_info', { payload: i });
    }
    records = (await (await f.get(base, admin)).json()).records;
    assertEquals(records.length, 175);
    assertEquals(records[0].fields.payload, 25);
    await change({ value: 100 });
    assertEquals(
      (await (await f.get(base, admin)).json()).records[0].fields.payload,
      100,
    );
    await change({ reset: true });
    f.logger.clear();
    for (let i = 0; i < 1005; i++) {
      f.logger.event('fixture_info', { payload: i });
    }
    records = (await (await f.get(base, admin)).json()).records;
    assertEquals(records.length, 1000);
    assertEquals(records[0].fields.payload, 5);
  } finally {
    await f.close();
  }
});
