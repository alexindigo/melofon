import { assert, assertEquals, assertRejects } from '@std/assert';
import { createMedia } from '../src/media.ts';
import { createNetwork } from '../src/lookups/net.ts';
import { createRadioSource } from '../src/radio-source.ts';
import { createPlaybackSource } from '../src/playback-source.ts';
import { createQueueResolver } from '../src/queue-source.ts';
import { httpRadio, icyBlock, type RadioReply } from './helpers/http-radio.ts';
import { until } from './helpers/speaker-consumer.ts';

const encode = (text: string) => new TextEncoder().encode(text);
const resolve = createQueueResolver({
  getSong: () => Promise.resolve(null),
  getStation: () => Promise.resolve(null),
});
async function urlMedia(url: string) {
  const result = await resolve({ kind: 'url', url });
  assert(result);
  return result;
}
async function collect(pcm: AsyncIterable<Uint8Array> | null) {
  assert(pcm);
  const parts = [];
  for await (const part of pcm) parts.push(part);
  const bytes = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  return bytes;
}
const signal = () => new AbortController().signal;

Deno.test('playback source composes direct MP3/AAC and nested playlist ICY into exact PCM', async () => {
  const media = createMedia();
  const dir = await Deno.makeTempDir({ prefix: 'playback-source-' });
  try {
    for (const format of ['mp3', 'aac']) {
      const encoded = await media.transcodeAudio(
        'tests/fixtures/media/clip.flac',
        format,
      );
      assert(encoded);
      const audio = new Uint8Array(
        await new Response(encoded.stream).arrayBuffer(),
      );
      await encoded.completion;
      const file = `${dir}/stream.${format}`;
      await Deno.writeFile(file, audio);
      const expected = await collect(await media.decodePcm(file));
      const server = httpRadio((request): RadioReply => {
        const path = new URL(request.url).pathname;
        if (path === '/station.pls') {
          return { body: [encode('[playlist]\nFile1=/redirect\n')] };
        }
        if (path === '/redirect') {
          return {
            statusLine: 'HTTP/1.1 302 Found',
            headers: { location: '/nested/list.m3u' },
          };
        }
        if (path === '/nested/list.m3u') return { body: [encode('../audio')] };
        return {
          headers: { 'content-type': 'text/html', 'icy-metaint': '997' },
          body: (function* () {
            for (let at = 0; at < audio.length; at += 997) {
              yield audio.subarray(at, at + 997);
              if (at + 997 <= audio.length) {
                yield icyBlock("StreamTitle='Never audio';");
              }
            }
          })(),
        };
      });
      try {
        const sources = createPlaybackSource({
          media,
          radio: createRadioSource({ network: createNetwork() }),
        });
        for (const path of ['/audio', '/station.pls']) {
          const input = await urlMedia(`${server.origin}${path}`);
          assertEquals(
            await collect(
              await sources.open(input, { signal: signal(), startMs: 5000 }),
            ),
            expected,
          );
        }
        assertEquals(server.requests.map((r) => new URL(r.url).pathname), [
          '/audio',
          '/station.pls',
          '/redirect',
          '/nested/list.m3u',
          '/audio',
        ]);
        await until(() => server.closed === 5);
      } finally {
        await server.close();
      }
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('playback source abort cancels parked resolution and media probing without a replacement request', async () => {
  for (const prefix of [new Uint8Array(), encode('ID3')]) {
    let parked = false;
    const server = httpRadio((_request, disconnected) => ({
      body: (async function* () {
        if (prefix.length) yield prefix;
        parked = true;
        await new Promise<void>((done) =>
          disconnected.addEventListener('abort', () => done(), { once: true })
        );
      })(),
    }));
    const controller = new AbortController();
    try {
      const sources = createPlaybackSource({
        media: createMedia(),
        radio: createRadioSource({ network: createNetwork() }),
      });
      const opening = sources.open(await urlMedia(`${server.origin}/parked`), {
        signal: controller.signal,
        startMs: 0,
      });
      const failed = assertRejects(
        () => opening,
        Error,
        'Cancelled activation',
      );
      await until(() => parked);
      controller.abort(new Error('Cancelled activation'));
      await failed;
      await until(() => server.closed === 1);
      assertEquals(server.requests.length, 1);
    } finally {
      controller.abort();
      await server.close();
    }
  }
});

Deno.test('playback source rejects HLS, legacy ICY, bad ICY and non-audio, releasing every connection', async () => {
  let forbidden = 0;
  const server = httpRadio((request) => {
    const path = new URL(request.url).pathname;
    if (path === '/legacy') {
      return { statusLine: 'ICY 200 OK', body: [encode('not HTTP')] };
    }
    if (path === '/bad-icy') {
      return { headers: { 'icy-metaint': '0' }, body: [encode('bad framing')] };
    }
    if (path === '/child') forbidden++;
    return {
      body: [encode(
        path === '/hls.m3u'
          ? '#EXTM3U\n#EXT-X-TARGETDURATION:1\n/child\n'
          : '<html>not audio</html>',
      )],
    };
  });
  try {
    const sources = createPlaybackSource({
      media: createMedia(),
      radio: createRadioSource({ network: createNetwork() }),
    });
    for (const path of ['/hls.m3u', '/legacy', '/bad-icy', '/page']) {
      const input = await urlMedia(`${server.origin}${path}`);
      await assertRejects(() =>
        sources.open(input, { signal: signal(), startMs: 0 })
      );
    }
    await until(() => server.closed === 4);
    assertEquals(forbidden, 0);
    assertEquals(server.requests.length, 4);
  } finally {
    await server.close();
  }
});

Deno.test('playback source retains original host trust across playlist composition', async () => {
  const target = httpRadio(() => ({ body: [encode('must never be read')] }));
  const server = httpRadio(() => ({
    body: [
      encode(target.origin.replace('melofon.home', '127.0.0.1') + '/audio'),
    ],
  }));
  try {
    const sources = createPlaybackSource({
      media: createMedia(),
      radio: createRadioSource({ network: createNetwork() }),
    });
    const input = await urlMedia(`${server.origin}/station.m3u`);
    assert(input.facts.kind === 'web');
    // Derived runtime facts can never promote an external host to entered trust.
    input.facts.url = target.origin.replace('melofon.home', '127.0.0.1') +
      '/audio';
    await assertRejects(() =>
      sources.open(input, { signal: signal(), startMs: 0 })
    );
    assertEquals(target.requests.length, 0);
    await until(() => server.closed === 1);
  } finally {
    await server.close();
    await target.close();
  }
});
