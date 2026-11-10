import { assert, assertEquals, assertRejects } from '@std/assert';
import { createSecrets, SecretError, type Secrets } from '../src/secrets.ts';
import { createSpeakerCredentials } from '../src/speaker-credentials.ts';
import { createOutputs, type Outputs } from '../src/player.ts';
import { createPersistence } from '../src/persistence.ts';
import { createSpeakers } from '../src/speakers.ts';
import { openStore, type Store } from '../src/store/index.ts';
import { createSpeakersStore } from '../src/store/speakers.ts';
import { rawSql } from '../src/store/testing.ts';
import { appLogger, installLogger } from '../src/logging.ts';
import { captureLogs } from './helpers/logging.ts';
import { domainFixture } from './helpers/store.ts';
import { apiFixture } from './helpers/api.ts';

// Generate test credentials only in the guest. Assertions never render them,
// even on failure. They must not enter test names, receipts or command lines.
const canary = () => crypto.randomUUID() + crypto.randomUUID();
const row = (id = '1') => ({
  id,
  name: 'Room',
  type: 'AirPlay',
  host: 'speaker.home',
  port: 7000,
  selected: false,
  volume: 42,
  connectionStrategy: 'melofon' as const,
});
const binding = { speakerId: '1', kind: 'password' as const };

async function composition(
  store: Store,
  root: string | undefined,
  options: {
    secrets?: Secrets;
    notify?: NonNullable<Parameters<typeof createOutputs>[0]>['notify'];
  } = {},
) {
  const credentials = createSpeakerCredentials({
    store: store.speakers,
    secrets: options.secrets ?? createSecrets(root),
    current(id) {
      return outputs?.get(id, { includeIgnored: true })
        ? {
          revision: outputs.revision(id),
          adopted: outputs.lifetime(id).adopted,
        }
        : null;
    },
  });
  const persistence = createPersistence(store, undefined, credentials);
  const outputs: Outputs = createOutputs({
    persistence,
    notify: options.notify,
    releaseCredentials: credentials.release,
  });
  await outputs.ready();
  for (const saved of await persistence.loadOutputs()) outputs.restore(saved);
  const speakers = createSpeakers({
    outputs,
    adapterView: () => ({
      preparation: { state: 'unresolved', targetRevision: 0 },
    }),
  });
  return { outputs, credentials, persistence, speakers };
}

async function secretFailure(
  operation: () => Promise<unknown>,
  code: SecretError['code'],
) {
  const error = await assertRejects(operation, SecretError);
  assertEquals(error.code, code);
}

function heldSecrets(root: string) {
  const actual = createSecrets(root);
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => entered = resolve);
  const wait = new Promise<void>((resolve) => release = resolve);
  let hold = true;
  return {
    ready,
    release,
    secrets: {
      ...actual,
      async encrypt(...args: Parameters<Secrets['encrypt']>) {
        if (hold) {
          hold = false;
          entered();
          await wait;
        }
        return actual.encrypt(...args);
      },
    },
  };
}

Deno.test('speaker encryption authenticates version, identity, kind and bytes with fresh nonces', async () => {
  const root = canary(), value = canary();
  const secrets = createSecrets(root);
  const first = await secrets.encrypt(binding, value);
  const second = await secrets.encrypt(binding, value);
  assert(first !== second, 'Repeated encryption must use a fresh nonce');
  assert(/^1:speaker-credentials-v1:[0-9a-f]{24}:[0-9a-f]+$/.test(first));
  assert(
    await createSecrets(root).decrypt(binding, first) === value,
    'Roundtrip mismatch',
  );
  assert(
    !first.includes(value) && !first.includes(root),
    'Envelope leaked credential material',
  );
  await secretFailure(
    () => createSecrets(undefined).encrypt(binding, value),
    'secret_missing',
  );
  await secretFailure(
    () => createSecrets('').decrypt(binding, first),
    'secret_missing',
  );
  await secretFailure(
    () => createSecrets(canary()).decrypt(binding, first),
    'authentication_failed',
  );
  await secretFailure(
    () => secrets.decrypt({ ...binding, speakerId: '2' }, first),
    'authentication_failed',
  );
  await secretFailure(
    () => secrets.decrypt({ ...binding, kind: 'pairing-key' }, first),
    'authentication_failed',
  );
  const parts = first.split(':');
  for (const index of [2, 3]) {
    const modified = [...parts];
    modified[index] = (modified[index][0] === '0' ? '1' : '0') +
      modified[index].slice(1);
    await secretFailure(
      () => secrets.decrypt(binding, modified.join(':')),
      'authentication_failed',
    );
  }
  for (
    const malformed of [
      '',
      'plaintext',
      first + ':extra',
      first.slice(0, -1),
      first.replace(parts[2], 'gg'),
    ]
  ) {
    await secretFailure(
      () => secrets.decrypt(binding, malformed),
      'invalid_ciphertext',
    );
  }
  await secretFailure(
    () => secrets.decrypt(binding, first.replace(/^1:/, '2:')),
    'unsupported_ciphertext',
  );
  await secretFailure(
    () =>
      secrets.decrypt(
        binding,
        first.replace('credentials-v1', 'credentials-v2'),
      ),
    'unsupported_ciphertext',
  );
});

Deno.test('adopted speaker credentials reopen privately and missing or wrong roots never erase them', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-secrets-reopen-' });
  const root = canary(), password = canary(), pairing = canary();
  let store = await openStore(dir);
  try {
    let t = await composition(store, root);
    t.outputs.register(row());
    await t.outputs.adopt('1');
    await t.credentials.set('1', 'password', password);
    await t.credentials.set('1', 'pairing-key', pairing);
    const original = await store.speakers.loadCredential('1', 'password');
    assert(original !== null && !original.includes(password));
    await t.persistence.drain();
    await store.close();
    const bytes = new TextDecoder().decode(
      await Deno.readFile(`${dir}/melofon.duckdb`),
    );
    for (const value of [root, password, pairing]) {
      assert(!bytes.includes(value), 'Plaintext in database file');
    }
    store = await openStore(dir);
    t = await composition(store, root);
    assert(
      await t.credentials.get('1', 'password') === password,
      'Password restore mismatch',
    );
    assert(
      await t.credentials.get('1', 'pairing-key') === pairing,
      'Pairing key restore mismatch',
    );
    t.outputs.register(row('2'));
    await t.outputs.adopt('2');
    await store.speakers.saveCredential('2', 'password', original!);
    await secretFailure(
      () => t.credentials.get('2', 'password'),
      'authentication_failed',
    );
    await store.speakers.saveCredential('1', 'pairing-key', original!);
    await secretFailure(
      () => t.credentials.get('1', 'pairing-key'),
      'authentication_failed',
    );
    await t.credentials.set('1', 'pairing-key', pairing);
    for (const wrongRoot of [undefined, '', canary()]) {
      const wrong = await composition(store, wrongRoot);
      await secretFailure(
        () => wrong.credentials.get('1', 'password'),
        wrongRoot ? 'authentication_failed' : 'secret_missing',
      );
      if (!wrongRoot) {
        await secretFailure(
          () => wrong.credentials.set('1', 'password', canary()),
          'secret_missing',
        );
      }
      assert(
        await store.speakers.loadCredential('1', 'password') === original,
        'Failure changed ciphertext',
      );
    }
    // Re-entering after root loss is explicit replacement, never automatic regeneration.
    const replacement = canary(), newRoot = canary();
    const recovered = await composition(store, newRoot);
    await recovered.credentials.set('1', 'password', replacement);
    assert(
      await recovered.credentials.get('1', 'password') === replacement,
      'Explicit replacement failed',
    );
    await recovered.credentials.set('1', 'pairing-key', null);
    assertEquals(await recovered.credentials.get('1', 'pairing-key'), null);
    await store.close();
    store = await openStore(dir);
    const reopened = await composition(store, newRoot);
    assert(
      await reopened.credentials.get('1', 'password') === replacement,
      'Replacement did not persist',
    );
    assertEquals(await reopened.credentials.get('1', 'pairing-key'), null);
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('speaker credential table upgrades existing installations without changing saved identities', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-secrets-upgrade-' });
  let store = await openStore(dir);
  try {
    await store.speakers.saveAdopted(row());
    await store.speakers.saveIgnored('2');
    await rawSql(store).run('DROP TABLE speaker_credentials');
    await store.close();
    store = await openStore(dir);
    assertEquals(await store.speakers.loadAdopted(), [row()]);
    assertEquals(await store.speakers.loadIgnored(), ['2']);
    assertEquals(await store.speakers.loadCredential('1', 'password'), null);
    const t = await composition(store, canary());
    const value = canary();
    await t.credentials.set('1', 'password', value);
    assert(
      await t.credentials.get('1', 'password') === value,
      'Upgraded store credential mismatch',
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('temporary speaker credentials remain memory only and follow every registry release path', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-secrets-temporary-' });
  let store = await openStore(dir);
  try {
    const t = await composition(store, undefined);
    for (
      const release of [
        'unregister',
        'withdraw',
        'setEnabled',
        'toggle',
        'update',
        'ignore',
      ]
    ) {
      t.outputs.register(row());
      const value = canary();
      await t.credentials.set('1', 'password', value);
      await t.credentials.set('1', 'pairing-key', value);
      assert(
        await t.credentials.get('1', 'password') === value,
        'Temporary credential missing',
      );
      if (['setEnabled', 'toggle', 'update'].includes(release)) {
        t.outputs.setEnabled(['1']);
        t.outputs.withdraw('1');
        assert(
          await t.credentials.get('1', 'password') === value,
          'Selected identity lost credential',
        );
        if (release === 'setEnabled') t.outputs.setEnabled([]);
        else if (release === 'toggle') t.outputs.toggle('1');
        else t.outputs.update('1', { selected: false });
      } else if (release === 'unregister') t.outputs.unregister('1');
      else if (release === 'withdraw') t.outputs.withdraw('1');
      else {
        await t.outputs.ignore('1');
        await t.outputs.unignore('1');
      }
      t.outputs.register(row());
      assertEquals(await t.credentials.get('1', 'password'), null);
      assertEquals(await t.credentials.get('1', 'pairing-key'), null);
    }
    assertEquals(await store.speakers.loadAdopted(), []);
    assertEquals(await store.speakers.loadCredential('1', 'password'), null);
    assertEquals(await store.speakers.loadCredential('1', 'pairing-key'), null);
    await t.credentials.set('1', 'password', canary());
    await store.close();
    store = await openStore(dir);
    const reopened = await composition(store, undefined);
    reopened.outputs.register(row());
    assertEquals(await reopened.credentials.get('1', 'password'), null);
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('speaker configuration and both credential kinds adopt and forget atomically with rollback', async () => {
  const t = await domainFixture(createSpeakersStore);
  try {
    const secrets = createSecrets(canary());
    const value = canary();
    const records = await Promise.all(
      (['password', 'pairing-key'] as const).map(async (kind) => ({
        kind,
        ciphertext: await secrets.encrypt({ speakerId: '1', kind }, value),
      })),
    );
    await t.domain.saveIgnored('1');
    t.failCommit();
    await assertRejects(
      () => t.domain.saveAdopted(row(), records),
      Error,
      'injected commit failure',
    );
    assertEquals(await t.domain.loadAdopted(), []);
    assertEquals(await t.domain.loadIgnored(), ['1']);
    assertEquals(await t.domain.loadCredential('1', 'password'), null);
    assertEquals(await t.domain.loadCredential('1', 'pairing-key'), null);
    await t.domain.saveAdopted(row(), records);
    assertEquals(await t.domain.loadIgnored(), []);
    for (const record of records) {
      assert(
        await t.domain.loadCredential('1', record.kind) === record.ciphertext,
        'Credential save mismatch',
      );
    }
    t.failCommit();
    await assertRejects(
      () => t.domain.saveCredential('1', 'password', null),
      Error,
      'injected commit failure',
    );
    assert(
      await t.domain.loadCredential('1', 'password') === records[0].ciphertext,
      'Failed clear changed ciphertext',
    );
    t.failCommit();
    await assertRejects(
      () => t.domain.deleteAdopted('1'),
      Error,
      'injected commit failure',
    );
    assertEquals(await t.domain.loadAdopted(), [row()]);
    for (const record of records) {
      assert(
        await t.domain.loadCredential('1', record.kind) === record.ciphertext,
        'Failed forget changed ciphertext',
      );
    }
    await t.domain.deleteAdopted('1');
    assertEquals(await t.domain.loadCredential('1', 'password'), null);
    assertEquals(await t.domain.loadCredential('1', 'pairing-key'), null);
    await assertRejects(
      () => t.domain.saveCredential('1', 'password', records[0].ciphertext),
      Error,
      'requires adoption',
    );
  } finally {
    await t.close();
  }
});

Deno.test('late credential encryption cannot resurrect a forgotten or released speaker incarnation', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-secrets-fence-' });
  const store = await openStore(dir);
  const root = canary();
  const held = heldSecrets(root);
  try {
    const t = await composition(store, root, { secrets: held.secrets });
    t.outputs.register(row());
    await t.outputs.adopt('1');
    const old = t.credentials.set('1', 'password', canary());
    const rejected = assertRejects(() => old, Error, 'lifetime has ended');
    await held.ready;
    await t.speakers.forget('1');
    t.outputs.register(row());
    // Do not await adoption until the held per-id credential queue is released.
    const adoption = t.outputs.adopt('1');
    held.release();
    await rejected;
    await adoption;
    assertEquals(await t.credentials.get('1', 'password'), null);
    assertEquals(await store.speakers.loadCredential('1', 'password'), null);
    const current = canary();
    await t.credentials.set('1', 'password', current);
    assert(
      await t.credentials.get('1', 'password') === current,
      'Current incarnation failed',
    );
    // Adoption must capture its incarnation when requested, not after an older
    // persistence write eventually completes and the same id has been reused.
    t.outputs.register(row('3'));
    await t.credentials.set('3', 'password', canary());
    let releaseQueue!: () => void;
    let queueEntered!: () => void;
    const queueReady = new Promise<void>((resolve) => queueEntered = resolve);
    const queueWait = new Promise<void>((resolve) => releaseQueue = resolve);
    const saveQueue = store.playback.saveQueue;
    store.playback.saveQueue = async (...args) => {
      queueEntered();
      await queueWait;
      await saveQueue(...args);
    };
    t.persistence.saveQueue({ items: [], nextId: 1, version: 0 }, {
      state: 'stop',
      currentIndex: null,
      positionMs: 0,
      repeat: 'off',
      shuffle: false,
      consume: false,
    });
    await queueReady;
    const queuedAdoption = t.outputs.adopt('3');
    const stale = assertRejects(
      () => queuedAdoption,
      Error,
      'lifetime has ended',
    );
    t.outputs.unregister('3');
    t.outputs.register(row('3'));
    releaseQueue();
    await stale;
    await t.persistence.drain();
    assert(
      !t.outputs.lifetime('3').adopted,
      'Queued adoption crossed incarnations',
    );
    assertEquals(await store.speakers.loadCredential('3', 'password'), null);
    assertEquals(
      (await store.speakers.loadAdopted()).map((saved) => saved.id),
      ['1'],
    );
  } finally {
    held.release();
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('temporary adoption serializes credential updates and encryption failure preserves temporary state', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-secrets-adopt-' });
  const store = await openStore(dir);
  const root = canary(), before = canary(), after = canary();
  const held = heldSecrets(root);
  try {
    const missing = await composition(store, undefined);
    missing.outputs.register(row());
    await missing.credentials.set('1', 'password', before);
    await secretFailure(() => missing.speakers.adopt('1'), 'secret_missing');
    assertEquals(missing.outputs.lifetime('1').adopted, false);
    assert(
      await missing.credentials.get('1', 'password') === before,
      'Failed adoption lost temporary password',
    );
    assertEquals(await store.speakers.loadAdopted(), []);
    const t = await composition(store, root, { secrets: held.secrets });
    t.outputs.register(row());
    await t.credentials.set('1', 'password', before);
    const adoption = t.speakers.adopt('1');
    await held.ready;
    const update = t.credentials.set('1', 'password', after);
    held.release();
    await adoption;
    await update;
    assertEquals(t.outputs.lifetime('1').adopted, true);
    assert(
      await t.credentials.get('1', 'password') === after,
      'Serialized update was lost',
    );
    const restored = await composition(store, root);
    assert(
      await restored.credentials.get('1', 'password') === after,
      'Update was not durable',
    );
  } finally {
    held.release();
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('speaker credential persistence errors are explicit and never publish an unsaved value', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-secrets-error-' });
  const store = await openStore(dir);
  try {
    const t = await composition(store, canary());
    t.outputs.register(row());
    await t.outputs.adopt('1');
    const original = canary();
    await t.credentials.set('1', 'password', original);
    const save = store.speakers.saveCredential;
    store.speakers.saveCredential = () => Promise.reject(new Error(canary()));
    const error = await assertRejects(
      () => t.credentials.set('1', 'password', canary()),
      Error,
    );
    assertEquals(
      error.message,
      'Speaker credential could not be saved or loaded',
    );
    store.speakers.saveCredential = save;
    assert(
      await t.credentials.get('1', 'password') === original,
      'Failed save replaced credential',
    );
    await store.close();
    await assertRejects(
      () => t.credentials.get('1', 'password'),
      Error,
      'could not be saved or loaded',
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('HTTP speaker reads and logs never expose credentials and HTTP forget removes both durable kinds', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-secrets-http-' });
  const root = canary(), password = canary(), pairing = canary();
  const previousLogger = appLogger();
  const capture = captureLogs();
  installLogger(capture.log);
  let t!: Awaited<ReturnType<typeof composition>>;
  const start = () =>
    apiFixture({
      storeDir: dir,
      traceRequests: true,
      hats: {
        layersRoot: 'layers',
        extraPorts: 1,
        env: ([port]) => ({ MELOFON_LISTEN_owntone: `${port},${port}` }),
      },
      services: async (f) => {
        t = await composition(f.store, root, { notify: f.notify });
        return { outputs: t.outputs, speakers: t.speakers };
      },
    });
  let f: Awaited<ReturnType<typeof start>> | undefined;
  try {
    f = await start();
    const { credential } = await f.login('cookie');
    t.outputs.register(row());
    await t.credentials.set('1', 'password', password);
    await t.credentials.set('1', 'pairing-key', pairing);
    const adoption = await f.json(
      '/api/v1/speakers/1/adopt',
      'POST',
      {},
      credential,
    );
    assertEquals(adoption.status, 200);
    const visible: string[] = [await adoption.text()];
    await t.persistence.drain();
    await f.close();
    f = await start();
    assert(
      await t.credentials.get('1', 'password') === password,
      'HTTP adoption password did not reopen',
    );
    assert(
      await t.credentials.get('1', 'pairing-key') === pairing,
      'HTTP adoption key did not reopen',
    );
    const login = await f.login('bearer');
    for (const path of ['/api/v1/speakers', '/api/v1/speakers/1']) {
      const response = await f.get(path, login.credential);
      assertEquals(response.status, 200);
      visible.push(await response.text());
    }
    const own = await fetch(
      `http://melofon.home:${f.extraPorts[0]}/api/outputs`,
      { signal: AbortSignal.timeout(5000) },
    );
    assertEquals(own.status, 200);
    visible.push(await own.text());
    visible.push(JSON.stringify(f.notifications));
    // Exercise supported central error/dependency paths after automatic registration.
    capture.log.event('fixture_error', {
      payload: new Error([root, password, pairing].join(' ')),
    });
    await capture.log.flush();
    visible.push(
      capture.lines.join('\n'),
      capture.log.text(),
      JSON.stringify(capture.log.records({ limit: 1000 })),
    );
    for (const value of [root, password, pairing]) {
      assert(
        visible.every((text) => !text.includes(value)),
        'Credential escaped public/log boundary',
      );
    }
    const forgotten = await f.json(
      '/api/v1/speakers/1',
      'DELETE',
      undefined,
      login.credential,
    );
    assertEquals(forgotten.status, 204);
    await forgotten.body?.cancel();
    await t.persistence.drain();
    await f.close();
    f = await start();
    assertEquals(await f.store.speakers.loadAdopted(), []);
    assertEquals(await f.store.speakers.loadCredential('1', 'password'), null);
    assertEquals(
      await f.store.speakers.loadCredential('1', 'pairing-key'),
      null,
    );
  } finally {
    await f?.close();
    installLogger(previousLogger);
    await Deno.remove(dir, { recursive: true });
  }
});
