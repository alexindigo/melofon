import { assert, assertEquals } from '@std/assert';
import { decoded, setupH5 } from './h5-helpers.ts';

for (
  const [format, codec] of [['mp3', 'mp3'], ['aac', 'aac'], ['opus', 'opus'], [
    'ogg',
    'ogg',
  ]]
) {
  Deno.test(`H5 ${format}: zero cap, decoded seek landmark and live Range contract`, async () => {
    const s = await setupH5();
    try {
      const response = await s.request(
        'stream',
        `&format=${format}&maxBitRate=0&timeOffset=2`,
        { headers: { range: 'bytes=0-99' } },
      );
      assertEquals(response.headers.get('accept-ranges'), 'none');
      assertEquals(response.headers.get('content-length'), null);
      assertEquals(response.headers.get('x-content-duration'), '6');
      await decoded(s, response, codec, 2);
    } finally {
      await s.close();
    }
  });
}

Deno.test('H5 raw and direct play ignore offsets; fixed Range and original download', async () => {
  const s = await setupH5();
  try {
    for (const extra of ['', '&format=raw']) {
      const response = await s.request('stream', `${extra}&timeOffset=999`);
      assertEquals(new Uint8Array(await response.arrayBuffer()), s.wav);
      const range = await s.request('stream', `${extra}&timeOffset=2`, {
        headers: { range: 'bytes=4-99' },
      });
      assertEquals(range.status, 206);
      assertEquals(
        new Uint8Array(await range.arrayBuffer()),
        s.wav.slice(4, 100),
      );
    }
    const download = await s.request('download', '&format=mp3&timeOffset=2');
    assertEquals(new Uint8Array(await download.arrayBuffer()), s.wav);
    const range = await s.request('download', '', {
      headers: { range: 'bytes=4-99' },
    });
    assertEquals(range.status, 206);
    assertEquals(
      new Uint8Array(await range.arrayBuffer()),
      s.wav.slice(4, 100),
    );
  } finally {
    await s.close();
  }
});

Deno.test('H5 HEAD matches GET headers without starting a transcode; estimate is opt-in', async () => {
  const s = await setupH5();
  try {
    for (const op of ['stream', 'download']) {
      for (const estimate of ['', '&estimateContentLength=true']) {
        const before = s.counts().started;
        const head = await s.request(op, `&format=mp3${estimate}`, {
          method: 'HEAD',
        });
        assertEquals(head.status, 200);
        assertEquals((await head.arrayBuffer()).byteLength, 0);
        assertEquals(s.counts().started, before);
        const get = await s.request(op, `&format=mp3${estimate}`);
        for (
          const header of [
            'content-type',
            'content-length',
            'accept-ranges',
            'x-content-duration',
            'content-disposition',
          ]
        ) {
          assertEquals(
            head.headers.get(header),
            get.headers.get(header),
            header,
          );
        }
        if (op === 'stream') {
          assertEquals(
            get.headers.get('content-length'),
            estimate ? String(Math.trunc(6 * 192 / 8 * 1024)) : null,
          );
        }
        await get.arrayBuffer();
      }
    }
  } finally {
    await s.close();
  }
});

Deno.test('H5 invalid offsets become zero; beyond EOF is empty 200; unknown targets use mp3', async () => {
  const s = await setupH5();
  try {
    for (const offset of ['-1', '1.5', 'nope']) {
      await decoded(
        s,
        await s.request('stream', `&format=mp3&timeOffset=${offset}`),
        'mp3',
        0,
      );
    }
    const beyond = await s.request('stream', '&format=mp3&timeOffset=99');
    assertEquals(beyond.status, 200);
    assertEquals((await beyond.arrayBuffer()).byteLength, 0);
    assertEquals(s.events, ['stream_empty']);
    for (const target of ['flac', 'nonsense']) {
      await decoded(s, await s.request('stream', `&format=${target}`), 'mp3');
    }
  } finally {
    await s.close();
  }
});

Deno.test('H5 video defaults to audio only; raw and matching video container keep original bytes', async () => {
  const s = await setupH5();
  try {
    for (const format of ['', '&format=unknown']) {
      await decoded(
        s,
        await s.app(
          new Request(
            `http://x/rest/stream?u=admin&p=test&v=1.16.1&c=h5&id=${s.videoId}${format}`,
          ),
        ),
        'mp3',
      );
    }
    for (const format of ['raw', 'mp4']) {
      const r = await s.app(
        new Request(
          `http://x/rest/stream?u=admin&p=test&v=1.16.1&c=h5&id=${s.videoId}&format=${format}`,
        ),
      );
      assertEquals(
        new Uint8Array(await r.arrayBuffer()),
        await Deno.readFile(`${s.dir}/library/clip.mp4`),
      );
    }
  } finally {
    await s.close();
  }
});

Deno.test('H5 real HTTP disconnect cancels native transcode work', async () => {
  const s = await setupH5();
  const server = Deno.serve(
    { port: 0, hostname: '127.0.0.1', onListen() {} },
    s.app,
  );
  try {
    const controller = new AbortController();
    const response = await fetch(
      `http://127.0.0.1:${server.addr.port}/rest/stream?u=admin&p=test&v=1.16.1&c=h5&id=${s.id}&format=opus`,
      { signal: controller.signal },
    );
    const reader = response.body!.getReader();
    assert(!(await reader.read()).done);
    controller.abort();
    await reader.cancel().catch(() => {});
    for (let i = 0; i < 100 && s.counts().active !== 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assertEquals(
      s.counts().active,
      0,
      'native transcode completion must settle after disconnect',
    );
  } finally {
    await server.shutdown();
    await s.close();
  }
});
