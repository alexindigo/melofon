import { assertEquals } from '@std/assert';

Deno.test('production shutdown joins the scan before closing its store', async () => {
  const child = await new Deno.Command(Deno.execPath(), {
    args: [
      'test',
      '--frozen',
      '--cached-only',
      '--node-modules-dir=manual',
      '--allow-all',
      'tests/fixtures/shutdown-scan-consumer.ts',
    ],
    stdout: 'piped',
    stderr: 'piped',
    signal: AbortSignal.timeout(120_000),
  }).output();
  assertEquals(
    child.code,
    0,
    new TextDecoder().decode(child.stdout) +
      new TextDecoder().decode(child.stderr),
  );
});
