import { assert, assertEquals } from '@std/assert';
import { AUTH, setupH5 } from './h5-helpers.ts';

Deno.test('media form POST: catalog raw/direct stream, original download and negotiated direct stream preserve ranges', async () => {
  const s = await setupH5();
  const server = Deno.serve(
    { hostname: '127.0.0.1', port: 0, onListen() {} },
    s.app,
  );
  try {
    const root = `http://127.0.0.1:${server.addr.port}/rest`;
    const decision = await fetch(
      `${root}/getTranscodeDecision.view?${AUTH}&mediaId=${s.id}&mediaType=song`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Form POST consumer',
          platform: 'test',
          directPlayProfiles: [{
            containers: ['wav'],
            audioCodecs: ['pcm_s16le'],
            protocols: ['http'],
            maxAudioChannels: 2,
          }],
          transcodingProfiles: [],
        }),
      },
    );
    assertEquals(decision.status, 200);
    const result = (await decision.json())['subsonic-response'];
    assertEquals(result.status, 'ok');
    assertEquals(result.transcodeDecision.canDirectPlay, true);
    const token = result.transcodeDecision.transcodeParams;
    assert(token);
    const targets: [string, Record<string, string>][] = [
      ['stream', { id: s.id, format: 'raw' }],
      ['stream', { id: s.id }],
      ['download', { id: s.id, format: 'opus' }],
      ['getTranscodeStream', {
        mediaId: s.id,
        mediaType: 'song',
        transcodeParams: token,
      }],
    ];
    for (const [op, params] of targets) {
      for (const ranged of [false, true]) {
        const body = new URLSearchParams(AUTH);
        for (const [key, value] of Object.entries(params)) body.set(key, value);
        const response = await fetch(`${root}/${op}.view`, {
          method: 'POST',
          body,
          headers: ranged ? { range: 'bytes=4-99' } : undefined,
        });
        assertEquals(response.status, ranged ? 206 : 200, op);
        assertEquals(response.headers.get('accept-ranges'), 'bytes', op);
        if (ranged) {
          assertEquals(
            response.headers.get('content-range'),
            `bytes 4-99/${s.wav.length}`,
          );
        }
        assertEquals(
          new Uint8Array(await response.arrayBuffer()),
          ranged ? s.wav.slice(4, 100) : s.wav,
          op,
        );
      }
    }
    assertEquals(s.counts().started, 0);
  } finally {
    await server.shutdown();
    await s.close();
  }
});
