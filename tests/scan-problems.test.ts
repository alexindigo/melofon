import { assert, assertEquals } from '@std/assert';
import { scanFixture } from './helpers/scans.ts';
import { error } from './helpers/api.ts';
import { openStore } from '../src/store/index.ts';
import { createScan } from '../src/scan.ts';
import { createLibraries } from '../src/libraries.ts';

Deno.test('scan problems: unreadable subtree keeps songs and stars, siblings continue and latest problems replace', async () => {
  const f = await scanFixture();
  const blocked = `${f.root}/A/blocked`;
  try {
    await f.write('A', 'blocked/a.mp3', 'Protected');
    await f.write('A', 'sibling/b.mp3', 'Sibling');
    await f.write('A', 'single.mp3', 'Unreadable file');
    const a = await f.add('A');
    await f.scan();
    const protectedSong = (await f.songs()).find((s: { title: string }) =>
      s.title === 'Protected'
    );
    await f.rest('star', { id: protectedSong.id });
    await Deno.chmod(blocked, 0);
    await Deno.chmod(`${f.root}/A/single.mp3`, 0);
    await Deno.writeTextFile(`${f.root}/A/corrupt.mp3`, 'not audio');
    // An ISO BMFF file with a file type box and no media tracks.
    await Deno.writeFile(
      `${f.root}/A/empty.mp4`,
      new Uint8Array([
        0,
        0,
        0,
        24,
        102,
        116,
        121,
        112,
        105,
        115,
        111,
        109,
        0,
        0,
        0,
        0,
        105,
        115,
        111,
        109,
        109,
        112,
        52,
        50,
        0,
        0,
        0,
        8,
        109,
        111,
        111,
        118,
      ]),
    );
    await f.write('A', 'sibling/new.mp3', 'New sibling');
    await f.scan();
    const result = await f.getApi(`admin/scans/last/problems?library=${a.id}`);
    for (
      const kind of [
        'folder_unreadable',
        'tags_unreadable',
        'no_streams',
        'fingerprint_failed',
      ]
    ) {
      assert(
        result.problems.some((p: { kind: string }) => p.kind === kind),
        JSON.stringify(result),
      );
    }
    assert(
      result.problems.every((
        p: { runId: string; libraryId: string; path: string; message: string },
      ) =>
        p.runId && p.libraryId === a.id && !p.path.startsWith('/') && p.message
      ),
    );
    assertEquals(
      (await f.songs()).map((s: { title: string }) => s.title).sort(),
      ['New sibling', 'Protected', 'Sibling', 'Unreadable file'],
    );
    assertEquals(
      (await f.rest('getStarred2')).starred2.song[0].id,
      protectedSong.id,
    );
    await Deno.chmod(blocked, 0o700);
    await Deno.chmod(`${f.root}/A/single.mp3`, 0o600);
    await Deno.remove(`${f.root}/A/corrupt.mp3`);
    await Deno.remove(`${f.root}/A/empty.mp4`);
    await f.scan();
    assertEquals(
      (await f.getApi(`admin/scans/last/problems?library=${a.id}`)).problems,
      [],
    );
  } finally {
    await Deno.chmod(blocked, 0o700).catch(() => {});
    await Deno.chmod(`${f.root}/A/single.mp3`, 0o600).catch(() => {});
    await f.close();
  }
});

Deno.test('scan problems API caps results at 1000, validates query and protects admin reads', async () => {
  const f = await scanFixture();
  const folders: string[] = [];
  try {
    await f.write('A', 'song.mp3', 'Song');
    const a = await f.add('A');
    for (let n = 0; n < 1001; n++) {
      const path = `${f.root}/A/blocked-${n}`;
      await Deno.mkdir(path);
      folders.push(path);
      await Deno.chmod(path, 0);
    }
    await f.scan();
    const result = await f.getApi(`admin/scans/last/problems?library=${a.id}`);
    assertEquals(result.problems.length, 1000);
    assertEquals(result.truncated, true);
    assertEquals(
      new Set(result.problems.map((p: { runId: string }) => p.runId)).size,
      1,
    );
    await error(
      await f.get('/api/v1/admin/scans/last/problems'),
      401,
      'unauthenticated',
    );
    for (
      const query of [
        '?library=missing',
        '?library=',
        '?extra=x',
        '?library=x&library=y',
      ]
    ) {
      await error(
        await f.get(`/api/v1/admin/scans/last/problems${query}`, f.bearer),
        query === '?library=missing' ? 404 : 400,
        query === '?library=missing' ? 'not_found' : 'invalid_field',
      );
    }
    await f.auth.users.create(f.admin.id, {
      username: 'listener',
      password: 'password-listener',
      role: 'user',
    });
    const listener =
      (await f.login('bearer', 'listener', 'password-listener')).credential;
    await error(
      await f.get('/api/v1/admin/scans/last/problems', listener),
      403,
      'forbidden',
    );
  } finally {
    for (const folder of folders) await Deno.chmod(folder, 0o700);
    await f.close();
  }
});

Deno.test('scan availability and latest per-library problems persist across store restart', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-scan-restart-' });
  let store = await openStore(`${dir}/db`);
  try {
    await Deno.mkdir(`${dir}/A`);
    await Deno.mkdir(`${dir}/B`);
    const libraries = createLibraries(store);
    const a = await libraries.add('A', `${dir}/A`);
    const b = await libraries.add('B', `${dir}/B`);
    await Deno.rename(`${dir}/A`, `${dir}/away`);
    await createScan(store).run();
    const before = await createScan(store).problems(a.id);
    assertEquals(before.problems[0].kind, 'root_unavailable');
    await store.close();
    store = await openStore(`${dir}/db`);
    assertEquals(await createScan(store).problems(a.id), before);
    assertEquals(
      (await store.catalog.listLibraries()).find((l) => l.id === a.id)
        ?.available,
      false,
    );
    await createScan(store).run({ libraries: [b.id] });
    assertEquals(await createScan(store).problems(a.id), before);
    await Deno.rename(`${dir}/away`, `${dir}/A`);
    await createScan(store).run({ libraries: [a.id] });
    assertEquals(await createScan(store).problems(a.id), {
      problems: [],
      truncated: false,
    });
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('missing library: catalog and stars survive, availability warning and event recover after restore', async () => {
  const f = await scanFixture();
  try {
    await f.write('A', 'one/song.mp3', 'Song');
    const a = await f.add('A');
    await f.scan();
    const song = (await f.songs())[0];
    await f.rest('star', { id: song.id });
    await Deno.rename(`${f.root}/A`, `${f.root}/away`);
    const before = f.notifications.length;
    await f.scan();
    assertEquals((await f.rest('getSong', { id: song.id })).song.title, 'Song');
    assertEquals((await f.rest('getStarred2')).starred2.song[0].id, song.id);
    assertEquals(
      (await f.getApi('admin/libraries')).libraries[0].available,
      false,
    );
    assertEquals(
      (await f.getApi('server')).warnings.filter((w: { code: string }) =>
        w.code === 'library_unavailable'
      ).length,
      1,
    );
    assert(f.notifications.slice(before).some((n) => n.includes('libraries')));
    assertEquals(
      (await f.getApi(`admin/scans/last/problems?library=${a.id}`)).problems[0]
        .kind,
      'root_unavailable',
    );
    await Deno.rename(`${f.root}/away`, `${f.root}/A`);
    await f.scan();
    assertEquals(
      (await f.getApi('admin/libraries')).libraries[0].available,
      true,
    );
    assertEquals(
      (await f.getApi('server')).warnings.filter((w: { code: string }) =>
        w.code === 'library_unavailable'
      ),
      [],
    );
    assertEquals((await f.rest('getStarred2')).starred2.song[0].id, song.id);
  } finally {
    await f.close();
  }
});

Deno.test('file read failures after tags preserve the old song and continue indexing siblings', async () => {
  let fail = false;
  const f = await scanFixture({
    async beforeDescribe(path) {
      if (fail && path.endsWith('/a.mp3')) {
        await Deno.chmod(path, 0);
        await Deno.readFile(path); // Real tester permission failure, after tags.
      }
    },
  });
  try {
    await f.write('A', 'one/a.mp3', 'Kept');
    const a = await f.add('A');
    await f.scan();
    const song = (await f.songs())[0];
    await f.rest('star', { id: song.id });
    await f.write('A', 'one/b.mp3', 'Sibling');
    fail = true;
    await f.scan({ mode: 'full' });
    assertEquals(
      (await f.songs()).map((s: { title: string }) => s.title).sort(),
      ['Kept', 'Sibling'],
    );
    assertEquals((await f.rest('getStarred2')).starred2.song[0].id, song.id);
    const result = await f.getApi(`admin/scans/last/problems?library=${a.id}`);
    assert(
      result.problems.some((p: { path: string; kind: string }) =>
        p.path === 'one/a.mp3' && p.kind === 'tags_unreadable'
      ),
    );
  } finally {
    fail = false;
    await Deno.chmod(`${f.root}/A/one/a.mp3`, 0o600).catch(() => {});
    await f.close();
  }
});
