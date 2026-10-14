// tests/native-changes.test.ts — the native-test gate decision over a
// git-status result (tests/helpers/native-changes.ts), with literal inputs.
import { assertEquals } from '@std/assert';
import { nativeChanged } from './helpers/native-changes.ts';

Deno.test('native gate: git succeeds with empty output → skip native tests', () => {
  assertEquals(nativeChanged({ ok: true, stdout: '' }), false);
});

Deno.test('native gate: git reports a helper/raop change → run native tests', () => {
  assertEquals(
    nativeChanged({ ok: true, stdout: ' M helper/raop/player.c\n' }),
    true,
  );
});

Deno.test('native gate: git reports only another path → skip native tests', () => {
  assertEquals(
    nativeChanged({ ok: true, stdout: ' M src/player.ts\n' }),
    false,
  );
});

Deno.test('native gate: git fails → run native tests', () => {
  assertEquals(nativeChanged({ ok: false, stdout: '' }), true);
});
