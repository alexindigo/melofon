import { assert, assertEquals, assertRejects } from '@std/assert';
import { cp } from 'node:fs/promises';
import { apiFixture, error } from './helpers/api.ts';
import type { Hat } from '../layers/melofon/types.ts';

const base = '/api/v1/admin/hats';

async function fixtureHat(
  root: string,
  name: string,
  manifest = {},
  source?: string,
) {
  await Deno.mkdir(`${root}/${name}/routes/probe`, { recursive: true });
  await Deno.writeTextFile(
    `${root}/${name}/manifest.json`,
    JSON.stringify({
      routes: `/${name}`,
      ...manifest,
    }),
  );
  await Deno.writeTextFile(
    `${root}/${name}/routes/probe/get.ts`,
    source ??
      `export default () => ({hat: ${JSON.stringify(name)}});`,
  );
}
async function fixture() {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-api-hats-' });
  const root = `${dir}/layers`;
  try {
    await cp('layers', root, { recursive: true });
    await fixtureHat(root, 'extra', {
      port: 12345,
      settings: { 'fixture.message': { type: 'string', default: 'ready' } },
    });
    await fixtureHat(root, 'bad-json');
    await Deno.writeTextFile(`${root}/bad-json/manifest.json`, '{bad');
    await fixtureHat(
      root,
      'bad-import',
      {},
      'throw new Error("fixture import failure"); export default () => "never";',
    );
    await fixtureHat(
      root,
      'setup-fixture',
      { setup: true },
      'throw new Error("setup must not import"); export default () => "never";',
    );
    // This hat deliberately bypasses API middleware to observe the core port's
    // authorization and loader scope through a real HTTP consumer.
    await fixtureHat(
      root,
      'service-probe',
      {},
      `
export default async (request, context) => {
  const p = new URL(request._raw.url).searchParams;
  const hats = context.app.hats;
  try {
    const result = await hats[p.get('op')](p.get('caller'), p.get('name'));
    return {result, methods: Object.keys(hats).sort()};
  } catch (error) {
    return new Response(JSON.stringify({code: error.code, type: error.name}), {
      status: error.code === 'forbidden' ? 403 : 409,
      headers: {'Content-Type': 'application/json'}
    });
  }
};`,
    );
    const f = await apiFixture({
      hats: {
        layersRoot: root,
        extraPorts: 3,
        env: ([own, ws, actual]) => ({
          MELOFON_LISTEN_owntone: `${own},${ws}`,
          MELOFON_LISTEN_extra: String(actual),
        }),
      },
    });
    return {
      ...f,
      root,
      actual: f.extraPorts[2],
      async list(credential: string) {
        const response = await f.get(base, credential);
        assertEquals(response.status, 200);
        return await response.json() as {
          hats: Hat[];
          restartRequired: boolean;
        };
      },
      async close() {
        await f.close();
        await Deno.remove(dir, { recursive: true });
      },
    };
  } catch (error) {
    await Deno.remove(dir, { recursive: true });
    throw error;
  }
}

Deno.test('API hats: admin list exposes shipped and fixture lifecycle facts; every route rejects users', async () => {
  const f = await fixture();
  try {
    const admin = await f.login('cookie');
    await f.auth.users.create(f.admin.id, {
      username: 'reader',
      password: 'password-reader',
      role: 'user',
    });
    const user = await f.login('bearer', 'reader', 'password-reader');
    for (
      const [method, path, body] of [
        ['GET', base, undefined],
        ['POST', `${base}/rescan`, {}],
        ['PUT', `${base}/extra/active`, { active: true }],
        ['PUT', `${base}/extra/active`, { active: false }],
      ] as const
    ) {
      await error(
        await f.json(path, method, body, user.credential),
        403,
        'forbidden',
      );
      await error(await f.json(path, method, body), 401, 'unauthenticated');
    }
    const list = await f.list(admin.credential);
    assertEquals(list.restartRequired, false);
    for (const name of ['melofon', 'opensubsonic', 'owntone', 'share']) {
      const hat = list.hats.find((hat) => hat.name === name)!;
      assertEquals([
        hat.state,
        hat.active,
        hat.pendingRestart,
        hat.errors,
        hat.setup,
      ], ['active', true, false, [], false]);
    }
    const extra = list.hats.find((hat) => hat.name === 'extra')!;
    assertEquals(Object.keys(extra).sort(), [
      'active',
      'errors',
      'mounts',
      'name',
      'pendingRestart',
      'ports',
      'settings',
      'setup',
      'state',
    ]);
    assertEquals(extra.ports, { claimed: [12345], actual: [f.actual] });
    assertEquals(extra.mounts, [{
      folder: `${f.root}/extra/routes`,
      prefix: '/extra',
    }]);
    assertEquals(extra.settings, ['fixture.message']);
    assertEquals(extra.state, 'loaded');
    for (
      const [name, phase, code] of [
        ['bad-json', 'manifest', 'hat_manifest_failed'],
        ['bad-import', 'import', 'hat_import_failed'],
      ]
    ) {
      const hat = list.hats.find((hat) => hat.name === name)!;
      assertEquals(hat.state, 'failed');
      assertEquals(hat.errors[0].phase, phase);
      assertEquals(hat.errors[0].code, code);
      assert(hat.errors[0].message.length > 0);
      assert(hat.errors[0].file?.startsWith(`${f.root}/${name}`));
    }
    assertEquals(
      list.hats.find((hat) => hat.name === 'setup-fixture')?.setup,
      true,
    );
    const rescan = await f.json(`${base}/rescan`, 'POST', {}, admin.credential);
    assertEquals(rescan.status, 200);
    assertEquals(await rescan.json(), list);
  } finally {
    await f.close();
  }
});

Deno.test('API hats: runtime activation opens a mapped port; deactivation keeps serving and notifies', async () => {
  const f = await fixture();
  try {
    const admin = await f.login('bearer');
    const fetchExtra = () =>
      fetch(`http://melofon.home:${f.actual}/extra/probe`, {
        signal: AbortSignal.timeout(2000),
      });
    await assertRejects(fetchExtra, TypeError);
    const before = f.notifications.length;
    let response = await f.json(
      `${base}/extra/active`,
      'PUT',
      { active: true },
      admin.credential,
    );
    assertEquals(response.status, 200);
    let hat = await response.json();
    assertEquals([hat.state, hat.active, hat.pendingRestart], [
      'active',
      true,
      false,
    ]);
    response = await fetchExtra();
    assertEquals(await response.json(), { hat: 'extra' });
    assertEquals((await f.list(admin.credential)).restartRequired, false);
    response = await f.json(
      `${base}/extra/active`,
      'PUT',
      { active: false },
      admin.credential,
    );
    assertEquals(response.status, 200);
    hat = await response.json();
    assertEquals([hat.state, hat.active, hat.pendingRestart], [
      'active',
      false,
      true,
    ]);
    response = await fetchExtra();
    assertEquals(await response.json(), { hat: 'extra' });
    assertEquals((await f.list(admin.credential)).restartRequired, true);
    assertEquals(f.notifications.slice(before), [['hats'], ['hats']]);
    await error(
      await f.json(
        `${base}/melofon/active`,
        'PUT',
        { active: false },
        admin.credential,
      ),
      409,
      'hat_self',
    );
    await error(
      await f.json('/_melofon/api/v1/admin/hats/melofon/active', 'PUT', {
        active: false,
      }, admin.credential),
      409,
      'hat_self',
    );
    assertEquals(
      (await f.list(admin.credential)).hats.find((h) => h.name === 'melofon')
        ?.active,
      true,
    );
  } finally {
    await f.close();
  }
});

Deno.test('API hats: rescan imports no code; found activation waits; failed/reserved/unknown and bind errors are typed', async () => {
  const f = await fixture();
  const held = Deno.listen({ hostname: '0.0.0.0', port: f.actual });
  let heldOpen = true;
  try {
    const admin = await f.login('bearer');
    const marker = `${f.root}/imported`;
    await fixtureHat(
      f.root,
      'later',
      {},
      `Deno.writeTextFileSync(${
        JSON.stringify(marker)
      }, 'imported'); throw new Error('must not import'); export default () => 'never';`,
    );
    let response = await f.json(`${base}/rescan`, 'POST', {}, admin.credential);
    assertEquals(response.status, 200);
    assertEquals(
      (await response.json()).hats.find((h: Hat) => h.name === 'later').state,
      'found',
    );
    response = await f.json(
      `${base}/later/active`,
      'PUT',
      { active: true },
      admin.credential,
    );
    assertEquals(response.status, 200);
    const later = await response.json();
    assertEquals([later.state, later.active, later.pendingRestart], [
      'found',
      true,
      true,
    ]);
    assertEquals((await f.list(admin.credential)).restartRequired, true);
    await assertRejects(() => Deno.stat(marker), Deno.errors.NotFound);
    response = await f.get('/later/probe');
    assertEquals(response.status, 404);
    await response.body?.cancel();
    for (const active of [true, false]) {
      for (
        const [name, status, code] of [
          ['bad-json', 409, 'hat_failed'],
          ['bad-import', 409, 'hat_failed'],
          ['setup-fixture', 409, 'hat_reserved'],
          ['missing', 404, 'not_found'],
        ] as const
      ) {
        await error(
          await f.json(
            `${base}/${name}/active`,
            'PUT',
            { active },
            admin.credential,
          ),
          status,
          code,
        );
      }
    }
    const failed = await error(
      await f.json(
        `${base}/extra/active`,
        'PUT',
        { active: true },
        admin.credential,
      ),
      409,
      'activation_failed',
    );
    const extra = (await f.list(admin.credential)).hats.find((h) =>
      h.name === 'extra'
    )!;
    assertEquals([extra.state, extra.active], ['loaded', false]);
    assertEquals(extra.errors[0].phase, 'activate');
    assertEquals(failed.message, extra.errors[0].message);
    assertEquals(
      (await f.store.hats.list()).find((h) => h.name === 'extra'),
      undefined,
    );
    held.close();
    heldOpen = false;
    response = await f.json(
      `${base}/extra/active`,
      'PUT',
      { active: true },
      admin.credential,
    );
    assertEquals(response.status, 200);
    assertEquals((await response.json()).errors, []);
    response = await fetch(`http://melofon.home:${f.actual}/extra/probe`, {
      signal: AbortSignal.timeout(2000),
    });
    assertEquals(await response.json(), { hat: 'extra' });
  } finally {
    if (heldOpen) held.close();
    await f.close();
  }
});

Deno.test('API hats: active input and inherited JSON/Origin boundaries apply before mutations', async () => {
  const f = await fixture();
  try {
    const bearer = await f.login('bearer');
    const cookie = await f.login('cookie');
    const path = `${base}/extra/active`;
    for (const active of [undefined, null, 'true', 1, [], {}]) {
      await error(
        await f.json(path, 'PUT', { active }, bearer.credential),
        400,
        'invalid_field',
      );
    }
    await error(
      await f.json(
        path,
        'PUT',
        { active: true, extra: true },
        bearer.credential,
      ),
      400,
      'unknown_field',
    );
    await error(
      await f.json(
        `${base}/rescan`,
        'POST',
        { extra: true },
        bearer.credential,
      ),
      400,
      'unknown_field',
    );
    for (const body of ['{bad', '[]', 'null']) {
      await error(
        await f.request(path, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${bearer.credential}`,
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
          Authorization: `Bearer ${bearer.credential}`,
          Origin: f.origin,
          'Content-Type': 'text/plain',
        },
        body: '{}',
      }),
      415,
      'unsupported_media_type',
    );
    await error(
      await f.json(
        path,
        'PUT',
        { active: true, extra: 'x'.repeat(65536) },
        bearer.credential,
      ),
      413,
      'too_large',
    );
    for (
      const [target, method, body] of [
        [path, 'PUT', { active: true }],
        [`${base}/rescan`, 'POST', {}],
      ] as const
    ) {
      for (const origin of ['http://foreign.test', 'null']) {
        for (const signed of [bearer, cookie]) {
          await error(
            await f.json(target, method, body, signed.credential, origin),
            403,
            'origin',
          );
        }
      }
      await error(
        await f.json(target, method, body, cookie.credential, null),
        403,
        'origin',
      );
    }
    assertEquals(
      (await f.list(bearer.credential)).hats.find((h) => h.name === 'extra')
        ?.active,
      false,
    );
    const response = await f.json(
      path,
      'PUT',
      { active: true },
      bearer.credential,
      null,
    );
    assertEquals(response.status, 200);
    await response.body?.cancel();
  } finally {
    await f.close();
  }
});

Deno.test('API hats: core port checks fresh caller roles for every method and loader scopes self protection per hat', async () => {
  const f = await fixture();
  try {
    const admin = await f.login('bearer');
    const user = await f.auth.users.create(f.admin.id, {
      username: 'reader',
      password: 'password-reader',
      role: 'user',
    });
    const signed = await f.login('bearer', 'reader', 'password-reader');
    let response = await f.json(`${base}/service-probe/active`, 'PUT', {
      active: true,
    }, admin.credential);
    assertEquals(response.status, 200);
    await response.body?.cancel();
    const probe = (op: string, caller: string, name = 'extra') =>
      f.get(
        `/service-probe/probe?${new URLSearchParams({ op, caller, name })}`,
      );
    for (const op of ['list', 'rescan', 'activate', 'deactivate']) {
      for (const caller of [user.id, 'missing-user']) {
        response = await probe(op, caller);
        assertEquals(response.status, 403);
        assertEquals(await response.json(), {
          code: 'forbidden',
          type: 'HatServiceError',
        });
      }
    }
    response = await probe('list', f.admin.id);
    assertEquals(response.status, 200);
    assertEquals((await response.json()).methods, [
      'activate',
      'deactivate',
      'list',
      'rescan',
    ]);
    response = await probe('deactivate', f.admin.id, 'service-probe');
    assertEquals(response.status, 409);
    assertEquals(await response.json(), {
      code: 'hat_self',
      type: 'HatServiceError',
    });
    await f.auth.users.update(f.admin.id, user.id, { role: 'admin' });
    response = await probe('list', user.id);
    assertEquals(response.status, 200);
    await response.body?.cancel();
    response = await f.get(base, signed.credential);
    assertEquals(response.status, 200);
    await response.body?.cancel();
    await f.auth.users.update(f.admin.id, user.id, { role: 'user' });
    for (const op of ['list', 'rescan', 'activate', 'deactivate']) {
      response = await probe(op, user.id);
      assertEquals(response.status, 403);
      await response.body?.cancel();
    }
    await error(await f.get(base, signed.credential), 403, 'forbidden');
    assertEquals(
      (await f.list(admin.credential)).hats.find((h) => h.name === 'extra')
        ?.active,
      false,
    );
  } finally {
    await f.close();
  }
});
