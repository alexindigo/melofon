import { assert } from '@std/assert';
export const lookupManifest = (overrides: Record<string, unknown> = {}) => ({
  contract: 1,
  name: 'Fixture',
  version: '1.0.0',
  capabilities: [{
    id: 'cover',
    accepts: 'album',
    provides: ['album.image.front'],
    requires: [],
  }],
  network: { hosts: ['fixture.test', '*.images.test'], ratePerMinute: 600000 },
  settings: {
    type: 'object',
    properties: { behavior: { type: 'string', default: 'found' } },
  },
  ...overrides,
});
export async function lookupPlugin(
  root: string,
  code = `export default { cover() { return { candidates: [] }; } };`,
  id = 'fixture',
  manifest = lookupManifest(),
) {
  const dir = `${root}/${id}`;
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(`${dir}/manifest.json`, JSON.stringify(manifest));
  await Deno.writeTextFile(`${dir}/index.ts`, code);
  return dir;
}
export async function eventually(
  fn: () => boolean | Promise<boolean>,
  timeoutMs = 10000,
) {
  const until = performance.now() + timeoutMs;
  while (!await fn()) {
    assert(performance.now() < until, 'Timed out waiting for lookup outcome');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
