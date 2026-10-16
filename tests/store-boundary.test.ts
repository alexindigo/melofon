import { assert, assertEquals } from '@std/assert';

function boundary(path: string): Deno.lint.Plugin {
  const inStore = path.startsWith('src/store/');
  const inTests = path.startsWith('tests/');
  return {
    name: 'melofon-store',
    rules: {
      boundary: {
        create(ctx) {
          const report = (node: Deno.lint.Node, message: string) =>
            ctx.report({ node, message: `${path}: ${message}` });
          const text = (node: Deno.lint.Node, value: string) => {
            if (inTests) return;
            if (
              value.includes('@duckdb/node-api') &&
              path !== 'src/store/engine.ts'
            ) report(node, 'only the store engine may import DuckDB');
            const target = value.startsWith('.')
              ? new URL(value, new URL(path, 'file:///')).pathname
              : value;
            if (
              !inStore && /(?:^|\/)store\/engine\.ts(?:[?#]|$)/.test(target)
            ) {
              report(node, 'store engine is private');
            }
            if (/(?:^|\/)store\/testing\.ts(?:[?#]|$)/.test(target)) {
              report(node, 'store testing seam is test-only');
            }
            if (!inStore && value.includes('schema.sql')) {
              report(node, 'schema belongs to the store');
            }
            if (/(?:^|\/)src\/db\.ts(?:[?#]|$)/.test(target)) {
              report(node, 'transitional db module is removed');
            }
          };
          return {
            Literal(node) {
              if (typeof node.value === 'string') text(node, node.value);
            },
            TemplateLiteral(node) {
              text(node, ctx.sourceCode.getText(node));
            },
            MemberExpression(node) {
              if (inStore || inTests) return;
              const key = !node.computed && node.property.type === 'Identifier'
                ? node.property.name
                : node.property.type === 'Literal'
                ? node.property.value
                : undefined;
              if (key === 'conn') {
                report(node, 'connection access belongs to the store');
              }
            },
          };
        },
      },
    },
  };
}

function violations(path: string, source: string) {
  return Deno.lint.runPlugin(boundary(path), path, source);
}

async function sourceFiles(root: string): Promise<string[]> {
  const paths: string[] = [];
  for await (const entry of Deno.readDir(root)) {
    const path = `${root}/${entry.name}`;
    if (entry.isDirectory) paths.push(...await sourceFiles(path));
    else if (entry.isFile && /\.(?:[cm]?[jt]s|[jt]sx)$/.test(path)) {
      paths.push(path);
    }
  }
  return paths;
}

Deno.test('store boundary detects imports, reexports, dynamic and computed connection access by path', () => {
  for (
    const source of [
      'import * as db from "@duckdb/node-api";',
      'export { DuckDBInstance } from "npm:@duckdb/node-api";',
      'const db = await import("./store/engine.ts");',
      'import type { Engine } from "../src/store/engine.ts";',
      'export * from "./store/./engine.ts";',
      'export * from "./store/testing.ts";',
      'const t = require("./store/testing.ts");',
      'const q = db.conn;',
      'db.conn.run("SELECT 1");',
      'db["conn"].run("SELECT 1");',
      'const schema = new URL("./schema.sql", import.meta.url);',
      'import type { Db } from "../src/db.ts";',
    ]
  ) {
    const found = violations('src/forbidden.ts', source);
    assert(found.length > 0, source);
    assert(found.every((r) => r.message.includes('src/forbidden.ts')));
  }
});

Deno.test('store boundary permits semantic consumers, store internals and test-only raw imports', () => {
  for (
    const [path, source] of [
      [
        'src/service.ts',
        'import type { Store } from "./store/index.ts"; store.state.get("key");',
      ],
      ['src/store/state.ts', 'import type { Engine } from "./engine.ts";'],
      [
        'src/store/engine.ts',
        'import * as db from "@duckdb/node-api"; const s = "schema.sql";',
      ],
      [
        'tests/example.test.ts',
        'import { rawSql } from "../src/store/testing.ts";',
      ],
      [
        'tests/fixtures/consumer.ts',
        'const {rawSql} = await import("../../src/store/testing.ts");',
      ],
    ]
  ) assertEquals(violations(path, source), [], path);
});

Deno.test('all production and test sources keep the store boundary closed', async () => {
  const paths = [
    'main.ts',
    ...await sourceFiles('src'),
    ...await sourceFiles('core'),
    ...await sourceFiles('layers'),
    ...await sourceFiles('tests'),
  ];
  const found: string[] = [];
  for (const path of paths) {
    for (const result of violations(path, await Deno.readTextFile(path))) {
      found.push(`${path}:${result.range[0]} ${result.message}`);
    }
  }
  if (
    await Deno.stat('src/db.ts').then(() => true, (error) => {
      if (error instanceof Deno.errors.NotFound) return false;
      throw error;
    })
  ) found.push('src/db.ts: transitional db module must not exist');
  assertEquals(found, []);
});
