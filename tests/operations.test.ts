import { assert, assertEquals, assertRejects } from '@std/assert';
import { createOperationScope, type Operation } from '../src/operations.ts';

Deno.test('operation scope admits synchronously, cancels every identity and joins cleanup', async () => {
  const scope = createOperationScope('Owner');
  const release = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const seen: Operation[] = [];
  let cleaned = 0;
  const start = () =>
    scope.run(async (operation) => {
      seen.push(operation);
      if (seen.length === 2) entered.resolve();
      try {
        await release.promise;
        operation.signal.throwIfAborted();
      } finally {
        cleaned++;
      }
    });
  const a = start(), b = start();
  assertEquals(
    seen.length,
    2,
    'scope admission must not reschedule owner intake',
  );
  const results = Promise.allSettled([a, b]);
  await entered.promise;
  assert(seen[0].id !== seen[1].id);
  const closing = scope.close();
  assertEquals(scope.close(), closing);
  assert(seen.every((operation) => operation.signal.aborted));
  let settled = false;
  void closing.then(() => settled = true);
  await assertRejects(() => scope.run(() => 1), Error, 'Owner is closed');
  assertEquals(settled, false);
  release.resolve();
  await closing;
  await Promise.all(seen.map((operation) => operation.settled));
  assertEquals(cleaned, 2);
  assertEquals((await results).map((result) => result.status), [
    'rejected',
    'rejected',
  ]);
});

Deno.test('operation scope close owns work before its first microtask and survives failure', async () => {
  const scope = createOperationScope('Owner');
  const error = new Error('work failed');
  let ran = false;
  const work = scope.run(async ({ signal }) => {
    assertEquals(signal.aborted, false);
    await Promise.resolve();
    assert(signal.aborted);
    ran = true;
    throw error;
  });
  const failure = assertRejects(() => work);
  const closing = scope.close();
  await closing;
  assertEquals(await failure, error);
  assertEquals(ran, true);
  assertEquals(scope.close(), closing);
});

Deno.test('operation scope installs close receipt before abort listener reentry', async () => {
  const scope = createOperationScope('Owner');
  const entered = Promise.withResolvers<void>();
  let reentered: Promise<void> | undefined;
  const work = scope.run(({ signal }) =>
    new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => {
        reentered = scope.close();
        resolve();
      }, { once: true });
      entered.resolve();
    })
  );
  await entered.promise;
  const closing = scope.close();
  assertEquals(reentered, closing);
  await closing;
  await work;
});
