import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
} from '@std/assert';
import { cp } from 'node:fs/promises';
import { encodeBase64 } from '@std/encoding/base64';
import { createHatData } from '../src/hat-data.ts';
import { atomic, engineForTesting } from '../src/store/engine.ts';
import { deleteHatRecordsForUser } from '../src/store/hat-data.ts';
import { rawSql } from '../src/store/testing.ts';
import { apiFixture } from './helpers/api.ts';
import { authFixture } from './helpers/authentication.ts';
import { pixelPng } from './helpers/pixel-image.ts';

async function fixtureHats(dir: string) {
  const root = `${dir}/layers`;
  await cp('layers/melofon', `${root}/melofon`, { recursive: true });
  const handler = `
import { decodeBase64, encodeBase64 } from '@std/encoding/base64';
export const disableStreaming = true;
export default async function(request, context) {
  const store = context.app.hatData;
  const p = new URL(request._raw.url).searchParams;
  const scope = p.has('user') ? {userId: p.get('user')} : undefined;
  try {
    if (p.has('inspect')) return {
      frozen: Object.isFrozen(store), methods: Object.keys(store).sort(),
      factory: typeof store === 'function', rawStore: 'store' in context.app,
      secret: 'secret' in context.app.cfg, password: 'password' in context.app.cfg,
      setup: 'setup' in context.app
    };
    if (request.method === 'POST') {
      const body = JSON.parse(new TextDecoder().decode(await request.body.bytes()));
      if (body.op === 'remove') return {removed: await store.remove(body.key, scope)};
      if (body.record.kind === 'image' && typeof body.record.value === 'string') {
        body.record.value = decodeBase64(body.record.value);
      }
      await store.put(body.key, body.record, scope);
      return {saved: true};
    }
    if (p.has('list')) return Response.json(await store.list(scope));
    const record = await store.get(p.get('key'), scope);
    if (record?.kind === 'image') {
      if (p.has('raw')) return new Response(record.value, {headers: {'content-type': record.contentType}});
      return Response.json({...record, value: encodeBase64(record.value)});
    }
    return Response.json(record);
  } catch (error) { return Response.json({error: error.message}, {status: 400}); }
}`;
  for (
    const [hat, mount] of [['melofon', 'api/data-probe'], ['other', 'probe']]
  ) {
    const path = `${root}/${hat}/${mount}`;
    await Deno.mkdir(path, { recursive: true });
    if (hat === 'other') {
      await Deno.writeTextFile(
        `${root}/other/manifest.json`,
        JSON.stringify({ probe: '/hat-probe' }),
      );
    }
    await Deno.writeTextFile(
      `${path}/20-auth.ts`,
      "export { default } from '#melofon/auth.ts';",
    );
    await Deno.writeTextFile(`${path}/get.ts`, handler);
    await Deno.writeTextFile(`${path}/post.ts`, handler);
  }
  return { layersRoot: root, extraPorts: 0, env: () => ({}) };
}

function consumer(
  f: Awaited<ReturnType<typeof apiFixture>>,
  credential: string,
) {
  const path = (other: boolean, query: string) =>
    `${other ? '/hat-probe' : '/api/v1/data-probe'}?${query}`;
  return {
    async read(query: string, other = false) {
      const response = await f.get(path(other, query), credential);
      assertEquals(response.status, 200, await response.clone().text());
      return response.json();
    },
    async write(body: unknown, query = '', other = false, status = 200) {
      const response = await f.json(
        path(other, query),
        'POST',
        body,
        credential,
      );
      assertEquals(response.status, status, await response.clone().text());
      return response.json();
    },
  };
}

Deno.test('HTTP hat records isolate namespaces and owner scopes and survive upgrade/restart', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-hat-data-' });
  const hats = await fixtureHats(dir);
  const storeDir = `${dir}/data`;
  // Real pre-feature database: no table, existing users and hat flags retained.
  const old = await authFixture(undefined, storeDir);
  await rawSql(old.store).run('DROP TABLE hat_records');
  const userId = old.admin.id;
  await old.close();
  let f = await apiFixture({
    hats,
    storeDir,
    services: async (f) => {
      await f.store.hats.set('other', true);
      return {};
    },
  });
  try {
    assert(
      (await Deno.resolveDns('melofon.home', 'A')).every((ip) =>
        !ip.startsWith('127.')
      ),
    );
    const cookie = (await f.login('cookie')).credential;
    const bearer = (await f.login('bearer')).credential;
    const c = consumer(f, cookie);
    const b = consumer(f, bearer);
    const inspect = {
      frozen: true,
      methods: ['get', 'list', 'put', 'remove'],
      factory: false,
      rawStore: false,
      secret: false,
      password: false,
      setup: false,
    };
    assertEquals(await c.read('inspect'), inspect);
    assertEquals(await b.read('inspect', true), inspect);
    const data = {
      kind: 'data',
      value: {
        algorithmVersion: 1,
        sourceHash: 'hash',
        thumbHash: 'bytes',
        dominantColor: '#112233',
        width: 3,
        height: 2,
        nested: [null, false, 3],
      },
    };
    const other = { kind: 'data', value: 'other hat' };
    const owned = { kind: 'data', value: 'user owned' };
    const key = "same/'key";
    const query = `key=${encodeURIComponent(key)}`;
    const scope = `user=${userId}`;
    await c.write({ key, record: data });
    assertEquals(await b.read(query, true), null);
    assertEquals(await b.read('list', true), []);
    assertEquals(await b.write({ op: 'remove', key }, '', true), {
      removed: false,
    });
    assertEquals(await c.read(query), data);
    await b.write({ key, record: other }, '', true);
    await c.write({ key, record: owned }, scope);
    assertEquals(await c.read(`${query}&${scope}`), owned);
    assertEquals(await c.read(`${query}&user=missing`), null);
    assertEquals(await c.read(`list&${scope}`), [{ key, kind: 'data' }]);
    assertEquals(await b.read(query, true), other);
    assertEquals(await b.read('list', true), [{ key, kind: 'data' }]);
    await c.write({ key, record: data }, 'user=missing', false, 400);
    await c.write({ key, record: data }, 'user=', false, 400);
    await c.write({ key: '', record: data }, '', false, 400);
    await c.write(
      { key, record: { kind: 'image', value: '/arbitrary/path' } },
      '',
      false,
      400,
    );
    assertEquals(await c.read(query), data);
    const denied = await f.get('/api/v1/data-probe?list');
    assertEquals(denied.status, 401);
    await denied.arrayBuffer();
    await f.close();
    f = await apiFixture({ hats, storeDir });
    assertEquals(f.admin.id, userId);
    const restarted = consumer(f, bearer);
    assertEquals(await restarted.read(query), data);
    assertEquals(await restarted.read(query, true), other);
    assertEquals(await restarted.read(`${query}&${scope}`), owned);
    await restarted.write({ key, record: { kind: 'data', value: null } });
    assertEquals(await restarted.read(query), { kind: 'data', value: null });
    assertEquals(await restarted.write({ op: 'remove', key }), {
      removed: true,
    });
    assertEquals(await restarted.write({ op: 'remove', key }), {
      removed: false,
    });
    assertEquals(await restarted.read('list'), []);
    assertEquals(await restarted.read(query, true), other);
    assertEquals(await restarted.read(`${query}&${scope}`), owned);
  } finally {
    await f.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('HTTP credential records encrypt, bind ciphertext to scope and fail closed without the secret', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-hat-credentials-' });
  const hats = await fixtureHats(dir);
  const storeDir = `${dir}/data`;
  let secret: string | undefined = 'test-secret';
  const options = {
    hats,
    storeDir,
    services: async (f: Awaited<ReturnType<typeof authFixture>>) => {
      await f.store.hats.set('other', true);
      return { hatData: createHatData(f.store, { secret }) };
    },
  };
  let f = await apiFixture(options);
  try {
    const bearer = (await f.login('bearer')).credential;
    let c = consumer(f, bearer);
    const record = { kind: 'credential', value: 'private app credential' };
    await c.write({ key: 'same', record });
    const first = (await f.store.hatData.get('melofon', '', 'same'))!;
    assert(!first.payload.includes(record.value));
    assert(first.payload.startsWith('aes-gcm-v1:'));
    assertEquals(await c.read('key=same'), record);
    assertEquals(await c.read('list'), [{ key: 'same', kind: 'credential' }]);
    assertEquals(await c.read('key=same', true), null);
    // Copying valid encrypted bytes to another hat, key or owner cannot decrypt.
    for (
      const row of [{ ...first, hat: 'other' }, { ...first, key: 'copied' }, {
        ...first,
        ownerScope: f.admin.id,
      }]
    ) {
      await f.store.hatData.put(row);
      const response = await f.get(
        `${
          row.hat === 'other' ? '/hat-probe' : '/api/v1/data-probe'
        }?key=${row.key}${row.ownerScope ? `&user=${row.ownerScope}` : ''}`,
        bearer,
      );
      assertEquals(response.status, 400);
      assertEquals(await response.json(), {
        error: 'Cannot decrypt hat credential',
      });
    }
    await c.write({ key: 'same', record });
    assertNotEquals(
      (await f.store.hatData.get('melofon', '', 'same'))!.payload,
      first.payload,
    );
    await f.close();
    f = await apiFixture(options);
    c = consumer(f, bearer);
    assertEquals(await c.read('key=same'), record);
    for (const unavailable of [undefined, 'wrong-secret']) {
      await f.close();
      secret = unavailable;
      f = await apiFixture(options);
      c = consumer(f, bearer);
      const response = await f.get('/api/v1/data-probe?key=same', bearer);
      assertEquals(response.status, 400);
      const text = await response.text();
      assert(!text.includes(record.value));
      if (!unavailable) {
        await c.write(
          { key: 'same', record: { kind: 'credential', value: 'replacement' } },
          '',
          false,
          400,
        );
        assertEquals(
          await c.write({ key: 'data', record: { kind: 'data', value: true } }),
          { saved: true },
        );
        assertEquals(await c.read('key=data'), { kind: 'data', value: true });
      }
    }
    await f.close();
    secret = 'test-secret';
    f = await apiFixture(options);
    c = consumer(f, bearer);
    assertEquals(await c.read('key=same'), record);
    const current = (await f.store.hatData.get('melofon', '', 'same'))!;
    await f.store.hatData.put({
      ...current,
      payload: current.payload.slice(0, -2) +
        (current.payload.endsWith('00') ? '01' : '00'),
    });
    const corrupt = await f.get('/api/v1/data-probe?key=same', bearer);
    assertEquals(corrupt.status, 400);
    assertEquals(await corrupt.json(), {
      error: 'Cannot decrypt hat credential',
    });
    await c.write({ key: 'same', record: { kind: 'data', value: 'retyped' } });
    assertEquals(await c.read('key=same'), { kind: 'data', value: 'retyped' });
  } finally {
    await f.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('hat record user cleanup is atomic across hats and preserves other scopes', async () => {
  const f = await authFixture();
  try {
    const other = await f.auth.users.create(f.admin.id, {
      username: 'other',
      password: 'password-other',
      role: 'user',
    });
    const service = createHatData(f.store, f.cfg);
    for (const hat of ['melofon', 'other']) {
      for (const userId of [undefined, f.admin.id, other.id]) {
        await service(hat).put('same', {
          kind: 'data',
          value: userId ?? 'global',
        }, { userId });
      }
    }
    const engine = engineForTesting(f.store);
    await assertRejects(
      () =>
        atomic(engine, async (q) => {
          assertEquals(
            (await deleteHatRecordsForUser(q, f.admin.id)).length,
            2,
          );
          throw new Error('abort user deletion');
        }),
      Error,
      'abort user deletion',
    );
    assertEquals(await service('melofon').get('same', { userId: f.admin.id }), {
      kind: 'data',
      value: f.admin.id,
    });
    const retired = await atomic(
      engine,
      (q) => deleteHatRecordsForUser(q, f.admin.id),
    );
    assertEquals(retired.map((r) => r.hat).sort(), ['melofon', 'other']);
    assert(retired.every((r) => r.ownerScope === f.admin.id));
    for (const hat of ['melofon', 'other']) {
      assertEquals(await service(hat).list({ userId: f.admin.id }), []);
      assertEquals(await service(hat).get('same', { userId: other.id }), {
        kind: 'data',
        value: other.id,
      });
      assertEquals(await service(hat).get('same'), {
        kind: 'data',
        value: 'global',
      });
    }
    await assertRejects(
      () => atomic(engine, (q) => deleteHatRecordsForUser(q, '')),
      Error,
      'user id',
    );
    assertEquals(await service('melofon').get('same'), {
      kind: 'data',
      value: 'global',
    });
    await assertRejects(
      () => service('melofon').put('invalid', { kind: 'data', value: NaN }),
      Error,
      'JSON',
    );
  } finally {
    await f.close();
  }
});

Deno.test('HTTP hat images use private durable files across migration, replacement and restart', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-hat-images-' });
  const hats = await fixtureHats(dir);
  const storeDir = `${dir}/data`;
  const old = await authFixture(undefined, storeDir);
  // The exact pre-image CHECK, with real data/credential rows, must upgrade.
  await rawSql(old.store).run('DROP TABLE hat_records');
  await rawSql(old.store).run(`CREATE TABLE hat_records (
    hat VARCHAR NOT NULL, owner_scope VARCHAR NOT NULL, key VARCHAR NOT NULL,
    kind VARCHAR NOT NULL CHECK (kind IN ('data', 'credential')),
    payload VARCHAR NOT NULL, PRIMARY KEY (hat, owner_scope, key))`);
  const previous = createHatData(old.store, old.cfg)('melofon');
  await previous.put('data', { kind: 'data', value: ['kept', 5] });
  await previous.put('credential', {
    kind: 'credential',
    value: 'kept-secret',
  });
  const encrypted =
    (await old.store.hatData.get('melofon', '', 'credential'))!.payload;
  await old.close();
  let f = await apiFixture({
    hats,
    storeDir,
    services: async (f) => {
      await f.store.hats.set('other', true);
      return {};
    },
  });
  const image = pixelPng(1, 1, new Uint8Array([255, 0, 0, 255]));
  const replacement = pixelPng(
    2,
    1,
    new Uint8Array([0, 255, 0, 128, 0, 0, 255, 255]),
  );
  const record = (bytes: Uint8Array) => ({
    kind: 'image',
    value: encodeBase64(bytes),
  });
  const readback = (bytes: Uint8Array) => ({
    ...record(bytes),
    contentType: 'image/png',
  });
  const key = '../../same/image';
  const query = `key=${encodeURIComponent(key)}`;
  const names = async () =>
    (await Array.fromAsync(Deno.readDir(`${storeDir}/hat-images`))).map((e) =>
      e.name
    ).sort();
  try {
    const cookie = (await f.login('cookie')).credential;
    const bearer = (await f.login('bearer')).credential;
    let c = consumer(f, cookie);
    let b = consumer(f, bearer);
    const scope = `user=${f.admin.id}`;
    assertEquals(await c.read('key=data'), {
      kind: 'data',
      value: ['kept', 5],
    });
    assertEquals(await b.read('key=credential'), {
      kind: 'credential',
      value: 'kept-secret',
    });
    assertEquals(
      (await f.store.hatData.get('melofon', '', 'credential'))!.payload,
      encrypted,
    );
    await c.write({ key, record: record(image) });
    assertEquals(await c.read(query), readback(image));
    assertEquals(await b.read(query, true), null);
    assertEquals(await b.read('list', true), []);
    assertEquals(await b.write({ op: 'remove', key }, '', true), {
      removed: false,
    });
    await b.write({ key, record: record(replacement) }, '', true);
    await c.write({ key, record: record(replacement) }, scope);
    assertEquals(await c.read(`${query}&${scope}`), readback(replacement));
    assertEquals(await c.read(`${query}&user=missing`), null);
    assertEquals(await b.read(query, true), readback(replacement));
    assertEquals(await c.read(`list&${scope}`), [{ key, kind: 'image' }]);
    const files = await names();
    assertEquals(files.length, 3);
    for (const name of files) {
      assert(!name.includes('same'));
      assertEquals(
        (await Deno.stat(`${storeDir}/hat-images/${name}`)).mode! & 0o777,
        0o600,
      );
    }
    const row = (await f.store.hatData.get('melofon', '', key))!;
    assert(!row.payload.includes(encodeBase64(image)));
    assert(!row.payload.includes(storeDir));
    await f.close();
    f = await apiFixture({ hats, storeDir });
    c = consumer(f, cookie);
    b = consumer(f, bearer);
    assertEquals(await c.read(query), readback(image));
    assertEquals(await b.read(query, true), readback(replacement));
    for (const credential of [cookie, bearer]) {
      const response = await f.get(
        `/api/v1/data-probe?${query}&raw`,
        credential,
      );
      assertEquals(response.status, 200);
      assertEquals(response.headers.get('content-type'), 'image/png');
      assertEquals(new Uint8Array(await response.arrayBuffer()), image);
    }
    await c.write({ key, record: record(replacement) });
    assertEquals(await c.read(query), readback(replacement));
    assertEquals((await names()).length, 3);
    assert(!(await names()).includes(JSON.parse(row.payload).file));
    await Promise.all([
      c.write({ key, record: record(image) }),
      c.write({ key, record: record(replacement) }),
    ]);
    const concurrent = await c.read(query);
    assert(
      [encodeBase64(image), encodeBase64(replacement)].includes(
        concurrent.value,
      ),
    );
    assertEquals((await names()).length, 3);
    // Retyping any image retires its bytes, without affecting equal keys elsewhere.
    await c.write({ key, record: { kind: 'data', value: 'now data' } });
    assertEquals(await c.read(query), { kind: 'data', value: 'now data' });
    assertEquals((await names()).length, 2);
    await c.write({ key, record: record(image) });
    await c.write({
      key,
      record: { kind: 'credential', value: 'now credential' },
    });
    assertEquals(await c.read(query), {
      kind: 'credential',
      value: 'now credential',
    });
    assertEquals((await names()).length, 2);
    await c.write({ key, record: record(image) });
    assertEquals(await c.write({ op: 'remove', key }), { removed: true });
    assertEquals(await c.write({ op: 'remove', key }), { removed: false });
    assertEquals(await c.read(query), null);
    assertEquals(await b.read(query, true), readback(replacement));
    assertEquals(await c.read(`${query}&${scope}`), readback(replacement));
    await b.write({ op: 'remove', key }, '', true);
    await c.write({ op: 'remove', key }, scope);
    assertEquals(await names(), []);
  } finally {
    await f.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('HTTP hat image publication failures preserve old bytes and hide internal paths', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-hat-image-failure-' });
  const hats = await fixtureHats(dir);
  const storeDir = `${dir}/data`;
  let fail = false;
  const options = {
    hats,
    storeDir,
    services: (f: Awaited<ReturnType<typeof authFixture>>) =>
      Promise.resolve({
        hatData: createHatData(
          {
            hatData: {
              ...f.store.hatData,
              put(row) {
                if (fail) throw new Error('Injected publication failure');
                return f.store.hatData.put(row);
              },
            },
          },
          f.cfg,
          f.state,
        ),
      }),
  };
  let f = await apiFixture(options);
  const image = pixelPng(1, 1, new Uint8Array([20, 40, 60, 255]));
  const next = pixelPng(1, 1, new Uint8Array([60, 40, 20, 255]));
  const record = (bytes: Uint8Array) => ({
    kind: 'image',
    value: encodeBase64(bytes),
  });
  const files = `${storeDir}/hat-images`;
  const names = async () =>
    (await Array.fromAsync(Deno.readDir(files))).map((e) => e.name).sort();
  try {
    const credential = (await f.login('bearer')).credential;
    let c = consumer(f, credential);
    await c.write({ key: 'same', record: record(image) });
    const saved = await c.read('key=same');
    const original = await names();
    // Failure before file publication: actual filesystem refuses a new file.
    await Deno.chmod(files, 0o500);
    try {
      const result = await c.write(
        { key: 'same', record: record(next) },
        '',
        false,
        400,
      );
      assertEquals(result, { error: 'Cannot access hat image storage' });
      assert(!JSON.stringify(result).includes(dir));
      assertEquals(await c.read('key=same'), saved);
    } finally {
      await Deno.chmod(files, 0o700);
    }
    // Failure after durable file publication, before committing its reference.
    fail = true;
    await c.write({ key: 'same', record: record(next) }, '', false, 400);
    fail = false;
    assertEquals(await names(), original);
    assertEquals(await c.read('key=same'), saved);
    // The real atomic owner check also rolls back and retires the staged file.
    await c.write(
      { key: 'same', record: record(next) },
      'user=missing',
      false,
      400,
    );
    assertEquals(await names(), original);
    await f.state.set('hatData.maxImageBytes', String(image.length - 1));
    await c.write({ key: 'same', record: record(next) }, '', false, 400);
    await f.state.set('hatData.maxImageBytes', '20971520');
    await f.state.set('hatData.maxImagePixels', '1');
    await c.write(
      { key: 'same', record: record(pixelPng(2, 1, new Uint8Array(8))) },
      '',
      false,
      400,
    );
    await f.state.set('hatData.maxImagePixels', '64000000');
    await c.write(
      { key: 'same', record: record(new Uint8Array([1, 2, 3])) },
      '',
      false,
      400,
    );
    assertEquals(await names(), original);
    assertEquals(await c.read('key=same'), saved);
    await f.close();
    f = await apiFixture(options);
    c = consumer(f, credential);
    assertEquals(await c.read('key=same'), saved);
    await c.write({ key: 'same', record: record(next) });
    assertEquals(await c.read('key=same'), {
      ...record(next),
      contentType: 'image/png',
    });
    assertEquals((await names()).length, 1);
  } finally {
    await f.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('hat image cleanup honors committed references and rejects filesystem path authority', async () => {
  const f = await authFixture();
  const image = pixelPng(1, 1, new Uint8Array([1, 2, 3, 255]));
  const root = `${f.dir}/hat-images`;
  const create = () => createHatData(f.store, f.cfg, f.state);
  let service = create();
  const names = async () =>
    (await Array.fromAsync(Deno.readDir(root))).map((e) => e.name).sort();
  try {
    for (const hat of ['melofon', 'other']) {
      await service(hat).put('same', { kind: 'image', value: image });
      await service(hat).put('same', { kind: 'image', value: image }, {
        userId: f.admin.id,
      });
    }
    const live = await names();
    const engine = engineForTesting(f.store);
    await assertRejects(
      () =>
        atomic(engine, async (q) => {
          await deleteHatRecordsForUser(q, f.admin.id);
          throw new Error('abort');
        }),
      Error,
      'abort',
    );
    service = create();
    assertEquals(
      (await service('melofon').get('same', { userId: f.admin.id }))?.value,
      image,
    );
    assertEquals(await names(), live);
    const retired = await atomic(
      engine,
      (q) => deleteHatRecordsForUser(q, f.admin.id),
    );
    assertEquals(retired.length, 2);
    assert(retired.every((r) => r.kind === 'image'));
    // Simulate a crash between a file publish and SQL, and unrelated local data.
    const orphan = `${crypto.randomUUID()}.image`;
    const part = `${crypto.randomUUID()}.part`;
    await Deno.writeFile(`${root}/${orphan}`, image);
    await Deno.writeFile(`${root}/${part}`, image);
    await Deno.writeTextFile(`${root}/keep.txt`, 'unowned');
    service = create();
    for (const hat of ['melofon', 'other']) {
      assertEquals((await service(hat).get('same'))?.value, image);
      assertEquals(
        await service(hat).get('same', { userId: f.admin.id }),
        null,
      );
    }
    assertEquals((await names()).length, 3);
    assertEquals(await Deno.readTextFile(`${root}/keep.txt`), 'unowned');
    assert(!(await names()).includes(orphan));
    assert(!(await names()).includes(part));
    for (const r of retired) {
      assert(!(await names()).includes(JSON.parse(r.payload).file));
    }
    const row = (await f.store.hatData.get('melofon', '', 'same'))!;
    const ref = JSON.parse(row.payload);
    const outside = `${f.dir}/outside.png`;
    await Deno.writeFile(outside, image);
    // Even a corrupted internal reference cannot read or delete an outside path.
    await f.store.hatData.put({
      ...row,
      payload: JSON.stringify({ ...ref, file: outside }),
    });
    await assertRejects(
      () => service('melofon').get('same'),
      Error,
      'hat image storage',
    );
    await assertRejects(
      () => service('melofon').remove('same'),
      Error,
      'hat image storage',
    );
    assertEquals(await Deno.readFile(outside), image);
    await f.store.hatData.put(row);
    // Nor may a generated-looking file symlink confer authority to read a target.
    await Deno.remove(`${root}/${ref.file}`);
    await Deno.symlink(outside, `${root}/${ref.file}`);
    await assertRejects(
      () => service('melofon').get('same'),
      Error,
      'hat image storage',
    );
    await service('melofon').remove('same');
    assertEquals(await Deno.readFile(outside), image);
    await Deno.rename(root, `${root}-saved`);
    await Deno.symlink(`${root}-saved`, root);
    await assertRejects(
      () => service('other').put('same', { kind: 'image', value: image }),
      Error,
      'hat image storage',
    );
    assertEquals(await Deno.readFile(outside), image);
  } finally {
    await f.close();
  }
});
