// The presentation/output boundary is enforced against owned production syntax.
import { assert, assertEquals } from '@std/assert';

const OWNERS = new Set(['src/logging.ts', 'src/logging-dependencies.ts']);
export const loggingBoundary: Deno.lint.Plugin = {
  name: 'melofon-logging',
  rules: {
    boundary: {
      create(ctx) {
        const report = (node: Deno.lint.Node) =>
          ctx.report({
            node,
            message: 'Submit raw events through the shared logger',
          });
        const globals = new Set([
          'globalThis',
          'window',
          'self',
          'Deno',
          'process',
        ]);
        return {
          Identifier(node) {
            if (node.name === 'console') report(node);
            if (globals.has(node.name)) {
              const parent = ctx.sourceCode.getAncestors(node).at(-1);
              if (
                parent?.type !== 'MemberExpression' &&
                parent?.type !== 'TSQualifiedName'
              ) report(node);
            }
          },
          MemberExpression(node) {
            const key = !node.computed && node.property.type === 'Identifier'
              ? node.property.name
              : node.property.type === 'Literal'
              ? node.property.value
              : undefined;
            if (
              node.object.type === 'Identifier' && globals.has(node.object.name)
            ) {
              if (node.computed && typeof key !== 'string') report(node);
              else if (['console', 'stdout', 'stderr'].includes(String(key))) {
                report(node);
              }
            }
          },
          VariableDeclarator(node) {
            if (
              node.init?.type === 'Identifier' && globals.has(node.init.name)
            ) report(node);
          },
          TemplateLiteral(node) {
            // Owned historical producer prefixes cannot be recreated outside the registry.
            if (
              /\[(?:http |cmd\]|db\]|melofon\])/.test(
                ctx.sourceCode.getText(node),
              )
            ) report(node);
          },
          ImportDeclaration(node) {
            if (
              ['node:console', 'node:process'].includes(
                String(node.source.value),
              )
            ) report(node);
            if (['node:fs', 'fs'].includes(String(node.source.value))) {
              for (const specifier of node.specifiers) {
                if (
                  specifier.type !== 'ImportSpecifier' ||
                  ['write', 'writeSync', 'writev', 'writevSync'].includes(
                    ctx.sourceCode.getText(specifier.imported),
                  )
                ) report(specifier);
              }
            }
          },
        };
      },
    },
  },
};

Deno.test('boundary detects aliases, destructuring, computed and ambiguous output access', () => {
  const bad = [
    'console.log("x");',
    'const c = console; c.warn("x");',
    'const { log } = console; log("x");',
    'globalThis["console"]["error"]("x");',
    'globalThis[key]("x");',
    'const g = globalThis; g.console.log("x");',
    'const { stdout: out } = Deno; out.write(bytes);',
    'Deno.stdout.write(bytes);',
    'process["stderr"].write("x");',
    'const p = process; p.stderr.write("x");',
    'let g; g = globalThis; g.console.log("x");',
    'function leak() { return Deno; }',
    'import { writeSync as out } from "node:fs"; out(2, "x");',
    'const line = `[http ${stamp}] accept`;',
    'import p from "node:process"; p.stdout.write("x");',
  ];
  for (const source of bad) {
    assert(
      Deno.lint.runPlugin(loggingBoundary, 'snippet.ts', source).length > 0,
      source,
    );
  }
  for (
    const source of [
      '// console.log("x");',
      'const text = "console.log Deno.stdout";',
      'log.event("http_accept", { request });',
      'Deno.readTextFile("x");',
    ]
  ) {
    assertEquals(
      Deno.lint.runPlugin(loggingBoundary, 'snippet.ts', source),
      [],
      source,
    );
  }
});

async function sourceFiles(root: string): Promise<string[]> {
  const paths: string[] = [];
  for await (const entry of Deno.readDir(root)) {
    const path = `${root}/${entry.name}`;
    if (entry.isDirectory) paths.push(...await sourceFiles(path));
    else if (entry.isFile && path.endsWith('.ts')) paths.push(path);
  }
  return paths;
}

Deno.test('all production writers use the owned presentation boundary', async () => {
  const paths = [
    'main.ts',
    ...await sourceFiles('src'),
    ...await sourceFiles('core'),
    ...await sourceFiles('layers'),
  ];
  const violations: string[] = [];
  for (const path of paths) {
    if (OWNERS.has(path)) continue;
    const results = Deno.lint.runPlugin(
      loggingBoundary,
      path,
      await Deno.readTextFile(path),
    );
    for (const result of results) {
      violations.push(`${path}:${result.range[0]} ${result.message}`);
    }
  }
  assertEquals(violations, []);
});
