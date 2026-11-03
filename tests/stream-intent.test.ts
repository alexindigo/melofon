import { assert, assertEquals, assertRejects } from '@std/assert';
import {
  type ClientCapabilities,
  negotiate,
} from '../src/stream-negotiation.ts';
import { type AudioProfile, createMedia } from '../src/media.ts';
import { createStream, StreamError } from '../src/stream.ts';
import { UserError } from '../src/user-errors.ts';
import { authFixture } from './helpers/authentication.ts';

const videoPath =
  'tests/fixtures/library/Fixture Artist/Fixture Album/03 - Clip.mp4';
const audioPath =
  'tests/fixtures/library/Fixture Artist/Fixture Album/01 - First Song.mp3';
const capabilities: ClientCapabilities = {
  name: 'Player',
  platform: 'Test',
  directPlayProfiles: [{
    containers: [],
    audioCodecs: [],
    protocols: ['http'],
  }],
  transcodingProfiles: [{
    container: 'mp3',
    audioCodec: 'mp3',
    protocol: 'http',
  }],
};

Deno.test('stream intent: direct originals and audio-only encoders obey the requested intent', () => {
  const source = {
    protocol: 'http',
    container: 'mp4',
    codec: 'aac',
    audioChannels: 2,
    audioSamplerate: 44100,
    audioBitrate: 96000,
  };
  const profiles: AudioProfile[] = [{
    format: 'mp3',
    container: 'mp3',
    codec: 'mp3',
    contentType: 'audio/mpeg',
    bitRateKbps: 128,
    sampleRates: [22050, 44100],
    channelCounts: [1, 2],
  }];
  const audio = negotiate(source, capabilities, profiles, {
    intent: 'audio',
    hasVideo: true,
  });
  assertEquals([audio.canDirectPlay, audio.canTranscode], [false, true]);
  assertEquals(audio.selection?.kind, 'transcode');
  const original = negotiate(source, capabilities, profiles, {
    intent: 'video',
    hasVideo: true,
  });
  assertEquals(original.selection, { kind: 'direct', intent: 'video' });
  const incompatible = negotiate(
    source,
    { ...capabilities, directPlayProfiles: [] },
    profiles,
    { intent: 'video', hasVideo: true },
  );
  assertEquals([
    incompatible.canDirectPlay,
    incompatible.canTranscode,
    incompatible.selection,
  ], [false, false, undefined]);
  assert(incompatible.errorReason);
  assertEquals(
    negotiate(source, capabilities, profiles, {
      intent: 'video',
      hasVideo: false,
    }).selection,
    undefined,
  );
  assertEquals(
    negotiate(source, capabilities, [], { intent: 'audio', hasVideo: true })
      .selection,
    undefined,
  );
});

Deno.test('stream intent: current session prepares and executes without transport playback identity', async () => {
  const f = await authFixture();
  try {
    const first = await f.signIn();
    const second = await f.signIn();
    const media = createMedia(undefined, f.state);
    const stream = createStream(
      media,
      f.cfg,
      undefined,
      undefined,
      f.auth.sessions,
    );
    const video = { path: videoPath, isVideo: true };
    const audio = { path: audioPath, isVideo: false };
    const request = () => new Request('http://melofon.home/media');
    const original = await stream.decision(
      video,
      capabilities,
      'admin',
      'video',
    );
    assertEquals(original!.canDirectPlay, true);
    const videoResponse = await stream.negotiated(
      request(),
      video,
      original!.transcodeParams,
      'admin',
    );
    assertEquals(
      new Uint8Array(await videoResponse.arrayBuffer()),
      await Deno.readFile(videoPath),
    );
    await f.auth.sessions.replacePlaybackCapabilities(
      f.admin.id,
      first.session.id,
      capabilities,
    );
    const direct = await stream.session(
      request(),
      audio,
      f.admin.id,
      first.session.id,
    );
    assertEquals(
      new Uint8Array(await direct.arrayBuffer()),
      await Deno.readFile(audioPath),
    );
    const selected = await stream.decision(audio, capabilities, 'admin');
    const staleRange = () =>
      new Request('http://melofon.home/media', {
        headers: { Range: 'bytes=0-31', 'If-Range': '"stale"' },
      });
    // The shared original-file owner enforces If-Range for every adapter.
    for (
      const read of [
        () => stream.file(staleRange(), audioPath),
        () => stream.play(staleRange(), audio, 'raw'),
        () =>
          stream.negotiated(
            staleRange(),
            audio,
            selected!.transcodeParams,
            'admin',
          ),
      ]
    ) {
      const response = (await read())!;
      assertEquals(response.status, 200);
      assertEquals(
        new Uint8Array(await response.arrayBuffer()),
        await Deno.readFile(audioPath),
      );
    }
    const limited = {
      ...capabilities,
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
            comparison: 'Equals',
            values: ['22050'],
            required: true,
          },
          {
            name: 'audioBitrate',
            comparison: 'Equals',
            values: ['64000'],
            required: true,
          },
        ],
      }],
    };
    await f.auth.sessions.replacePlaybackCapabilities(
      f.admin.id,
      first.session.id,
      limited,
    );
    const receive = async (file = video, sessionId = first.session.id) => {
      const response = await stream.session(
        request(),
        file,
        f.admin.id,
        sessionId,
      );
      const path = `${f.dir}/received.mp3`;
      await Deno.writeFile(path, new Uint8Array(await response.arrayBuffer()));
      assertEquals((await media.probe(path)).hasVideo, false);
      const pcm = await media.decodePcm(path);
      assert(pcm);
      let bytes = 0;
      for await (const chunk of pcm) bytes += chunk.length;
      assert(bytes > 0);
      return (await media.describeAudio(path))!;
    };
    const actual = await receive();
    assertEquals([
      actual.codec,
      actual.audioChannels,
      actual.audioSamplerate,
      actual.audioBitrate,
    ], ['mp3', 1, 22050, 64000]);
    // Actual source probing also protects callers with a stale/non-video flag.
    assertEquals(
      (await receive({ ...video, isVideo: false })).audioChannels,
      1,
    );
    const fallback = await receive(video, second.session.id);
    assertEquals(fallback.codec, 'mp3');
    assertEquals(
      fallback.audioSamplerate,
      44100,
      'one login declaration does not constrain another',
    );
    await f.auth.sessions.replacePlaybackCapabilities(
      f.admin.id,
      first.session.id,
      {
        name: 'Unsupported',
        platform: 'Test',
        transcodingProfiles: [{
          container: 'unknown',
          audioCodec: 'unknown',
          protocol: 'http',
        }],
      },
    );
    await assertRejects(
      () => stream.session(request(), video, f.admin.id, first.session.id),
      StreamError,
      'no compatible',
    );
    const noEncoder = createStream(
      {
        ...media,
        audioProfiles: () => Promise.resolve([]),
      },
      f.cfg,
      undefined,
      undefined,
      f.auth.sessions,
    );
    await assertRejects(
      () => noEncoder.session(request(), video, f.admin.id, second.session.id),
      StreamError,
      'no compatible',
    );
    await assertRejects(
      () =>
        stream.session(request(), video, 'not-the-owner', second.session.id),
      UserError,
      'forbidden',
    );
    await f.auth.sessions.revoke(f.admin.id, second.session.id);
    await assertRejects(
      () => stream.session(request(), video, f.admin.id, second.session.id),
      UserError,
      'not_found',
    );
  } finally {
    await f.close();
  }
});
