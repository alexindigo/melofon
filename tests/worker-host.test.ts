import { assertEquals, assertRejects } from '@std/assert';
import { createWorkerSession, type WorkerCall } from '../src/worker-host.ts';

function fixture() {
  let terminations = 0;
  const worker = {
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    terminate() {
      terminations++;
    },
  };
  const session = createWorkerSession(worker as unknown as Worker, {
    invalidMessage: 'invalid message',
    onMessage() {},
  });
  return { session, terminations: () => terminations };
}

Deno.test('Worker session retirement rejects readiness once and never reopens', async () => {
  const f = fixture();
  const error = new Error('retired during startup');
  let rejected = 0;
  const pending = f.session.ready.catch((reason) => {
    assertEquals(reason, error);
    rejected++;
  });
  f.session.retire(error);
  f.session.markReady();
  f.session.retire(new Error('again'));
  await pending;
  assertEquals(rejected, 1);
  assertEquals(f.terminations(), 1);
  await assertRejects(() => f.session.request(() => {}), Error, 'retired');
});

Deno.test('Worker call identities fence stale settlement and retire the active call exactly once', async () => {
  const f = fixture();
  f.session.markReady();
  let first!: WorkerCall;
  const one = f.session.request<string>((call) => {
    first = call;
  });
  first.resolve('first');
  assertEquals(await one, 'first');
  let second!: WorkerCall;
  const two = f.session.request<string>((call) => {
    second = call;
  });
  const rejected = assertRejects(() => two, Error, 'retired');
  first.reject(new Error('stale failure'));
  first.resolve('stale result');
  assertEquals(f.session.call, second);
  f.session.retire(new Error('retired'));
  second.resolve('late result');
  second.reject(new Error('late error'));
  await rejected;
  assertEquals(f.session.call, undefined);
  assertEquals(f.terminations(), 1);
});

Deno.test('Worker call timeout and failed sends use the same retirement path', async () => {
  for (const timeout of [false, true]) {
    const f = fixture();
    f.session.markReady();
    const pending = f.session.request(() => {
      if (!timeout) throw new Error('send failed');
    }, { milliseconds: 1, error: new Error('call timed out') });
    await assertRejects(
      () => pending,
      Error,
      timeout ? 'timed out' : 'send failed',
    );
    assertEquals(f.terminations(), 1);
    f.session.retire(new Error('close'));
    assertEquals(f.terminations(), 1);
  }
});
