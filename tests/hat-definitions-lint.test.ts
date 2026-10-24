import { assertEquals, assertStringIncludes } from '@std/assert';
import plugin from '../lint/hat-definitions.ts';

// Deno's test-only API: cli/tsc/dts/lib.deno.unstable.d.ts:1707-1718;
// cli/js/40_lint.js:1604-1638. Upstream example:
// ~/Sources/denoland-deno/tests/unit/lint_plugin_test.ts:10-26.
const allowed = [
  `import value from './other.ts'; import type { T } from './types.ts';`,
  `export { value } from './other.ts'; export * from './other.ts';`,
  `const value = 1; export { value };`,
  `type T = string; export interface I { value: T }`,
  `declare let external: string; declare class External {}`,
  `declare namespace External { function run(): void }`,
  `function run() { let state = new Map(); return state; }`,
  `export default function () { return fetch('/later'); }`,
  `export default async () => await fetch('/later');`,
  `const run = function () { return new WeakMap(); };`,
  `const run = async () => { await fetch('/later'); };`,
  `const text = 'a', number = -1, yes = true, no = false, nil = null;`,
  'const text = `no interpolation`;',
  `const pattern = /a+/gi; const n = 1n; const positive = +2;`,
  `const data = [1, { key: ['x', false, null, /a/] }, , -2];`,
  `const data = { key: 1, 'other': true, 2: null, ['literal']: 'x' };`,
  `const data = new Set(['one', 'two']);`,
  `const data = new Map([['one', { value: 1 }]]);`,
  `const data = Object.freeze({ values: [new Set([1]), new Map([['a', 2]])] });`,
  `const data = Object.freeze(Object.freeze([1, { a: null }]));`,
  `const data = ['a', 'b'] as const;`,
  `const data = { a: 1 } satisfies Record<string, number>;`,
  `const data = <number[]>[1, 2];`,
  `export const disableStreaming = true, bodyLimit = 1024, auth = 'admin';`,
];
const rejected = [
  `const state = new WeakMap();`,
  `const state = new Date();`,
  `const result = fetch('/now');`,
  `const result = await fetch('/now');`,
  `await fetch('/now');`,
  `let value = 1;`,
  `var value = 1;`,
  `class State { static value = fetch('/now'); }`,
  `class State { static { fetch('/now'); } }`,
  `class State {}`,
  `export default class State {}`,
  `fetch('/now');`,
  `if (true) fetch('/now');`,
  `for (const x of [1]) fetch('/now');`,
  `while (false) fetch('/now');`,
  `try { fetch('/now'); } catch {}`,
  `{ const value = fetch('/now'); }`,
  `const value = Number.MAX_SAFE_INTEGER;`,
  `const value = Number['MAX_SAFE_INTEGER'];`,
  `const value = { nested: Number.MAX_SAFE_INTEGER };`,
  `const value = { nested: fetch('/now') };`,
  `const value = [new WeakMap()];`,
  `const value = defaultValue;`,
  'const value = `with ${expression}`;',
  `const value = (() => fetch('/now'))();`,
  `const value = Object.assign({}, {});`,
  `const value = Object.freeze(fetch('/now'));`,
  `const value = Object.freeze({ get x() { return 1; } });`,
  `const value = { [fetch('/now')]: 1 };`,
  `const value = { get x() { return 1; } };`,
  `const value = { run: () => 1 };`,
  `const value = { other };`,
  `const value = { ...other };`,
  `const value = [...other];`,
  `const value = new Set(other);`,
  `const value = new Map([[fetch('/now'), 1]]);`,
  `const value = new Set(['x'], fetch('/now'));`,
  `const value = Object.freeze({}, fetch('/now'));`,
  `const { value = fetch('/now') } = {};`,
  `const [value] = [1];`,
  `const value = class { static x = fetch('/now'); };`,
  `namespace Runtime { export const x = fetch('/now'); }`,
  `enum Runtime { X = fetch('/now') }`,
  `const value = import('./other.ts');`,
  `const value = (fetch('/now'), 1);`,
  `export default fetch('/now');`,
  `const value = 1 + 2;`,
  `const value = Object.freeze({ x: 1 } as const) as const; fetch('/now');`,
];

Deno.test('hat definitions lint: all allowed definitions and literal data forms', () => {
  for (const source of allowed) {
    assertEquals(
      Deno.lint.runPlugin(plugin, 'layers/example/get.ts', source),
      [],
      source,
    );
  }
});

Deno.test('hat definitions lint: rejects top-level runtime work including nested escapes', () => {
  for (const source of rejected) {
    const findings = Deno.lint.runPlugin(
      plugin,
      'layers/example/get.ts',
      source,
    );
    assertEquals(findings.length, 1, source);
    assertEquals(findings[0].id, 'melofon/hat-definitions', source);
    assertStringIncludes(findings[0].message, 'definitions only');
  }
});

Deno.test('hat definitions lint: file scope and diagnostic source range', () => {
  for (
    const file of [
      'src/service.ts',
      'lookups/example/index.ts',
      'tests/layers.test.ts',
      'layers-other/get.ts',
    ]
  ) {
    assertEquals(Deno.lint.runPlugin(plugin, file, `fetch('/now');`), []);
  }
  const source =
    `// leading line\nexport const value = Number.MAX_SAFE_INTEGER;`;
  for (
    const file of [
      'layers/example/get.ts',
      '/project/layers/example/get.ts',
      'C:\\project\\layers\\example\\get.ts',
    ]
  ) {
    const [finding] = Deno.lint.runPlugin(plugin, file, source);
    assertEquals(
      source.slice(...finding.range),
      'export const value = Number.MAX_SAFE_INTEGER;',
    );
    assertEquals(source.slice(0, finding.range[0]).split('\n').length, 2);
  }
});
