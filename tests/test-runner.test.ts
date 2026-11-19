import { assertEquals } from '@std/assert';
import {
  parseSummary,
  selectFiles,
  shardFiles,
} from '../scripts/test-runner.ts';

Deno.test('test runner: shards are stable, disjoint and exhaustive', () => {
  const files = ['tests/c.ts', 'tests/a.ts', 'tests/b.ts'];
  assertEquals(shardFiles(files, 2), [['tests/a.ts', 'tests/c.ts'], [
    'tests/b.ts',
  ]]);
  assertEquals(shardFiles([], 4), [[], [], [], []]);
});

Deno.test('test runner: selection is conservative for shared changes', () => {
  const files = ['tests/a.ts', 'tests/b.ts'];
  assertEquals(selectFiles(files), files);
  assertEquals(selectFiles(files, ['tests/a.ts', 'tests/deleted.ts']), [
    'tests/a.ts',
  ]);
  assertEquals(selectFiles(files, ['README.md']), []);
  for (
    const path of [
      'src/a.ts',
      'deno.lock',
      'helper/raop/ffi.c',
      'tests/helpers/a.ts',
      'tests/fixtures/a.md',
    ]
  ) {
    assertEquals(selectFiles(files, [path]), files);
  }
});

Deno.test('test runner: only the final summary counts, crashes lack a summary', () => {
  assertEquals(
    parseSummary(
      'ok | 9 passed | 0 failed\nFAILED | 3 passed (2 steps) | 1 failed | 2 ignored (1s)\n',
    ),
    { passed: 3, failed: 1, ignored: 2 },
  );
  assertEquals(parseSummary('ok | 1 passed | 0 failed (1s)\n'), {
    passed: 1,
    failed: 0,
    ignored: 0,
  });
  assertEquals(parseSummary('error: process crashed'), undefined);
});
