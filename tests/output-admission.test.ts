import { assert, assertEquals, assertThrows } from '@std/assert';
import {
  createOutputAdmission,
  type OutputAdapter,
  type OutputEndpoint,
  PreparationError,
} from '../src/output-admission.ts';

function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => resolve = r);
  return { promise, resolve };
}

function setup(protocol = 'test-url') {
  let endpoint: OutputEndpoint | null = {
    id: '1',
    protocol,
    address: '127.0.0.1',
    port: 9000,
  };
  let now = 100;
  let current = true;
  let requests = 0, creates = 0, starts = 0, closes = 0;
  const signals: AbortSignal[] = [];
  const queue: Promise<
    { config: { url: string }; source: string; expiresAt: number }
  >[] = [];
  const controller = new AbortController();
  const admission = createOutputAdmission({
    endpoint: () => endpoint,
    now: () => now,
  });
  const observation = () => ({
    config: { url: 'http://127.0.0.1/media' },
    source: 'test',
    expiresAt: 1000,
  });
  const adapter: OutputAdapter<
    { url: string },
    { volume: number },
    { alive: boolean },
    string
  > = {
    prepare(_endpoint, signal) {
      requests++;
      signals.push(signal);
      return queue.shift() ?? Promise.resolve(observation());
    },
    validate(config) {
      if (!config.url.startsWith('http://')) {
        throw new PreparationError('invalid', 'invalid URL');
      }
    },
    create() {
      creates++;
      return { alive: true };
    },
    start() {
      starts++;
      return Promise.resolve();
    },
    close(transport) {
      closes++;
      transport.alive = false;
      return Promise.resolve();
    },
  };
  const handle = admission.register(protocol, adapter);
  const request = (signal = controller.signal) => ({
    id: '1',
    targetRevision: admission.describe('1').targetRevision,
    signal,
    isCurrent: () => current,
  });
  const prepare = () => handle.prepare(request());
  return {
    admission,
    handle,
    adapter,
    observation,
    request,
    prepare,
    queue,
    signals,
    controller,
    counts: () => ({ requests, creates, starts, closes }),
    setCurrent: (v: boolean) => current = v,
    setNow: (v: number) => now = v,
    setEndpoint: (v: OutputEndpoint | null) => endpoint = v,
  };
}

for (const protocol of ['test-raop', 'test-url']) {
  Deno.test(`admission ${protocol}: preparation, single-use activation and cached observations`, async () => {
    const s = setup(protocol);
    assertEquals(s.admission.describe('1').state, 'unresolved');
    const prepared = await s.prepare();
    assert(prepared.ok);
    assertEquals(s.counts().creates, 0);
    assertEquals(s.admission.describe('1').state, 'ready');
    let published = false;
    s.adapter.start = (_t, config) => {
      assert(published);
      assertEquals(config.url, 'http://127.0.0.1/media');
      return Promise.resolve();
    };
    const active = await s.handle.activate(prepared.value, { volume: 50 }, {
      publish: () => published = true,
      onEvent() {},
    });
    assert(active.ok);
    assert(
      !(await s.handle.activate(prepared.value, { volume: 50 }, {
        publish() {},
        onEvent() {},
      })).ok,
    );
    assert((await s.prepare()).ok);
    assertEquals(s.counts().requests, 1);
    assertEquals(s.counts().creates, 1);
    await s.adapter.close(active.value);
  });

  Deno.test(`admission ${protocol}: missing capabilities cannot construct/start a transport`, async () => {
    const s = setup(protocol);
    s.adapter.prepare = () =>
      Promise.reject(new PreparationError('timeout', 'no receiver facts'));
    const result = await s.prepare();
    assert(!result.ok);
    assertEquals(result.error.code, 'timeout');
    assertEquals(s.admission.describe('1').state, 'failed');
    assertEquals(s.counts().creates, 0);
    assertEquals(s.counts().starts, 0);
  });
}

Deno.test('admission: endpoint revision invalidates late and already prepared results', async () => {
  const s = setup();
  const delayed = gate<ReturnType<typeof s.observation>>();
  s.queue.push(delayed.promise);
  const result = s.prepare();
  s.setEndpoint({ id: '1', protocol: 'test-url', address: '127.0.0.2' });
  s.admission.describe('1');
  assert(s.signals[0].aborted);
  delayed.resolve(s.observation());
  assert(!(await result).ok);
  const prepared = await s.prepare();
  assert(prepared.ok);
  s.admission.invalidate('1');
  assert(
    !(await s.handle.activate(prepared.value, { volume: 1 }, {
      publish() {},
      onEvent() {},
    })).ok,
  );
  assertEquals(s.counts().creates, 0);
});

Deno.test('admission: independent same-target attempts and cancellation', async () => {
  const s = setup();
  const a = gate<ReturnType<typeof s.observation>>(),
    b = gate<ReturnType<typeof s.observation>>();
  s.queue.push(a.promise, b.promise);
  const ca = new AbortController(), cb = new AbortController();
  const pa = s.handle.prepare(s.request(ca.signal));
  const pb = s.handle.prepare(s.request(cb.signal));
  ca.abort();
  assert(s.signals[0].aborted);
  assert(!s.signals[1].aborted);
  a.resolve(s.observation());
  b.resolve(s.observation());
  assert(!(await pa).ok);
  assert((await pb).ok);
  assertEquals(s.admission.describe('1').state, 'ready');
});

Deno.test('admission: current intent, expiry, closure and unknown protocol prevent activation', async () => {
  const s = setup();
  const prepared = await s.prepare();
  assert(prepared.ok);
  s.setCurrent(false);
  assert(
    !(await s.handle.activate(prepared.value, { volume: 1 }, {
      publish() {},
      onEvent() {},
    })).ok,
  );
  s.setCurrent(true);
  const expired = await s.prepare();
  assert(expired.ok);
  s.setNow(1001);
  assertEquals(s.admission.describe('1').state, 'unresolved');
  assert(
    !(await s.handle.activate(expired.value, { volume: 1 }, {
      publish() {},
      onEvent() {},
    })).ok,
  );
  s.admission.close();
  assert(!(await s.prepare()).ok);
  assertEquals(s.counts().creates, 0);
  assertThrows(() => s.admission.register('test-url', s.adapter));
});

Deno.test('admission: reentrant publication cancels start and releases constructed transport', async () => {
  const s = setup();
  const prepared = await s.prepare();
  assert(prepared.ok);
  const result = await s.handle.activate(prepared.value, { volume: 1 }, {
    publish: () => s.controller.abort(),
    onEvent() {},
  });
  assert(!result.ok);
  assertEquals(s.counts().starts, 0);
  assertEquals(s.counts().closes, 1);
});

Deno.test('admission: foreign permits, mutation and constructor events cannot bypass ownership', async () => {
  const s = setup(), other = setup();
  const observation = s.observation();
  s.handle.observe('1', observation);
  observation.config.url = 'wrong';
  const prepared = await s.prepare();
  assert(prepared.ok);
  assert(
    !(await other.handle.activate(prepared.value, { volume: 1 }, {
      publish() {},
      onEvent() {},
    })).ok,
  );
  let published = false;
  const events: string[] = [];
  s.adapter.create = (event) => {
    event('constructed');
    return { alive: true };
  };
  s.adapter.start = (_t, config) => {
    assertEquals(config.url, 'http://127.0.0.1/media');
    return Promise.resolve();
  };
  const active = await s.handle.activate(prepared.value, { volume: 1 }, {
    publish: () => published = true,
    onEvent(event) {
      assert(published);
      events.push(event);
    },
  });
  assert(active.ok);
  assertEquals(events, ['constructed']);
});

Deno.test('admission: superseded/unsupported facts invalidate permits, identical refreshes do not', async () => {
  const s = setup();
  const first = await s.prepare();
  assert(first.ok);
  s.handle.observe('1', s.observation());
  const initial = await s.handle.activate(first.value, { volume: 1 }, {
    publish() {},
    onEvent() {},
  });
  assert(initial.ok);
  await s.adapter.close(initial.value);
  const changed = await s.prepare();
  assert(changed.ok);
  s.handle.observe('1', {
    ...s.observation(),
    config: { url: 'http://127.0.0.1/new' },
  });
  assert(
    !(await s.handle.activate(changed.value, { volume: 1 }, {
      publish() {},
      onEvent() {},
    })).ok,
  );
  const unsupported = await s.prepare();
  assert(unsupported.ok);
  s.handle.fail(
    '1',
    new PreparationError('unsupported', 'new unsupported facts'),
  );
  assert(
    !(await s.handle.activate(unsupported.value, { volume: 1 }, {
      publish() {},
      onEvent() {},
    })).ok,
  );
});
