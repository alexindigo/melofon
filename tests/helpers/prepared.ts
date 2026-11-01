import { cp } from 'node:fs/promises';

const built = new Map<string, Promise<string>>();
const templates = new Set<string>();
type Build = (dataDir: string) => Promise<void>;

/** Build once per test-file isolate; builders must close their store. */
export function prepared(name: string, build: Build): Promise<string> {
  let template = built.get(name);
  if (!template) {
    template = (async () => {
      const dir = await Deno.makeTempDir({ prefix: 'melofon-prepared-' });
      templates.add(dir);
      try {
        await build(dir);
        try {
          await Deno.stat(`${dir}/melofon.duckdb.wal`);
          throw new Error(`Prepared store still has a WAL: ${name}`);
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        }
        return dir;
      } catch (error) {
        await Deno.remove(dir, { recursive: true });
        templates.delete(dir);
        throw error;
      }
    })();
    built.set(name, template);
  }
  return template;
}

/** Every caller owns a full private copy, including the first caller. */
export async function restored(
  name: string,
  build: Build,
  prefix: string,
): Promise<string> {
  const template = await prepared(name, build);
  const dir = await Deno.makeTempDir({ prefix });
  try {
    await cp(template, dir, { recursive: true });
    return dir;
  } catch (error) {
    await Deno.remove(dir, { recursive: true });
    throw error;
  }
}

addEventListener('unload', () => {
  for (const dir of templates) Deno.removeSync(dir, { recursive: true });
});
