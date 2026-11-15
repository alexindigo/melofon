import { assertEquals, assertRejects } from '@std/assert';
import { createReleaseSet, releaseOrThrow } from '../src/releases.ts';
import { configureLogging } from '../src/logging.ts';

Deno.test('logging initialization releases its subscription when the initial setting read fails', async () => {
  let subscribed = 0;
  await assertRejects(
    () =>
      configureLogging({
        declare() {},
        onChange() {
          subscribed++;
          return () => subscribed--;
        },
        getTyped: () => Promise.reject(new Error('setting read failed')),
      }),
    Error,
    'setting read failed',
  );
  assertEquals(subscribed, 0);
});

Deno.test('release phases await every sibling and preserve failure ownership', async () => {
  const releases = createReleaseSet();
  const events: string[] = [];
  let finish!: () => void;
  const held = new Promise<void>((resolve) => finish = resolve);
  releases.add('failed', () => {
    events.push('failed');
    throw new Error('refused');
  });
  releases.add('held', async () => {
    await held;
    events.push('held');
  });
  releases.add('store', () => {
    events.push('store');
  }, 1);
  const work = releases.release();
  await Promise.resolve();
  await Promise.resolve();
  assertEquals(events, ['failed']);
  finish();
  const report = await work;
  assertEquals(events, ['failed', 'held', 'store']);
  assertEquals(report.released, ['held', 'store']);
  assertEquals(report.failed.map((failure) => failure.name), ['failed']);
  assertEquals(releases.pending(), ['failed']);
});

Deno.test('concurrent release attempts share child settlement; explicit retry owns failures', async () => {
  const releases = createReleaseSet();
  let calls = 0;
  let finish!: () => void;
  releases.add('child', () => {
    calls++;
    return new Promise<void>((resolve) => finish = resolve);
  });
  const a = releases.release();
  const b = releases.release();
  await Promise.resolve();
  assertEquals(calls, 1);
  finish();
  await Promise.all([a, b]);
  assertEquals(releases.pending(), []);
  let refuse = true;
  releases.add('retryable', () => {
    if (refuse) throw new Error('still held');
  });
  const original = new Error('acquisition failed');
  const failure = await assertRejects(
    () => releaseOrThrow(releases, 'rollback', { error: original }),
    AggregateError,
  );
  assertEquals(failure.errors[0], original);
  assertEquals(failure.errors[1].message, 'Release failed: retryable');
  refuse = false;
  await releaseOrThrow(releases, 'retry');
  assertEquals(releases.pending(), []);
});
