import { assertEquals } from '@std/assert';

Deno.test('production shutdown releases native logging, report expiry and the store after player close fails', async () => {
  const child = await new Deno.Command(Deno.execPath(), {
    args: [
      'test',
      '--frozen',
      '--cached-only',
      '--node-modules-dir=manual',
      '--allow-net',
      '--allow-env',
      '--allow-read',
      '--allow-write',
      '--allow-ffi',
      '--allow-sys',
      '--allow-run',
      'tests/fixtures/shutdown-consumer.ts',
    ],
    stdout: 'piped',
    stderr: 'piped',
    signal: AbortSignal.timeout(30_000),
  }).output();
  assertEquals(
    child.code,
    0,
    new TextDecoder().decode(child.stdout) +
      new TextDecoder().decode(child.stderr),
  );
});
