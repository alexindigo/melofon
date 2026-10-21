import { assert, assertEquals } from '@std/assert';
import { AUTH, decoded, setupH5 } from './h5-helpers.ts';

const target = (container = 'mp3', audioCodec = 'mp3', protocol = 'http') => ({
  container,
  audioCodec,
  protocol,
  maxAudioChannels: 2,
});
const info = (extra = {}) => ({
  name: 'H5 player',
  platform: 'test',
  directPlayProfiles: [],
  transcodingProfiles: [target()],
  ...extra,
});
type Setup = Awaited<ReturnType<typeof setupH5>>;
async function decision(s: Setup, body: unknown, extra = '') {
  const response = await s.request(
    'getTranscodeDecision.view',
    `&mediaId=${s.id}&mediaType=song${extra}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  assertEquals(response.status, 200);
  return (await response.json())['subsonic-response'];
}
const stream = (s: Setup, token: string, extra = '') =>
  s.request(
    'getTranscodeStream.view',
    `&mediaId=${s.id}&mediaType=song&transcodeParams=${token}${extra}`,
  );

Deno.test('H5 transcoding: direct play decision and original fixed-byte stream', async () => {
  const s = await setupH5();
  try {
    const result = await decision(
      s,
      info({
        directPlayProfiles: [{
          containers: ['wav'],
          audioCodecs: ['pcm_s16le'],
          protocols: ['http'],
          maxAudioChannels: 2,
        }],
      }),
    );
    assertEquals(result.status, 'ok');
    const d = result.transcodeDecision;
    assertEquals([d.canDirectPlay, d.canTranscode], [true, false]);
    assertEquals(d.sourceStream.container, 'wav');
    assertEquals(d.sourceStream.audioChannels, 2);
    assertEquals(d.sourceStream.audioSamplerate, 44100);
    assertEquals(d.sourceStream.audioBitrate, 1411200);
    assertEquals(d.sourceStream.audioBitdepth, 16);
    assertEquals(d.selection, undefined);
    assertEquals(
      new Uint8Array(
        await (await stream(s, d.transcodeParams, '&offset=2')).arrayBuffer(),
      ),
      s.wav,
    );
  } finally {
    await s.close();
  }
});

for (
  const [container, codec, token] of [
    ['mp3', 'mp3', 'mp3'],
    ['aac', 'aac', 'aac'],
    ['ogg', 'opus', 'opus'],
    ['ogg', 'vorbis', 'ogg'],
  ]
) {
  Deno.test(`H5 transcoding: negotiated ${codec} decodes at requested offset and bitrate`, async () => {
    const s = await setupH5();
    try {
      const result = await decision(
        s,
        info({
          maxAudioBitrate: 96000,
          maxTranscodingAudioBitrate: 64000,
          directPlayProfiles: [{
            containers: [],
            audioCodecs: [],
            protocols: [],
          }],
          transcodingProfiles: [
            target('flac', 'flac', 'hls'),
            target(container, codec),
          ],
        }),
      );
      assertEquals(result.status, 'ok');
      const d = result.transcodeDecision;
      assertEquals([d.canDirectPlay, d.canTranscode], [false, true]);
      assertEquals(d.transcodeReason.length, 1);
      assertEquals(d.transcodeStream.container, container);
      assertEquals(d.transcodeStream.codec, codec);
      assertEquals(d.transcodeStream.audioBitrate, 64000);
      assert(d.transcodeParams && /^[A-Za-z0-9_.-]+$/.test(d.transcodeParams));
      const output = await decoded(
        s,
        await stream(s, d.transcodeParams, '&offset=2'),
        token,
        2,
      );
      if (token === 'mp3' || token === 'aac') {
        assert(
          output.probe.bitrateKbps! < 80,
          'actual encoded body honors the negotiated 64 kbps cap',
        );
      }
    } finally {
      await s.close();
    }
  });
}

Deno.test('H5 transcoding: codec limitations are fitted and observed by the consumer', async () => {
  const s = await setupH5();
  try {
    const result = await decision(
      s,
      info({
        codecProfiles: [{
          type: 'AudioCodec',
          name: 'mp3',
          limitations: [
            {
              name: 'audioChannels',
              comparison: 'Equals',
              values: ['1'],
              required: true,
            },
            {
              name: 'audioSamplerate',
              comparison: 'LessThanEqual',
              values: ['22050'],
              required: true,
            },
            {
              name: 'audioBitrate',
              comparison: 'LessThanEqual',
              values: ['64000'],
              required: true,
            },
          ],
        }],
      }),
    );
    const d = result.transcodeDecision;
    assertEquals([d.canDirectPlay, d.canTranscode], [false, true]);
    assertEquals([
      d.transcodeStream.audioChannels,
      d.transcodeStream.audioSamplerate,
      d.transcodeStream.audioBitrate,
    ], [1, 22050, 64000]);
    const response = await stream(s, d.transcodeParams);
    const path = `${s.dir}/limited.mp3`;
    await Deno.writeFile(path, new Uint8Array(await response.arrayBuffer()));
    const actual = await s.media.describeAudio(path);
    assertEquals(actual!.audioChannels, 1);
    assertEquals(actual!.audioSamplerate, 22050);
    assertEquals(actual!.audioBitrate, 64000);
    const audio = await s.media.decodePcm(path);
    assert(audio);
    let bytes = 0;
    for await (const chunk of audio) bytes += chunk.length;
    assert(bytes > 44100 * 4 * 5);
  } finally {
    await s.close();
  }
});

Deno.test('H5 transcoding: required errors, invalid ClientInfo, media types and incompatible profiles', async () => {
  const s = await setupH5();
  try {
    const get = await s.request('getTranscodeDecision');
    assertEquals(get.status, 405);
    assertEquals(get.headers.get('allow'), 'POST');
    for (
      const body of [
        null,
        {},
        {
          name: 'x',
          platform: 'x',
          directPlayProfiles: [{ protocols: ['ftp'] }],
        },
        info({ codecProfiles: [{ type: 'VideoCodec', name: 'x' }] }),
        info({ maxAudioBitrate: 1.5 }),
      ]
    ) {
      assertEquals((await decision(s, body)).error.code, 0);
    }
    const malformed = await s.request(
      'getTranscodeDecision',
      `&mediaId=${s.id}&mediaType=song`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{',
      },
    );
    assertEquals((await malformed.json())['subsonic-response'].error.code, 0);
    const podcast = await s.request(
      'getTranscodeDecision',
      '&mediaId=x&mediaType=podcast',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(info()),
      },
    );
    assertEquals((await podcast.json())['subsonic-response'].error.code, 0);
    for (
      const parameters of ['', `&mediaId=${s.id}`, '&mediaId=x&mediaType=song']
    ) {
      const response = await s.request('getTranscodeDecision', parameters, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(info()),
      });
      assertEquals(
        (await response.json())['subsonic-response'].error.code,
        parameters.includes('mediaType') ? 70 : 10,
      );
    }
    const impossible = (await decision(
      s,
      info({
        transcodingProfiles: [target('mp4', 'aac'), target('flac', 'flac')],
      }),
    )).transcodeDecision;
    assertEquals([
      impossible.canDirectPlay,
      impossible.canTranscode,
      impossible.transcodeParams,
    ], [false, false, '']);
    assert(impossible.errorReason);
    for (
      const parameters of [
        '',
        '&mediaType=podcast&mediaId=x&transcodeParams=x',
        '&mediaType=song&mediaId=x&transcodeParams=x',
      ]
    ) {
      const response = await s.request('getTranscodeStream', parameters);
      assertEquals(
        response.status,
        parameters.includes('mediaType=song') ? 404 : 400,
      );
      assert(!(await response.text()).includes('subsonic-response'));
    }
  } finally {
    await s.close();
  }
});

Deno.test('H5 transcoding: tampered, cross-media, stale and cross-user params are refused', async () => {
  const s = await setupH5();
  try {
    const d = (await decision(s, info())).transcodeDecision;
    const [payload, mac] = d.transcodeParams.split('.');
    const altered = `${payload}.${mac[0] === 'a' ? 'b' : 'a'}${mac.slice(1)}`;
    assertEquals((await stream(s, altered)).status, 410);
    assertEquals((await stream(s, `${payload}.${mac}.extra`)).status, 410);
    const other = await s.app(
      new Request(
        `http://x/rest/getTranscodeStream?${AUTH}&mediaId=${s.videoId}&mediaType=song&transcodeParams=${d.transcodeParams}`,
      ),
    );
    assertEquals(other.status, 410);
    const denied = await s.app(
      new Request(
        `http://x/rest/getTranscodeStream?${
          AUTH.replace('u=admin', 'u=other')
        }&mediaId=${s.id}&mediaType=song&transcodeParams=${d.transcodeParams}`,
      ),
    );
    assertEquals(denied.status, 410);
    const path = `${s.dir}/library/landmarks.wav`;
    await Deno.utime(path, new Date(), new Date(Date.now() + 1000));
    assertEquals((await stream(s, d.transcodeParams)).status, 410);
  } finally {
    await s.close();
  }
});

Deno.test('H5 extensions advertise implemented offset and transcoding versions', async () => {
  const s = await setupH5();
  try {
    const response = await s.request('getOpenSubsonicExtensions');
    const extensions =
      (await response.json())['subsonic-response'].openSubsonicExtensions;
    assertEquals(extensions, [
      { name: 'formPost', versions: [1] },
      { name: 'transcodeOffset', versions: [1] },
      { name: 'transcoding', versions: [1] },
      { name: 'songLyrics', versions: [1, 2] },
      { name: 'indexBasedQueue', versions: [1] },
      { name: 'playbackReport', versions: [1] },
      { name: 'topSongsByArtistId', versions: [1] },
      { name: 'getPodcastEpisode', versions: [1] },
    ]);
  } finally {
    await s.close();
  }
});
