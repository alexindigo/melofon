import { assert, assertEquals } from '@std/assert';
import { acquireHeartbeat } from '../src/heartbeat.ts';
import { observeHeartbeat } from './helpers/heartbeat.ts';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

Deno.test('heartbeat shares one unref timer and releases each lease exactly once', () => {
  using observed = observeHeartbeat();
  const first = acquireHeartbeat();
  const second = acquireHeartbeat();
  observed.assertActive();
  assertEquals(observed.timers.size, 1);
  first[Symbol.dispose]();
  first[Symbol.dispose]();
  observed.assertActive();
  second[Symbol.dispose]();
  assertEquals(observed.active.size, 0);
  using _next = acquireHeartbeat();
  observed.assertActive();
  assertEquals(observed.timers.size, 2);
  // Releasing a retired lease must not stop a later generation's timer.
  first[Symbol.dispose]();
  observed.assertActive();
});

Deno.test('heartbeat ticks the real loop and stops after its final owner releases', async () => {
  using observed = observeHeartbeat();
  const owner = acquireHeartbeat();
  try {
    await sleep(180);
    observed.assertActive();
    const timer = [...observed.timers.values()][0];
    assert(timer.ticks >= 2);
    owner[Symbol.dispose]();
    const stopped = timer.ticks;
    await sleep(120);
    assertEquals(timer.ticks, stopped);
    assertEquals(observed.active.size, 0);
  } finally {
    owner[Symbol.dispose]();
  }
});

async function exits(code: string) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 20_000);
  try {
    const output = await new Deno.Command(Deno.execPath(), {
      args: [
        'eval',
        '--frozen',
        '--cached-only',
        '--node-modules-dir=manual',
        code,
      ],
      cwd: new URL('../', import.meta.url),
      signal: abort.signal,
      stdout: 'piped',
      stderr: 'piped',
    }).output();
    assertEquals(output.code, 0, new TextDecoder().decode(output.stderr));
    assertEquals(new TextDecoder().decode(output.stdout).trim(), 'clean exit');
  } finally {
    clearTimeout(timer);
  }
}

Deno.test('an acquired heartbeat alone never keeps a standalone process alive', async () => {
  await exits(`
    import { acquireHeartbeat } from './src/heartbeat.ts';
    acquireHeartbeat();
    console.log('clean exit');
  `);
});

Deno.test('a standalone store drains its last save, stops the heartbeat and exits naturally', async () => {
  await exits(`
    import { assertEquals } from '@std/assert';
    import { openStore } from './src/store/index.ts';
    import { observeHeartbeat } from './tests/helpers/heartbeat.ts';
    using observed = observeHeartbeat();
    const dir = await Deno.makeTempDir({ prefix: 'heartbeat-exit-' });
    try {
      const store = await openStore(dir);
      observed.assertActive();
      const saving = store.state.set('final', 'saved');
      const closing = store.close();
      observed.assertActive();
      await Promise.all([saving, closing]);
      assertEquals(observed.active.size, 0);
      const reopened = await openStore(dir);
      try {
        assertEquals(await reopened.state.get('final'), 'saved');
      } finally {
        await reopened.close();
      }
      assertEquals(observed.active.size, 0);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
    console.log('clean exit');
  `);
});
