// Ownership boundary: plugin-local number classification, adapter-owned policy,
// and explicit exceptions for fractional/syntax-gated/output-only conversions.
import { assert, assertEquals } from '@std/assert';

async function sources(root: URL): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  async function walk(directory: URL, prefix = '') {
    for await (const entry of Deno.readDir(directory)) {
      const path = `${prefix}${entry.name}`;
      const url = new URL(
        encodeURIComponent(entry.name) + (entry.isDirectory ? '/' : ''),
        directory,
      );
      if (entry.isDirectory) await walk(url, `${path}/`);
      else if (entry.isFile && entry.name.endsWith('.ts')) {
        result.set(path, await Deno.readTextFile(url));
      }
    }
  }
  await walk(root);
  return result;
}

Deno.test('number classification is independently plugin-owned and routes cannot validate after Number conversion', async () => {
  const permittedConversions: Record<string, Record<string, number>> = {
    opensubsonic: {
      // Hash-derived folder IDs/digits-only folder lookup; not integer fields.
      'params.ts': 2,
      // Intentionally fractional positions/seconds/timestamps.
      'rest/createBookmark##ext/get.ts': 1,
      'rest/savePlayQueue##ext/get.ts': 1,
      'rest/scrobble##ext/get.ts': 2,
      // Digit-syntax bitrate gate and syntactically classified rendition names.
      'rest/stream##ext/get.ts': 1,
      'rest/hls.m3u8/get.ts': 1,
    },
    owntone: {
      // Hash-derived output IDs and four digits-only catalog-ID lookups.
      'payloads.ts': 5,
    },
  };
  for (const plugin of ['opensubsonic', 'owntone']) {
    const root = new URL(`../layers/${plugin}/`, import.meta.url);
    const files = await sources(root);
    const numbers = files.get('numbers.ts');
    assert(numbers, `${plugin} owns numbers.ts`);
    assert(
      !/\b(?:import|export)[\s\S]*?\bfrom\s*['"]/.test(numbers),
      `${plugin} classifier has no imports`,
    );
    for (const [path, text] of files) {
      if (path === 'numbers.ts') continue;
      assert(
        !/Number\.(?:isInteger|isSafeInteger)\s*\(/.test(text),
        `${plugin}/${path}: integer classification belongs to numbers.ts`,
      );
      const conversions =
        [...text.matchAll(/\bNumber\s*\(|\.map\(Number\)/g)].length;
      assertEquals(
        conversions,
        permittedConversions[plugin][path] ?? 0,
        `${plugin}/${path}: undeclared numeric conversion`,
      );
      for (const match of text.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) {
        const target = match[1];
        assert(
          !target.includes(
            plugin === 'opensubsonic' ? 'owntone' : 'opensubsonic',
          ),
          `${plugin}/${path}: sibling import`,
        );
        if (target.startsWith('.')) {
          assert(
            new URL(
              target,
              new URL(path.split('/').map(encodeURIComponent).join('/'), root),
            ).href.startsWith(root.href),
            `${plugin}/${path}: escaping runtime import`,
          );
        }
        if (target.endsWith('/numbers.ts') || target === './numbers.ts') {
          assertEquals(
            path,
            plugin === 'opensubsonic' ? 'params.ts' : 'payloads.ts',
            `${plugin}: only owning adapter imports classifier`,
          );
        }
      }
    }
    const adapter = files.get(
      plugin === 'opensubsonic' ? 'params.ts' : 'payloads.ts',
    )!;
    assert(
      adapter.includes('legacyInteger('),
      `${plugin} adapter owns legacy policy`,
    );
    if (plugin === 'opensubsonic') assert(adapter.includes('safeInteger('));
  }
  const sub = await sources(
    new URL('../layers/opensubsonic/', import.meta.url),
  );
  for (
    const path of [
      'rest/setRating##ext/get.ts',
      'rest/updatePlaylist##ext/get.ts',
      'rest/hls/segment.ts/get.ts',
    ]
  ) {
    assert(
      sub.get(path)!.includes('integerParam'),
      `${path}: owning adapter required`,
    );
  }
});
