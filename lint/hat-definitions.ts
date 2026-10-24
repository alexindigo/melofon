// Deno API sources (~/Sources/denoland-deno):
// cli/tsc/dts/lib.deno.unstable.d.ts:1559-1565,1617-1693 defines reports,
// context, visitors and Plugin; :1724-4489 defines the AST used below.
// cli/js/40_lint.js:355-424 reports node ranges as file/line diagnostics.
// cli/schemas/config-file.v1.json:704-709 defines lint.plugins.
// Deliberately an allowlist: unknown syntax must not introduce load-time work.

function literalData(node: Deno.lint.Node): boolean {
  switch (node.type) {
    case 'Literal':
      return true;
    case 'TemplateLiteral':
      return node.expressions.length === 0;
    case 'TSAsExpression':
    case 'TSSatisfiesExpression':
    case 'TSTypeAssertion':
      return literalData(node.expression);
    case 'UnaryExpression':
      return (node.operator === '-' || node.operator === '+') &&
        node.argument.type === 'Literal' &&
        (typeof node.argument.value === 'number' ||
          node.operator === '-' && typeof node.argument.value === 'bigint');
    case 'ArrayExpression':
      return node.elements.every((item) => item === null || literalData(item));
    case 'ObjectExpression':
      return node.properties.every((property) =>
        property.type === 'Property' && !property.method &&
        property.kind === 'init' && !property.shorthand &&
        (!property.computed || property.key.type === 'Literal') &&
        literalData(property.value)
      );
    case 'NewExpression':
      return node.callee.type === 'Identifier' &&
        (node.callee.name === 'Set' || node.callee.name === 'Map') &&
        node.arguments.length === 1 &&
        node.arguments[0].type === 'ArrayExpression' &&
        literalData(node.arguments[0]);
    case 'CallExpression': {
      const callee = node.callee;
      return !node.optional && callee.type === 'MemberExpression' &&
        !callee.computed && !callee.optional &&
        callee.object.type === 'Identifier' &&
        callee.object.name === 'Object' &&
        callee.property.type === 'Identifier' &&
        callee.property.name === 'freeze' && node.arguments.length === 1 &&
        literalData(node.arguments[0]);
    }
    default:
      return false;
  }
}

function definition(
  node: Deno.lint.Node,
  source: Deno.lint.SourceCode,
): boolean {
  // Ambient declarations are erased, including declare let/class/namespace.
  if ('declare' in node && node.declare) return true;
  switch (node.type) {
    case 'ClassDeclaration':
      // Deno's serializer hardcodes declare=false for class declarations:
      // cli/tools/lint/ast_buffer/swc.rs:1386-1389. The parsed source range
      // retains the ambient modifier (SourceCode.getText: dts:1571-1576).
      return /^declare\b/.test(source.getText(node).trimStart());
    case 'ImportDeclaration':
    case 'ExportAllDeclaration':
    case 'TSTypeAliasDeclaration':
    case 'TSInterfaceDeclaration':
    case 'TSDeclareFunction':
    case 'FunctionDeclaration':
    case 'FunctionExpression':
    case 'ArrowFunctionExpression':
      return true;
    case 'ExportNamedDeclaration':
      return node.declaration === null || definition(node.declaration, source);
    case 'ExportDefaultDeclaration':
      return definition(node.declaration, source);
    case 'VariableDeclaration':
      return node.kind === 'const' && node.declarations.every((declaration) =>
        // Destructuring can invoke iterators/getters/default initialisers.
        declaration.id.type === 'Identifier' && declaration.init !== null &&
        (declaration.init.type === 'FunctionExpression' ||
          declaration.init.type === 'ArrowFunctionExpression' ||
          literalData(declaration.init))
      );
    default:
      return false;
  }
}

export default {
  name: 'melofon',
  rules: {
    'hat-definitions': {
      create(context) {
        if (
          !/(?:^|\/)layers\/.+\.ts$/.test(
            context.filename.replaceAll('\\', '/'),
          )
        ) {
          return {};
        }
        return {
          Program(program) {
            for (const statement of program.body) {
              if (!definition(statement, context.sourceCode)) {
                context.report({
                  node: statement,
                  message: 'Hat top level must contain definitions only.',
                  hint:
                    'Use imports, types, functions or const literal data; move runtime work and state into functions or core services.',
                });
              }
            }
          },
        };
      },
    },
  },
} satisfies Deno.lint.Plugin;
