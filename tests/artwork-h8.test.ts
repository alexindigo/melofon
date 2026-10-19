import { assert, assertEquals } from '@std/assert';
import { Buffer } from 'node:buffer';
import { deflateSync } from 'node:zlib';
import { AV_PIX_FMT_RGBA, Decoder, Demuxer } from 'node-av';
import { pathfinder } from '@pathfinder/pathfinder';
import { openStore } from '../src/store/index.ts';
import { rawSql } from '../src/store/testing.ts';
import { seedFirstUser } from '../src/users.ts';
import { createUserService } from '../src/user.ts';
import { createLibraries } from '../src/libraries.ts';
import { createLibrary } from '../src/library.ts';
import { createState } from '../src/state.ts';
import { createPlaylists } from '../src/playlists.ts';
import { createAnnotation } from '../src/annotation.ts';
import { createListens } from '../src/listens.ts';
import { createArtwork } from '../src/artwork.ts';
import { createNowPlaying } from '../src/nowplaying.ts';
import { createPlayback } from '../src/playback.ts';
import { createPlayer } from '../src/player.ts';
import { scanLibrary } from '../src/scan.ts';
import { resizeImage } from '../src/media.ts';
import { facade } from '../src/facade.ts';
import { loadLayers } from '../src/layers.ts';
import { tagged } from './helpers/tagged.ts';

// Independent fixture encoder, with exact RGB colors and dimensions.
function chunk(name: string, payload: Uint8Array) {
  const body = Buffer.concat([Buffer.from(name), payload]);
  let crc = 0xffffffff;
  for (const byte of body) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  const result = Buffer.alloc(body.length + 8);
  result.writeUInt32BE(payload.length);
  result.set(body, 4);
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, body.length + 4);
  return result;
}
function png(width: number, height: number, color?: number[]) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const pixels = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = y * (width * 3 + 1) + x * 3 + 1;
      pixels.set(
        color ??
          [(x * 17 + y * 31) % 256, (x * 37 ^ y * 11) % 256, (x * y * 3) % 256],
        offset,
      );
    }
  }
  return new Uint8Array(Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]));
}
async function picture(path: string, image: Uint8Array, mime = 'image/png') {
  const bytes = await Deno.readFile(path);
  const size = (
    n: number,
  ) => [n >> 21 & 127, n >> 14 & 127, n >> 7 & 127, n & 127];
  const end = 10 + bytes[6] * 2097152 + bytes[7] * 16384 + bytes[8] * 128 +
    bytes[9];
  const payload = Buffer.concat([
    Buffer.from(`\x00${mime}\x00\x03\x00`),
    image,
  ]);
  const frame = Buffer.concat([
    Buffer.from('APIC'),
    Buffer.from(size(payload.length)),
    Buffer.alloc(2),
    payload,
  ]);
  const head = bytes.slice(0, end);
  head.set(size(end - 10 + frame.length), 6);
  await Deno.writeFile(path, Buffer.concat([head, frame, bytes.subarray(end)]));
}
const bytes = async (response: Response) =>
  new Uint8Array(await response.arrayBuffer());

function apng() {
  const first = png(16, 8, [255, 0, 0]), second = png(16, 8, [0, 0, 255]);
  const control = (sequence: number) => {
    const data = Buffer.alloc(26);
    data.writeUInt32BE(sequence);
    data.writeUInt32BE(16, 4);
    data.writeUInt32BE(8, 8);
    data.writeUInt16BE(1, 20);
    data.writeUInt16BE(10, 22);
    return chunk('fcTL', data);
  };
  const compressed = (image: Uint8Array) =>
    image.subarray(
      41,
      41 + new DataView(image.buffer, image.byteOffset).getUint32(33),
    );
  return new Uint8Array(Buffer.concat([
    first.subarray(0, 33),
    chunk('acTL', Buffer.from([0, 0, 0, 2, 0, 0, 0, 0])),
    control(0),
    chunk('IDAT', compressed(first)),
    control(1),
    chunk(
      'fdAT',
      Buffer.concat([Buffer.from([0, 0, 0, 2]), compressed(second)]),
    ),
    chunk('IEND', Buffer.alloc(0)),
  ]));
}
function gif() {
  // Two actual LZW frames, red/blue then blue/red, 100 ms apiece.
  return new Uint8Array(Buffer.concat([
    Buffer.from('GIF89a'),
    Buffer.from([2, 0, 1, 0, 128, 0, 0, 255, 0, 0, 0, 0, 255]),
    Buffer.from([33, 255, 11]),
    Buffer.from('NETSCAPE2.0'),
    Buffer.from([3, 1, 0, 0, 0]),
    ...[68, 12].map((codes) =>
      Buffer.from([
        33,
        249,
        4,
        0,
        10,
        0,
        0,
        0,
        44,
        0,
        0,
        0,
        0,
        2,
        0,
        1,
        0,
        0,
        2,
        2,
        codes,
        10,
        0,
      ])
    ),
    Buffer.from([59]),
  ]));
}
async function decoded(data: Uint8Array) {
  await using input = await Demuxer.open(Buffer.from(data));
  const stream = input.video()!;
  await using decoder = await Decoder.create(stream, {
    rescale: { pixelFormat: AV_PIX_FMT_RGBA },
  });
  for await (const frame of decoder.frames(input.packets(stream.index))) {
    if (!frame) continue;
    try {
      return {
        width: frame.width,
        height: frame.height,
        stride: frame.linesize[0],
        pixels: new Uint8Array(frame.data![0]),
      };
    } finally {
      frame.free();
    }
  }
  throw new Error('No decoded response image');
}

Deno.test('H8 artwork consumer contract', async (t) => {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-h8-' });
  const store = await openStore(`${dir}/data`);
  const cfg = {
    listen: undefined,
    dataDir: `${dir}/data`,
    user: 'admin',
    password: 'test',
    secret: 'h8-secret',
    version: 'test',
  };
  try {
    await seedFirstUser(store, cfg);
    await rawSql(store).run(
      "INSERT INTO users (id, name, password_enc, created_at) SELECT 'other', 'other', password_enc, now() FROM users WHERE name='admin'",
    );
    const root = `${dir}/music`;
    await Deno.mkdir(root);
    const libraries = createLibraries(store);
    await libraries.add('Music', root);
    const colors = [[240, 0, 0], [0, 240, 0], [0, 0, 240], [240, 240, 0]];
    for (let n = 0; n < 5; n++) {
      await Deno.mkdir(`${root}/${n}`);
      await tagged(`${root}/${n}/song.mp3`, {
        TALB: `Album ${n}`,
        TPE2: 'H8',
        TRCK: '1',
      });
      if (n < 4) {
        await Deno.writeFile(`${root}/${n}/cover.png`, png(32, 32, colors[n]));
      }
    }
    const own = png(120, 80);
    await picture(`${root}/0/song.mp3`, own);
    await tagged(`${root}/0/plain.mp3`, {
      TALB: 'Album 0',
      TPE2: 'H8',
      TRCK: '2',
    });
    await scanLibrary(store);
    const library = createLibrary(store),
      state = createState(store),
      playlists = createPlaylists(store);
    const artwork = createArtwork(library, {
      state,
      playlists,
      dataDir: cfg.dataDir,
    });
    const player = createPlayer(), nowPlaying = createNowPlaying(store);
    const playback = createPlayback({ player, nowPlaying, library, cfg });
    const bag = {
      cfg,
      libraries,
      library,
      state,
      playlists,
      artwork,
      user: createUserService(store, cfg),
      annotation: createAnnotation(store),
      listens: createListens(store),
      playback,
    };
    const core = await pathfinder({ roots: ['core/'], app: { store, cfg } });
    const layers = await loadLayers({ app: bag });
    const app = facade(core, layers);
    const ot = facade(core, layers, {
      listenPort: 3689,
      defaultPort: 4534,
      env: {},
    });
    const request = (
      op: string,
      params: Record<string, string> = {},
      user = 'admin',
    ) =>
      app(
        new Request(
          `http://x/rest/${op}?${new URLSearchParams({
            u: user,
            p: 'test',
            c: 'h8',
            v: '1.16.1',
            f: 'json',
            ...params,
          })}`,
        ),
      );
    const cover = (id: string, size?: number) =>
      request('getCoverArt', {
        id,
        ...(size === undefined ? {} : { size: String(size) }),
      });
    const songs = await library.listSongs({ size: 20, offset: 0 });
    const song = songs.find((s) => s.path.endsWith('/0/song.mp3'))!;
    const plain = songs.find((s) => s.path.endsWith('/0/plain.mp3'))!;
    const missing = songs.find((s) => s.path.endsWith('/4/song.mp3'))!;

    await t.step(
      'song scan fact reaches Child, OwnTone item and nowplaying consumers',
      async () => {
        assert(song.pictureHash);
        assertEquals(
          (await (await request('getSong', { id: song.id })).json())[
            'subsonic-response'
          ].song.coverArt,
          song.id,
        );
        assertEquals(
          (await (await request('getSong', { id: plain.id })).json())[
            'subsonic-response'
          ].song.coverArt,
          plain.albumId,
        );
        assertEquals(await bytes(await cover(song.id)), own);
        const tracks = await (await ot(
          new Request('http://x/api/search?type=tracks&query='),
        )).json();
        const track = tracks.tracks.items.find((item: { path: string }) =>
          item.path.endsWith('/0/song.mp3')
        );
        assert(track);
        assertEquals(
          await bytes(
            await ot(new Request(`http://x/artwork/item/${track.id}`)),
          ),
          own,
        );
        await playback.restore({
          queue: [song],
          state: 'pause',
          currentIndex: 0,
          positionMs: 0,
          repeat: 'off',
          shuffle: false,
          consume: false,
        });
        assertEquals(
          await bytes(await ot(new Request('http://x/artwork/nowplaying'))),
          own,
        );
        assertEquals(
          (await ot(new Request('http://x/artwork/item/2147483646'))).status,
          404,
        );
      },
    );
    await t.step(
      'PNG aspect-fit, no upscale, originals and unchanged placeholder',
      async () => {
        const sized = await cover(song.id, 60);
        assertEquals(sized.headers.get('content-type'), 'image/png');
        const image = await decoded(await bytes(sized));
        assertEquals([image.width, image.height], [60, 40]);
        assertEquals(await bytes(await cover(song.id, 0)), own);
        assertEquals(await bytes(await cover(song.id, 200)), own);
        assertEquals(
          await bytes(await cover(missing.id, 16)),
          await bytes(artwork.placeholder()),
        );
        assertEquals(
          (await (await cover('unknown', 20)).json())['subsonic-response'].error
            .code,
          70,
        );
      },
    );
    await t.step(
      'JPEG encoder quality changes returned bytes and dimensions',
      async () => {
        await Deno.remove(`${root}/1/cover.png`);
        const encoded = await resizeImage(png(160, 100), 160, 100, 'jpeg', 95);
        const segment = (marker: number, payload: Buffer) => {
          const header = Buffer.from([255, marker, 0, 0]);
          header.writeUInt16BE(payload.length + 2, 2);
          return Buffer.concat([header, payload]);
        };
        // EXIF orientation 6 (rotate 90°); resize intentionally ignores it.
        const exif = Buffer.from(
          '45786966000049492a0008000000010012010300010000000600000000000000',
          'hex',
        );
        const icc = Buffer.alloc(128);
        icc.writeUInt32BE(128);
        icc.write('acsp', 36);
        const source = Buffer.concat([
          encoded.subarray(0, 2),
          segment(225, exif),
          segment(
            226,
            Buffer.concat([Buffer.from('ICC_PROFILE\x00\x01\x01'), icc]),
          ),
          encoded.subarray(2),
        ]);
        await Deno.writeFile(`${root}/1/cover.jpg`, source);
        const id = songs.find((s) => s.path.endsWith('/1/song.mp3'))!.albumId!;
        await state.set('artwork.jpegQuality', '15');
        const low = await cover(id, 80);
        assertEquals(low.headers.get('content-type'), 'image/jpeg');
        const lowBytes = await bytes(low);
        const lowImage = await decoded(lowBytes);
        assertEquals([lowImage.width, lowImage.height], [80, 50]);
        await state.set('artwork.jpegQuality', '95');
        const high = await bytes(await cover(id, 80));
        assert(
          high.length > lowBytes.length,
          `${high.length} > ${lowBytes.length}`,
        );
        assert(!Buffer.from(high).includes(Buffer.from('ICC_PROFILE')));
        assert(!Buffer.from(high).includes(Buffer.from('Exif')));
        await state.set('artwork.jpegQuality', '75');
      },
    );
    await t.step(
      'disk cache hit, LRU eviction, restart reuse, source changes and deletion',
      async () => {
        const first = await cover(song.id, 41);
        assertEquals(first.headers.get('x-artwork-cache'), 'miss');
        const original = await bytes(first);
        const second = await cover(song.id, 41);
        assertEquals(second.headers.get('x-artwork-cache'), 'hit');
        assertEquals(await bytes(second), original);
        const restarted = createArtwork(library, {
          state,
          playlists,
          dataDir: cfg.dataDir,
        });
        assertEquals(
          (await restarted.cover(song.id, { size: 41 })).headers.get(
            'x-artwork-cache',
          ),
          'hit',
        );
        await state.set(
          'artwork.cacheMegabytes',
          String(original.length * 2.2 / 1048576),
        );
        const a = await cover(song.id, 41);
        await a.arrayBuffer();
        const b = await cover(song.id, 42);
        const bLength = (await b.arrayBuffer()).byteLength;
        await cover(song.id, 41);
        await cover(song.id, 43);
        let total = 0;
        for await (const entry of Deno.readDir(`${cfg.dataDir}/cache/images`)) {
          total +=
            (await Deno.stat(`${cfg.dataDir}/cache/images/${entry.name}`)).size;
        }
        assert(total <= original.length * 2.2);
        assertEquals(
          (await cover(song.id, 42)).headers.get('x-artwork-cache'),
          'miss',
        );
        assert(bLength > 0);
        await state.set('artwork.cacheMegabytes', '100');
        const id = songs.find((s) => s.path.endsWith('/2/song.mp3'))!.albumId!;
        const before = await bytes(await cover(id, 16));
        await Deno.writeFile(`${root}/2/cover.png`, png(32, 32, [200, 0, 200]));
        const changed = await cover(id, 16);
        assertEquals(changed.headers.get('x-artwork-cache'), 'miss');
        assert((await bytes(changed)).some((byte, n) => byte !== before[n]));
        await Deno.remove(`${cfg.dataDir}/cache`, { recursive: true });
        assertEquals(
          (await cover(song.id, 41)).headers.get('x-artwork-cache'),
          'miss',
        );
      },
    );
    await t.step(
      'resize admission bounds concurrent work and backlog at the consumer',
      async () => {
        await state.set('artwork.maxConcurrentResizes', '1');
        await state.set('artwork.maxQueuedResizes', '1');
        let active = 0, peak = 0, entered = 0;
        let release!: () => void;
        const barrier = new Promise<void>((resolve) => release = resolve);
        const bounded = createArtwork(library, {
          state,
          resize: async (...args) => {
            active++;
            entered++;
            peak = Math.max(peak, active);
            try {
              await barrier;
              return await resizeImage(...args);
            } finally {
              active--;
            }
          },
        });
        const endpoint = facade(
          core,
          await loadLayers({ app: { ...bag, artwork: bounded } }),
        );
        const pending = [51, 52, 53].map((size) =>
          endpoint(
            new Request(
              `http://x/rest/getCoverArt?u=admin&p=test&c=h8&v=1.16.1&id=${song.id}&size=${size}`,
            ),
          )
        );
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const first = await Promise.race([
            ...pending,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () =>
                  reject(new Error('Bounded backlog never returned original')),
                2000,
              );
            }),
          ]);
          assertEquals(await bytes(first.clone()), own);
          assertEquals(entered, 1);
        } finally {
          clearTimeout(timer);
          release();
        }
        const responses = await Promise.all(pending);
        const dimensions = await Promise.all(responses.map(async (response) => {
          const image = await decoded(await bytes(response));
          return image.width;
        }));
        assertEquals(peak, 1);
        assertEquals(entered, 2);
        assertEquals(dimensions.filter((width) => width === 120).length, 1);
        assertEquals(
          dimensions.filter((width) => width >= 51 && width <= 53).length,
          2,
        );
      },
    );
    await t.step(
      'pixel and byte budgets refuse before decoding, corrupt resize returns original',
      async () => {
        const path = `${root}/3/cover.png`,
          id = songs.find((s) => s.path.endsWith('/3/song.mp3'))!.albumId!;
        const huge = png(1, 1);
        new DataView(huge.buffer, huge.byteOffset).setUint32(16, 100000);
        new DataView(huge.buffer, huge.byteOffset).setUint32(20, 100000);
        await Deno.writeFile(path, huge);
        assertEquals(await bytes(await cover(id, 10)), huge);
        await Deno.writeFile(path, own);
        await state.set('artwork.maxSourceMegabytes', '0.0001');
        assertEquals(
          await bytes(await cover(id, 10)),
          await bytes(artwork.placeholder()),
        );
        await state.set('artwork.maxSourceMegabytes', '20');
        const corrupt = own.slice(0, 40);
        await Deno.writeFile(path, corrupt);
        assertEquals(await bytes(await cover(id, 10)), corrupt);
        await Deno.writeFile(path, png(32, 32, colors[3]));
      },
    );
    await t.step(
      'APNG passes through and GIF preserves animation; WebP passes through',
      async () => {
        const path = `${root}/3/cover.png`,
          id = songs.find((s) => s.path.endsWith('/3/song.mp3'))!.albumId!;
        const anim = apng();
        await Deno.writeFile(path, anim);
        assertEquals(await bytes(await cover(id, 10)), anim);
        const gifBytes = gif();
        const song = songs.find((s) => s.path.endsWith('/3/song.mp3'))!;
        await picture(song.path, gifBytes, 'image/gif');
        const result = await cover(song.id, 2);
        const webp = Buffer.from(await result.arrayBuffer());
        // Characterized on the pinned H8 VM runtime: libwebp_anim is usable.
        assertEquals(result.headers.get('content-type'), 'image/webp');
        assertEquals(webp.toString('ascii', 8, 12), 'WEBP');
        assertEquals([webp.readUIntLE(24, 3) + 1, webp.readUIntLE(27, 3) + 1], [
          2,
          1,
        ]);
        let frames = 0;
        const durations: number[] = [];
        for (let at = 12; at + 8 <= webp.length;) {
          if (webp.toString('ascii', at, at + 4) === 'ANMF') {
            frames++;
            durations.push(webp.readUIntLE(at + 20, 3));
          }
          const length = webp.readUInt32LE(at + 4);
          at += 8 + length + length % 2;
        }
        assertEquals(frames, 2);
        assertEquals(durations, [100, 100]);
        console.info(
          'H8 GIF outcome: libwebp_anim encoded two animated WebP frames',
        );
        await Deno.remove(path);
        await Deno.writeFile(`${root}/3/cover.webp`, webp);
        // For an encoded WebP this proves animation is never flattened/resized.
        assertEquals(await bytes(await cover(id, 1)), new Uint8Array(webp));
        await Deno.remove(`${root}/3/cover.webp`);
        await Deno.writeFile(path, png(32, 32, colors[3]));
      },
    );
    await t.step(
      'authorised playlist grid, small sets, update invalidation and private cache isolation',
      async () => {
        // Restore solid colors so decoded quadrants prove distinct contributing albums.
        await Deno.remove(`${root}/1/cover.jpg`);
        for (let n = 0; n < 4; n++) {
          await Deno.writeFile(
            `${root}/${n}/cover.png`,
            png(32, 32, colors[n]),
          );
        }
        const ids = [0, 1, 2, 3].map((n) =>
          songs.find((s) => s.path.endsWith(`/${n}/song.mp3`))!.id
        );
        const list = await playlists.create('admin', 'Grid', [
          ...ids,
          ids[0],
          'absent',
        ]);
        const wire =
          (await (await request('getPlaylist', { id: list.id })).json())[
            'subsonic-response'
          ].playlist;
        assertEquals(wire.coverArt, `pl-${list.id}`);
        const grid = await decoded(await bytes(await cover(wire.coverArt)));
        assertEquals([grid.width, grid.height], [600, 600]);
        const sample = (
          image: Awaited<ReturnType<typeof decoded>>,
          x: number,
          y: number,
        ) =>
          [...image.pixels.slice(
            y * image.stride + x * 4,
            y * image.stride + x * 4 + 3,
          )].join(',');
        assertEquals(
          new Set(
            [[150, 150], [450, 150], [150, 450], [450, 450]].map(([x, y]) =>
              sample(grid, x, y)
            ),
          ),
          new Set(colors.map((c) => c.join(','))),
        );
        assertEquals(
          (await (await request('getCoverArt', { id: wire.coverArt }, 'other'))
            .json())['subsonic-response'].error.code,
          70,
        );
        for (const count of [1, 2, 3]) {
          await playlists.setTracks('admin', list.id, ids.slice(0, count));
          const image = await decoded(await bytes(await cover(wire.coverArt)));
          assertEquals(
            [image.width, image.height],
            count === 1 ? [300, 300] : [600, 600],
          );
          if (count === 2) {
            assertEquals(sample(image, 150, 150), sample(image, 450, 450));
            assertEquals(sample(image, 450, 150), sample(image, 150, 450));
          }
          if (count === 3) {
            assertEquals(sample(image, 150, 150), sample(image, 450, 450));
          }
        }
        await playlists.setTracks('admin', list.id, ['absent']);
        assertEquals(
          await bytes(await cover(wire.coverArt)),
          await bytes(artwork.placeholder()),
        );
      },
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
