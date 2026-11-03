import { assert, assertEquals, assertNotEquals } from '@std/assert';
import { decodeBase64 } from '@std/encoding/base64';
import { cp } from 'node:fs/promises';
import { type ArtworkPixels, createArtwork } from '../src/artwork.ts';
import { createLibraries } from '../src/libraries.ts';
import { createLibrary } from '../src/library.ts';
import { createPlaylists } from '../src/playlists.ts';
import { imagePixels } from '../src/media.ts';
import { scanLibrary } from '../src/scan.ts';
import { apiFixture } from './helpers/api.ts';
import { tagged } from './helpers/tagged.ts';
import { pixelPng, twoFrameGif } from './helpers/pixel-image.ts';

Deno.test('HTTP artwork pixels preserve source identity, RGBA, bounds, privacy and retryable admission', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-artwork-pixels-' });
  const root = `${dir}/layers`;
  await cp('layers/melofon', `${root}/melofon`, { recursive: true });
  const route = `${root}/melofon/api/pixel-probe`;
  await Deno.mkdir(`${route}/#kind/#id`, { recursive: true });
  await Deno.writeTextFile(
    `${route}/20-auth.ts`,
    "export { default } from '#melofon/auth.ts';",
  );
  await Deno.writeTextFile(
    `${route}/#kind/#id/get.ts`,
    `
import { encodeBase64 } from '@std/encoding/base64';
export default async function(request, context) {
  const p = new URL(request._raw.url).searchParams;
  const ref = {kind: request.params.kind, id: request.params.id};
  const opts = {username: context.state.user.username, size: Number(p.get('size') ?? 100)};
  const art = context.app.artwork;
  if (p.has('describe')) return await art.describe(ref, opts);
  if (p.has('body')) {
    const result = await art.get(ref, opts);
    return result.kind === 'unknown' ? new Response(null, {status: 404}) : result.response;
  }
  const result = await art.pixels(ref, opts);
  return result.kind === 'pixels' ? {...result, rgba: encodeBase64(result.rgba)} : result;
}`,
  );
  const music = `${dir}/music`;
  const cover = `${music}/Album/cover.png`;
  const expected = new Uint8Array([
    255,
    0,
    0,
    255,
    0,
    255,
    0,
    128,
    0,
    0,
    255,
    0,
    19,
    37,
    71,
    64,
    127,
    89,
    53,
    200,
    251,
    241,
    231,
    255,
  ]);
  const original = pixelPng(3, 2, expected);
  let library!: ReturnType<typeof createLibrary>;
  let playlists!: ReturnType<typeof createPlaylists>;
  let calls = 0;
  let hold: Promise<void> | undefined;
  let entered: (() => void) | undefined;
  let release: (() => void) | undefined;
  let fail = false;
  const f = await apiFixture({
    hats: { layersRoot: root, extraPorts: 0, env: () => ({}) },
    services: async (f) => {
      await Deno.mkdir(`${music}/Album`, { recursive: true });
      await tagged(`${music}/Album/song.mp3`, {
        TALB: 'Album',
        TPE2: 'Artist',
      });
      await Deno.writeFile(cover, original);
      await createLibraries(f.store).add('Music', music);
      await scanLibrary(f.store);
      library = createLibrary(f.store);
      playlists = createPlaylists(f.store);
      return {
        artwork: createArtwork(library, {
          state: f.state,
          dataDir: f.cfg.dataDir,
          facts: f.store.artwork,
          playlists,
          pixels: async (bytes, width, height) => {
            calls++;
            entered?.();
            await hold;
            if (fail) throw new Error('fixture native failure');
            return await imagePixels(bytes, width, height);
          },
        }),
      };
    },
  });
  try {
    assert(
      (await Deno.resolveDns('melofon.home', 'A')).every((ip) =>
        !ip.startsWith('127.')
      ),
    );
    const cookie = (await f.login('cookie')).credential;
    const bearer = (await f.login('bearer')).credential;
    const song = (await library.listSongs({ size: 1, offset: 0 }))[0];
    const path = (kind: string, id: string, query = '') =>
      `/api/v1/pixel-probe/${kind}/${id}?${query}`;
    const album = path('album', song.albumId!);
    const pixels = async (url = album, auth = cookie) => {
      const response = await f.get(url, auth);
      assertEquals(response.status, 200);
      const result = await response.json();
      if (result.kind === 'pixels') result.rgba = decodeBase64(result.rgba);
      return result as ArtworkPixels;
    };
    const first = await pixels();
    assert(first.kind === 'pixels');
    assertEquals([first.width, first.height], [3, 2]);
    assertEquals(first.rgba, expected);
    const description = await (await f.get(`${album}&describe`, bearer)).json();
    assertEquals(first.descriptor, description.descriptor);
    const hash = await crypto.subtle.digest(
      'SHA-256',
      new Uint8Array(original),
    );
    assertEquals(
      first.descriptor.sourceHash,
      [...new Uint8Array(hash)].map((n) => n.toString(16).padStart(2, '0'))
        .join(''),
    );
    assertEquals(await pixels(path('song', song.id), bearer), first);
    const body = await f.get(`${album}&body`, cookie);
    assertEquals(new Uint8Array(await body.arrayBuffer()), original);
    const unauthenticated = await f.get(album);
    assertEquals(unauthenticated.status, 401);
    await unauthenticated.arrayBuffer();
    assertEquals(await pixels(path('song', 'unknown')), { kind: 'unknown' });

    // Core still authorizes on each pixel call, including after an allowed grid.
    const list = await playlists.create('admin', 'Private', [song.id], true);
    assertEquals((await pixels(path('playlist', list.id))).kind, 'pixels');
    await f.auth.users.create(f.admin.id, {
      username: 'reader',
      password: 'password-reader',
      role: 'user',
    });
    const reader =
      (await f.login('bearer', 'reader', 'password-reader')).credential;
    await playlists.update('admin', list.id, { public: false });
    assertEquals(await pixels(path('playlist', list.id), reader), {
      kind: 'unknown',
    });

    // Longest-side fit, including extreme aspect and no upscaling.
    for (
      const [width, height, size, w, h] of [
        [203, 107, 100, 100, 52],
        [107, 203, 100, 52, 100],
        [1000, 1, 100, 100, 1],
        [1, 1, 100, 1, 1],
      ]
    ) {
      await Deno.writeFile(
        cover,
        pixelPng(width, height, new Uint8Array(width * height * 4).fill(255)),
      );
      const result = await pixels(`${album}&size=${size}`);
      assert(result.kind === 'pixels');
      assertEquals([result.width, result.height, result.rgba.length], [
        w,
        h,
        w * h * 4,
      ]);
      assertEquals([result.descriptor.width, result.descriptor.height], [
        width,
        height,
      ]);
      assert(result.rgba.every((n) => n === 255));
    }
    await Deno.writeFile(cover, twoFrameGif());
    const animated = await pixels();
    assert(animated.kind === 'pixels');
    assertEquals(
      animated.rgba,
      new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255]),
    );
    await Deno.writeFile(cover, original);
    assertEquals((await pixels()).kind, 'pixels');
    assertEquals(first.rgba, expected); // JS bytes survive subsequent native work.
    for (const size of ['0', '-1', '1.5', 'NaN', '9007199254740992']) {
      assertEquals(await pixels(`${album}&size=${size}`), {
        kind: 'unavailable',
      });
    }
    const beforeBudget = calls;
    await f.state.set('artwork.maxPixels', '5');
    assertEquals(await pixels(), { kind: 'unavailable' });
    await f.state.set('artwork.maxPixels', '64000000');
    await f.state.set('artwork.maxSourceMegabytes', '0');
    assertEquals(await pixels(), { kind: 'unavailable' });
    await f.state.set('artwork.maxSourceMegabytes', '20');
    assertEquals(calls, beforeBudget); // budgets reject before native admission.
    await Deno.writeFile(cover, new Uint8Array([1, 2, 3]));
    assertEquals(await pixels(), { kind: 'unavailable' });
    assertEquals(calls, beforeBudget);
    // Valid header, broken compressed payload: exercise actual native failure.
    await Deno.writeFile(cover, original.subarray(0, 33));
    assertEquals(await pixels(), { kind: 'unavailable' });
    assertEquals(calls, beforeBudget + 1);
    await Deno.remove(cover);
    assertEquals(await pixels(), { kind: 'unavailable' });
    await Deno.writeFile(cover, original);

    // Pixel work shares the resize queue. Full admission returns no encoded bytes.
    await f.state.set('artwork.maxConcurrentResizes', '1');
    await f.state.set('artwork.maxQueuedResizes', '0');
    hold = new Promise<void>((resolve) => release = resolve);
    const started = new Promise<void>((resolve) => entered = resolve);
    const pending = pixels();
    await started;
    const beforeOverload = calls;
    assertEquals(await pixels(), { kind: 'unavailable' });
    assertEquals(calls, beforeOverload);
    const overloadedResize = await f.get(`${album}&body&size=1`, cookie);
    assertEquals(
      new Uint8Array(await overloadedResize.arrayBuffer()),
      original,
    );
    release!();
    assertEquals(await pending, first);
    hold = undefined;
    entered = undefined;
    fail = true;
    assertEquals(await pixels(), { kind: 'unavailable' });
    fail = false;
    assertEquals(await pixels(), first); // failure neither poisons facts nor leaks admission.
    await Deno.writeFile(cover, pixelPng(3, 2, new Uint8Array(24).fill(255)));
    const changed = await pixels();
    assert(changed.kind === 'pixels');
    assertNotEquals(changed.descriptor.version, first.descriptor.version);
    assertEquals(changed.rgba, new Uint8Array(24).fill(255));
  } finally {
    release?.();
    await f.close();
    await Deno.remove(dir, { recursive: true });
  }
});
