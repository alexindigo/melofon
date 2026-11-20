import { assert, assertEquals } from '@std/assert';
import type { nativeHttpFixture } from './playback-native-http.ts';

export function timelinePcm(frames: number, seed = 1) {
  const bytes = new Uint8Array(frames * 4), view = new DataView(bytes.buffer);
  for (let i = 0; i < frames; i++) {
    view.setInt16(i * 4, 1000 + (i * 13 + seed) % 20000, true);
    view.setInt16(i * 4 + 2, -1000 - (i * 17 + seed) % 20000, true);
  }
  return bytes;
}
export function concatenate(parts: Uint8Array[]) {
  const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  return bytes;
}
export async function timelineUntil(
  what: string,
  predicate: () => boolean | Promise<boolean>,
) {
  const deadline = performance.now() + 20000;
  while (!await predicate()) {
    assert(performance.now() < deadline, `timed out: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
export async function timelineLibraryProof() {
  const path = await Deno.realPath(
    new URL('../../helper/raop/libmelofon_raop.so', import.meta.url),
  );
  assertEquals(await Deno.realPath(Deno.env.get('MELOFON_RAOP_LIB')!), path);
  assert(
    (await Deno.readTextFile('/proc/self/maps')).split('\n').some((line) =>
      line.endsWith(` ${path}`)
    ),
  );
  console.log(`timeline native library: ${path}`);
}
export async function timelineControl(
  f: Awaited<ReturnType<typeof nativeHttpFixture>>,
) {
  const { credential } = await f.fixture.login('bearer');
  const json = async (
    path: string,
    method: string,
    body: unknown,
    expected: number,
  ) => {
    const response = await f.fixture.json(
      `/api/v1/players/1${path}`,
      method,
      body,
      credential,
    );
    const text = await response.text();
    assertEquals(response.status, expected, text);
    return text ? JSON.parse(text) : undefined;
  };
  return {
    credential,
    add: (ids = f.songIds) =>
      json('/queue/items', 'POST', {
        references: ids.map((id) => ({ kind: 'song', id })),
      }, 200),
    command: (kind: string, body: unknown = {}) =>
      json(`/${kind}`, 'POST', body, 204),
    modes: (body: unknown) => json('', 'PATCH', body, 200),
    move: (id: number, position: number) =>
      json(`/queue/items/${id}`, 'PATCH', { position }, 204),
    async remove(id?: number) {
      const response = await f.fixture.request(
        `/api/v1/players/1/queue${id === undefined ? '' : `/items/${id}`}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${credential}` },
        },
      );
      assertEquals(response.status, 204, await response.text());
    },
    async current() {
      const response = await f.fixture.get('/api/v1/players/1', credential);
      assertEquals(response.status, 200);
      return (await response.json()).player;
    },
  };
}
