import { assert, assertEquals } from '@std/assert';
import { scanFixture } from './helpers/scans.ts';
import { error } from './helpers/api.ts';
import { rawSql } from '../src/store/testing.ts';

Deno.test('scan modes: quick skips unchanged tags/probes, reads changes, and equals full', async () => {
  const reads: string[] = [];
  const probes: string[] = [];
  const f = await scanFixture({
    onTags: (path) => reads.push(path),
    beforeDescribe: (path) => {
      probes.push(path);
      return Promise.resolve();
    },
  });
  try {
    await f.write('A', 'one.mp3', 'One');
    await f.write('A', 'two.mp3', 'Two');
    await Deno.copyFile(
      'tests/fixtures/library/Fixture Artist/Fixture Album/03 - Clip.mp4',
      `${f.root}/A/clip.mp4`,
    );
    await f.add('A');
    await f.scan({ mode: 'full' });
    assertEquals(reads.length, 3);
    reads.length = probes.length = 0;
    const before = await f.songs();
    const videos = await Promise.all(
      before.map((s: { id: string }) => f.store.catalog.videoDetails(s.id)),
    );
    let status = await f.scan();
    assertEquals(status.mode, 'quick');
    assertEquals([status.filesSeen, status.filesRead], [3, 0]);
    assertEquals(reads, []);
    assertEquals(probes, []);
    assertEquals(await f.songs(), before);
    assertEquals(
      await Promise.all(
        before.map((s: { id: string }) => f.store.catalog.videoDetails(s.id)),
      ),
      videos,
    );
    await f.write('A', 'one.mp3', 'Changed One');
    await Deno.writeTextFile(
      `${f.root}/A/clip.en.vtt`,
      'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nCaption\n',
    );
    await Deno.utime(
      `${f.root}/A/one.mp3`,
      new Date(),
      new Date(Date.now() + 2000),
    );
    await f.write('A', 'new.mp3', 'New');
    await Deno.remove(`${f.root}/A/two.mp3`);
    status = await f.scan({ mode: 'quick' });
    assertEquals(status.filesRead, 2);
    assertEquals(reads.map((p) => p.split('/').at(-1)).sort(), [
      'new.mp3',
      'one.mp3',
    ]);
    const quick = await f.songs();
    const clip = quick.find((s: { isVideo: boolean }) => s.isVideo);
    const quickVideo = await f.store.catalog.videoDetails(clip.id);
    assert(quickVideo!.captions.some((c) => c.key === 'sidecar:clip.en.vtt'));
    assert(quick.some((s: { title: string }) => s.title === 'Changed One'));
    assert(!quick.some((s: { title: string }) => s.title === 'Two'));
    reads.length = probes.length = 0;
    status = await f.scan({ mode: 'full' });
    assertEquals(status.filesRead, 3);
    assertEquals(reads.length, 3);
    assertEquals(probes.length, 3);
    assertEquals(await f.songs(), quick);
    assertEquals(await f.store.catalog.videoDetails(clip.id), quickVideo);
  } finally {
    await f.close();
  }
});

Deno.test('quick scan: sidecar changes and prior unavailable files keep full-scan semantics', async () => {
  const reads: string[] = [];
  const f = await scanFixture({ onTags: (p) => reads.push(p) });
  try {
    await f.write('A', 'song.mp3', 'One');
    const a = await f.add('A');
    await f.scan();
    const [song] = await f.songs();
    reads.length = 0;
    await Deno.writeTextFile(`${f.root}/A/song.lrc`, '[00:01.00]New sidecar');
    await f.scan();
    assertEquals(reads.length, 0);
    assertEquals(
      (await f.store.catalog.scanFilesSnapshot())[0].hasLyrics,
      true,
    );
    assertEquals(
      (await f.rest('getLyricsBySongId', { id: song.id })).lyricsList
        .structuredLyrics[0].line[0].value,
      'New sidecar',
    );
    await Deno.chmod(`${f.root}/A/song.mp3`, 0);
    await f.scan();
    assertEquals((await f.rest('getSong', { id: song.id })).song.title, 'One');
    assertEquals(
      (await f.getApi(`admin/scans/last/problems?library=${a.id}`)).problems[0]
        .kind,
      'tags_unreadable',
    );
    await Deno.chmod(`${f.root}/A/song.mp3`, 0o600);
    await Deno.remove(`${f.root}/A/song.lrc`);
    await f.scan();
    assertEquals(
      (await f.store.catalog.scanFilesSnapshot())[0].hasLyrics,
      false,
    );
  } finally {
    await Deno.chmod(`${f.root}/A/song.mp3`, 0o600).catch(() => {});
    await f.close();
  }
});

Deno.test('scan mode validation and pre-cache catalog upgrade acquire real facts once', async () => {
  let reads = 0;
  const f = await scanFixture({
    onTags: () => {
      reads++;
    },
  });
  try {
    await f.write('A', 'song.mp3', 'One');
    await f.add('A');
    await f.scan();
    for (const mode of ['invalid', '', null, 1, {}]) {
      await error(
        await f.json('/api/v1/admin/scans', 'POST', { mode }, f.bearer),
        400,
        'invalid_field',
      );
    }
    await rawSql(f.store).run('UPDATE files SET scan_facts = NULL');
    reads = 0;
    await f.scan();
    assertEquals(reads, 1);
    const before = await f.songs();
    reads = 0;
    await f.scan();
    assertEquals(reads, 0);
    assertEquals(await f.songs(), before);
    // The existing OpenSubsonic entry point retains its full default.
    await f.rest('startScan');
    await f.idle();
    assertEquals(reads, 1);
  } finally {
    await f.close();
  }
});
