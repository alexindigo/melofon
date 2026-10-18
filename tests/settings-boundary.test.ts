import { assertEquals } from '@std/assert';

async function files(root: string): Promise<string[]> {
  const result: string[] = [];
  for await (const entry of Deno.readDir(root)) {
    const path = `${root}/${entry.name}`;
    if (entry.isDirectory) result.push(...await files(path));
    else if (entry.isFile && path.endsWith('.ts')) result.push(path);
  }
  return result;
}

Deno.test('settings boundary: generic settings and config endpoints know no owner keys', async () => {
  const found: string[] = [];
  for (
    const path of [
      'src/state.ts',
      'src/settings-schema.ts',
      ...await files('core/config'),
    ]
  ) {
    const source = await Deno.readTextFile(path);
    if (
      /["'`](?:airplay|opensubsonic|lookups)\./.test(source) ||
      source.includes('CONNECTION_STRATEGY_DEFAULT_KEY')
    ) found.push(path);
  }
  assertEquals(found, []);
});
