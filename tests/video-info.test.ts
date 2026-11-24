import { assert, assertEquals, assertMatch } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { AV_CODEC_ID_MOV_TEXT, Demuxer, Dictionary, Muxer } from 'node-av';
import { Buffer } from 'node:buffer';
import { openStore } from '../src/store/index.ts';
import { rawSql } from '../src/store/testing.ts';
import { seedFirstUser } from '../src/users.ts';
import { scanLibrary } from '../src/scan.ts';
import { createLibraries } from '../src/libraries.ts';
import { createLibrary } from '../src/library.ts';
import { createUserService } from '../src/user.ts';
import { createAnnotation } from '../src/annotation.ts';
import { createListens } from '../src/listens.ts';
import { createState } from '../src/state.ts';
import { loadLayers } from '../src/layers.ts';
import { facade } from '../src/facade.ts';

const CLIP =
  'tests/fixtures/library/Fixture Artist/Fixture Album/03 - Clip.mp4';
const SONG =
  'tests/fixtures/library/Fixture Artist/Fixture Album/01 - First Song.mp3';
const SRT =
  '1\n00:00:00,125 --> 00:00:01,625\nSidecar <i>Hello</i>\nsecond line\n\n';
const VTT =
  'WEBVTT\n\ncue-id\n00:00.250 --> 00:01.750 align:start\nVTT reverse\n\n';

// node-av exposes no subtitle encoder. Remux its real H.264/AAC clip with
// two independently indexed audio streams and real demuxed text subtitles.
async function fixture(dir: string) {
  const subtitle = `${dir}/embedded.srt`;
  await Deno.writeTextFile(
    subtitle,
    SRT.replace('Sidecar <i>Hello</i>', 'Embedded text'),
  );
  const assPath = `${dir}/embedded.ass`;
  await Deno.writeTextFile(
    assPath,
    `[Script Info]\nScriptType: v4.00+\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,2,10,10,10,1\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.25,0:00:01.75,Default,,0,0,0,,{\\i1}ASS text{\\i0}\\Nwith, comma\n`,
  );
  await using input = await Demuxer.open(CLIP);
  await using sub = await Demuxer.open(subtitle);
  await using ass = await Demuxer.open(assPath);
  await Deno.writeTextFile(`${dir}/embedded.vtt`, VTT);
  await using vtt = await Demuxer.open(`${dir}/embedded.vtt`);
  await using output = await Muxer.open(`${dir}/a/clip.mkv`, {
    format: 'matroska',
    input,
    configure(ctx) {
      // Codec tags are container-specific (MP4's mp4a is not a Matroska tag).
      for (const stream of ctx.streams) stream.codecpar.codecTag = 0;
      for (
        const [i, tags] of [
          [1, { language: 'eng', title: 'English & original' }],
          [2, { language: 'fra', title: 'French' }],
          [3, { language: 'eng', title: 'Embedded' }],
          [4, { language: 'fra', title: 'Styled' }],
          [5, { language: 'fra', title: 'Embedded VTT' }],
        ] as const
      ) {
        using dictionary = Dictionary.fromObject(tags);
        ctx.streams[i].metadata = dictionary;
      }
    },
  });
  const video = output.addStream(input.video()!);
  const audio1 = output.addStream(input.audio()!);
  const audio2 = output.addStream(input.audio()!);
  const caption = output.addStream(sub.streams[0]);
  const styled = output.addStream(ass.streams[0]);
  const webvtt = output.addStream(vtt.streams[0]);
  for await (const packet of input.packets()) {
    if (!packet) continue;
    try {
      if (packet.streamIndex === input.video()!.index) {
        await output.writePacket(packet, video);
      } else if (packet.streamIndex === input.audio()!.index) {
        using copy = packet.clone();
        await output.writePacket(packet, audio1);
        await output.writePacket(copy, audio2);
      }
    } finally {
      packet.free();
    }
  }
  for (
    const [source, index] of [[sub, caption], [ass, styled], [
      vtt,
      webvtt,
    ]] as const
  ) {
    for await (const packet of source.packets()) {
      if (!packet) continue;
      try {
        await output.writePacket(packet, index);
      } finally {
        packet.free();
      }
    }
  }
  await output.close();
  // MOV text is length-prefixed UTF-8. Author valid packets directly because
  // node-av's frame encoder does not expose avcodec_encode_subtitle.
  await using clip = await Demuxer.open(CLIP);
  await using text = await Demuxer.open(subtitle);
  text.streams[0].codecpar.codecId = AV_CODEC_ID_MOV_TEXT;
  text.streams[0].codecpar.codecTag = 0;
  await using mp4 = await Muxer.open(`${dir}/b/mov-text.mp4`, {
    format: 'mp4',
  });
  const vi = mp4.addStream(clip.video()!);
  const ai = mp4.addStream(clip.audio()!);
  const si = mp4.addStream(text.streams[0]);
  for await (const packet of clip.packets()) {
    if (!packet) continue;
    try {
      await mp4.writePacket(
        packet,
        packet.streamIndex === clip.video()!.index ? vi : ai,
      );
    } finally {
      packet.free();
    }
  }
  for await (const packet of text.packets()) {
    if (!packet) continue;
    try {
      const payload = Buffer.from('MOV text');
      const length = Buffer.alloc(2);
      length.writeUInt16BE(payload.length);
      packet.data = Buffer.concat([length, payload]);
      await mp4.writePacket(packet, si);
    } finally {
      packet.free();
    }
  }
  await mp4.close();
}

interface Info {
  id: string;
  captions: { id: string; name: string }[];
  audioTrack: { id: string; name: string; languageCode?: string }[];
  conversion?: unknown;
}

Deno.test('video facts and captions survive scan, upgrade and HTTP JSON/XML consumers', async (t) => {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-video-info-' });
  await Deno.mkdir(`${dir}/a`);
  await Deno.mkdir(`${dir}/b`);
  let store = await openStore(`${dir}/db`);
  // Real old-install shape: opening upgrades it without changing existing rows.
  await rawSql(store).run('ALTER TABLE files DROP COLUMN video_details');
  await store.close();
  store = await openStore(`${dir}/db`);
  const cfg = {
    listen: undefined,
    dataDir: dir,
    user: 'admin',
    password: 'test',
    secret: 'video-secret',
    version: 'test',
  };
  await seedFirstUser(store, cfg);
  await fixture(dir);
  await Deno.copyFile(CLIP, `${dir}/b/other.mp4`);
  await Deno.copyFile(SONG, `${dir}/a/audio.mp3`);
  await Deno.writeTextFile(`${dir}/a/clip.en.srt`, SRT);
  await Deno.writeTextFile(`${dir}/a/clip.fr.vtt`, VTT);
  await Deno.writeTextFile(`${dir}/a/not-clip.en.srt`, SRT);
  let libraries = createLibraries(store);
  await libraries.add('A', `${dir}/a`);
  await libraries.add('B', `${dir}/b`);
  await scanLibrary(store);
  await store.close();
  store = await openStore(`${dir}/db`);
  libraries = createLibraries(store);
  const library = createLibrary(store);
  const core = await pathfinder({ roots: ['core/'], app: { store, cfg } });
  const app = facade(
    core,
    await loadLayers({
      app: {
        cfg,
        libraries,
        library,
        state: createState(store),
        user: createUserService(store, cfg),
        annotation: createAnnotation(store),
        listens: createListens(store),
      },
    }),
  );
  const server = Deno.serve(
    { hostname: '127.0.0.1', port: 0, onListen() {} },
    app,
  );
  const request = (
    op: string,
    params: Record<string, string> = {},
    post = false,
  ) => {
    const p = new URLSearchParams({
      u: 'admin',
      p: 'test',
      c: 'video-test',
      v: '1.16.1',
      f: 'json',
      ...params,
    });
    const url = `http://127.0.0.1:${server.addr.port}/rest/${op}`;
    return fetch(
      post ? url : `${url}?${p}`,
      post ? { method: 'POST', body: p } : undefined,
    );
  };
  const json = async (op: string, p: Record<string, string> = {}) =>
    (await (await request(op, p)).json())['subsonic-response'];
  let id = '';
  let info: Info;
  try {
    await t.step(
      'catalog-scoped videos and both language-labelled audio streams; XML shapes',
      async () => {
        const folders =
          (await json('getMusicFolders')).musicFolders.musicFolder;
        const a = folders.find((f: { name: string }) => f.name === 'A');
        const b = folders.find((f: { name: string }) => f.name === 'B');
        const videos =
          (await json('getVideos', { musicFolderId: String(a.id) })).videos
            .video;
        assertEquals(videos.length, 1);
        id = videos[0].id;
        assertEquals((await json('getVideos')).videos.video.length, 3);
        assertEquals(
          (await json('getVideos', { musicFolderId: String(b.id) })).videos
            .video.length,
          2,
        );
        assertEquals(
          (await json('getVideos', { musicFolderId: '2147483647' })).videos
            .video,
          [],
        );
        info = (await json('getVideoInfo', { id })).videoInfo;
        assertEquals(info.id, id);
        assertEquals(info.audioTrack.map((a) => a.languageCode), [
          'eng',
          'fra',
        ]);
        assertEquals(info.audioTrack.map((a) => a.id), ['1', '2']);
        assertEquals(info.audioTrack[0].name, 'English & original');
        assertEquals(info.captions.length, 5);
        assertEquals(info.conversion, undefined);
        const xml = await (await request('getVideoInfo.view', { id, f: 'xml' }))
          .text();
        assertMatch(xml, /<videoInfo id="[^"]+">/);
        assertEquals((xml.match(/<captions /g) ?? []).length, 5);
        assertEquals((xml.match(/<audioTrack /g) ?? []).length, 2);
        assert(
          xml.includes('name="English &amp; original" languageCode="eng"'),
        );
        assert(!xml.includes('<conversion'));
        assert(!xml.includes(dir));
      },
    );
    await t.step(
      'raw sidecar defaults, both conversions, embedded SRT and ASS, POST and selected ids',
      async () => {
        const sidecar = info.captions.find((c) => c.name === 'en')!;
        const srt = await request('getCaptions', { id });
        assertEquals(srt.headers.get('content-type'), 'application/x-subrip');
        assertEquals(await srt.text(), SRT);
        const vtt = await request('getCaptions.view', {
          id: sidecar.id,
          format: 'vtt',
        }, true);
        assertEquals(vtt.headers.get('content-type'), 'text/vtt');
        const text = await vtt.text();
        assert(text.startsWith('WEBVTT\n\n'));
        assert(
          text.includes(
            '00:00:00.125 --> 00:00:01.625\nSidecar <i>Hello</i>\nsecond line',
          ),
        );
        const reverse = await request('getCaptions', {
          id: info.captions.find((c) => c.name === 'fr')!.id,
          format: 'srt',
        });
        assertEquals(
          await reverse.text(),
          '1\n00:00:00,250 --> 00:00:01,750\nVTT reverse\n\n',
        );
        const embedded = await request('getCaptions', {
          id: info.captions.find((c) => c.name === 'Embedded')!.id,
        });
        assertEquals(
          await embedded.text(),
          SRT.replace('Sidecar <i>Hello</i>', 'Embedded text'),
        );
        const styled = await request('getCaptions', {
          id: info.captions.find((c) => c.name === 'Styled')!.id,
          format: 'vtt',
        });
        assertEquals(
          await styled.text(),
          'WEBVTT\n\n00:00:00.250 --> 00:00:01.750\nASS text\nwith, comma\n\n',
        );
        const embeddedVtt = await request('getCaptions', {
          id: info.captions.find((c) => c.name === 'Embedded VTT')!.id,
        });
        assertEquals(embeddedVtt.headers.get('content-type'), 'text/vtt');
        assertEquals(
          await embeddedVtt.text(),
          'WEBVTT\n\n00:00:00.250 --> 00:00:01.750\nVTT reverse\n\n',
        );
        const mov = (await library.videos()).find((s) =>
          s.path.endsWith('mov-text.mp4')
        )!;
        const movInfo: Info =
          (await json('getVideoInfo', { id: mov.id })).videoInfo;
        assertEquals(movInfo.captions.length, 1);
        const movCaption = await request('getCaptions', {
          id: movInfo.captions[0].id,
        });
        assertEquals(
          await movCaption.text(),
          '1\n00:00:00,125 --> 00:00:01,625\nMOV text\n\n',
        );
      },
    );
    await t.step(
      'errors do not expose paths; rescan reconciles sidecar changes without renumbering ids',
      async () => {
        const song = (await library.listSongs({ offset: 0, size: 10 })).find((
          s,
        ) => !s.isVideo)!;
        for (
          const bad of [
            'absent',
            song.id,
            `${id}:stream:999`,
            `${id}:sidecar:../../outside.srt`,
          ]
        ) {
          assertEquals((await json('getCaptions', { id: bad })).error.code, 70);
        }
        assertEquals(
          (await json('getVideoInfo', { id: song.id })).error.code,
          70,
        );
        assertEquals((await json('getCaptions')).error.code, 10);
        assertEquals(
          (await json('getCaptions', { id, format: 'invalid' })).error.code,
          10,
        );
        const noCaptions = (await library.videos()).find((s) =>
          s.path.endsWith('other.mp4')
        )!;
        assertEquals(
          (await json('getCaptions', { id: noCaptions.id })).error.code,
          70,
        );
        await Deno.writeTextFile(
          `${dir}/a/clip.en.srt`,
          SRT.replace('Sidecar', 'Edited'),
        );
        assert(
          (await (await request('getCaptions', { id })).text()).includes(
            'Edited',
          ),
        );
        await Deno.remove(`${dir}/a/clip.fr.vtt`);
        await Deno.writeTextFile(`${dir}/a/clip.de.srt`, SRT);
        await scanLibrary(store);
        const after: Info = (await json('getVideoInfo', { id })).videoInfo;
        assertEquals(
          after.captions.find((c) => c.name === 'en')!.id,
          info.captions.find((c) => c.name === 'en')!.id,
        );
        assertEquals(after.captions.find((c) => c.name === 'fr'), undefined);
        assertEquals(
          after.captions.find((c) => c.name === 'Embedded')!.id,
          info.captions.find((c) => c.name === 'Embedded')!.id,
        );
        assertEquals(after.captions.length, 5);
        await Deno.writeTextFile(`${dir}/a/clip.vtt`, VTT);
        await scanLibrary(store);
        const bare: Info = (await json('getVideoInfo', { id })).videoInfo;
        const bareVtt = await request('getCaptions', {
          id: bare.captions.find((c) => c.name === 'clip.vtt')!.id,
        });
        assertEquals(bareVtt.headers.get('content-type'), 'text/vtt');
        assertEquals(await bareVtt.text(), VTT);
      },
    );
  } finally {
    await server.shutdown();
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
