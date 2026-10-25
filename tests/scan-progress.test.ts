import { assert, assertEquals } from '@std/assert';
import { scanFixture } from './helpers/scans.ts';
import { authFixture } from './helpers/authentication.ts';
import { createLibraries } from '../src/libraries.ts';
import { createScan, type ScanCounts } from '../src/scan.ts';
import { createNotify } from '../src/notify.ts';
import { tagged } from './helpers/tagged.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(condition: () => boolean) {
  for (let i = 0; i < 500; i++) {
    if (condition()) return;
    await sleep(10);
  }
  throw new Error('Outcome timeout');
}
function barrier() {
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  return { entered, released };
}

for (const entry of ['run', 'request'] as const) {
  Deno.test(`scan finish: late ${entry} runs its own scope and old cleanup preserves the new launch`, async () => {
    const f = await authFixture();
    const hold = barrier();
    let next: Promise<ScanCounts> | undefined;
    let late: Promise<void> | undefined;
    try {
      const libraries = createLibraries(f.store);
      for (const name of ['A', 'B']) await Deno.mkdir(`${f.dir}/${name}`);
      const a = await libraries.add('A', `${f.dir}/A`);
      const b = await libraries.add('B', `${f.dir}/B`);
      for (const path of ['A/one.mp3', 'B/two.mp3', 'B/three.mp3']) {
        await tagged(`${f.dir}/${path}`, {
          TIT2: path,
          TALB: 'Album',
          TPE1: 'Artist',
        });
      }
      const sources = await f.store.catalog.listLibraries();
      // A resolved store fake makes request validation use only microtasks.
      const store = {
        ...f.store,
        catalog: {
          ...f.store.catalog,
          listLibraries: () => Promise.resolve(sources),
        },
      };
      let starts = 0;
      const notify = createNotify();
      const scan = createScan(store, undefined, {
        notify,
        state: {
          ...f.state,
          async getTyped(key) {
            if (key === 'scan.progressIntervalMs' && ++starts === 2) {
              hold.entered.resolve();
              await hold.released.promise;
            }
            return f.state.getTyped(key);
          },
        },
      });
      let updates = 0;
      notify.subscribe((names) => {
        if (!names.includes('update') || ++updates !== 2) return;
        // This callback precedes the final queue check. A foreground call's
        // microtask, or request's two validation awaits, crosses that check
        // but runs before the old launch's finally.
        if (entry === 'run') {
          late = Promise.resolve().then(() => {
            next = scan.run({ libraries: [b.id] });
          });
        } else {
          late = scan.request({ libraries: [b.id], mode: 'full' });
        }
      });
      const first = scan.run({ libraries: [a.id] });
      assertEquals((await first).files, 1);
      await late;
      // No sleeps: drain the bounded promise chain to the controlled barrier.
      for (let n = 0; n < 8; n++) await Promise.resolve();
      assertEquals(starts, 2, 'the late call must start a separate scan');
      await hold.entered.promise;
      next ??= scan.run();
      assert(next !== first, 'the late caller must not receive the old result');
      assert(scan.run() === next, 'old finally must not clear a new launch');
      hold.released.resolve();
      assertEquals((await next).files, 3);
      const status = await scan.status();
      assertEquals(status.scope, { libraries: [b.id] });
      assertEquals(status.queued, null);
      assertEquals(status.scanning, false);
    } finally {
      hold.released.resolve();
      await next;
      await f.close();
    }
  });
}

Deno.test('scan progress: live HTTP fields, throttled socket events, OwnTone updating and end', async () => {
  let hold: ReturnType<typeof barrier> | undefined;
  const f = await scanFixture({
    beforeTags: async () => {
      if (hold) {
        const current = hold;
        hold = undefined;
        current.entered.resolve();
        await current.released.promise;
      }
    },
  });
  let socket: WebSocket | undefined;
  const gate = barrier();
  const events: { names: string[]; at: number }[] = [];
  const stop = f.notify!.subscribe((names) =>
    events.push({ names, at: performance.now() })
  );
  try {
    await f.write('A', 'one.mp3', 'One');
    await f.write('A', 'two.mp3', 'Two');
    await f.add('A');
    const frames: { type: string; events?: Record<string, unknown> }[] = [];
    socket = new WebSocket(
      f.origin.replace('http:', 'ws:') + '/api/v1/events',
      {
        headers: { Cookie: f.cookie, Origin: f.origin },
      },
    );
    socket.onmessage = (ev) => frames.push(JSON.parse(String(ev.data)));
    await until(() => frames.some((v) => v.type === 'hello'));
    events.length = 0;
    frames.length = 0;
    hold = gate;
    const response = await f.json('/api/v1/admin/scans', 'POST', {
      mode: 'full',
    }, f.cookie);
    assertEquals(response.status, 202);
    await response.json();
    await gate.entered.promise;
    const during = (await f.getApi('admin/scans/current')).scan;
    assertEquals(during.scanning, true);
    assertEquals(during.phase, 'reading');
    assertEquals(during.mode, 'full');
    assertEquals(during.scope, {});
    assertEquals([
      during.filesSeen,
      during.filesRead,
      during.librariesDone,
      during.librariesTotal,
      during.problems,
    ], [1, 1, 0, 1, 0]);
    assert(/Z$/.test(during.startedAt));
    const server = await f.getApi('server');
    const own = server.listens.find((l: { hats: string[]; kind: string }) =>
      l.hats.includes('owntone') && l.kind === 'extra'
    );
    assert(own);
    const ownStatus = async () => {
      const r = await fetch(`http://melofon.home:${own.port}/api/library`, {
        signal: AbortSignal.timeout(5000),
      });
      assertEquals(r.status, 200);
      return r.json();
    };
    assertEquals((await ownStatus()).updating, true);
    await sleep(2200);
    const later = (await f.getApi('admin/scans/current')).scan;
    assert(later.elapsedMs >= during.elapsedMs + 2000);
    const inFlightEvents = events.filter((e) => e.names.includes('scan'));
    assert(inFlightEvents.length >= 3);
    for (let i = 1; i < inFlightEvents.length; i++) {
      assert(inFlightEvents[i].at - inFlightEvents[i - 1].at >= 900);
    }
    assert(frames.some((v) => v.events?.scan));
    assertEquals(events.filter((e) => e.names.includes('update')).length, 1);
    gate.released.resolve();
    const ended = await f.idle();
    assertEquals([
      ended.filesSeen,
      ended.filesRead,
      ended.librariesDone,
      ended.librariesTotal,
    ], [2, 2, 1, 1]);
    assertEquals(ended.phase, 'publishing');
    assertEquals(ended.queued, null);
    assertEquals((await ownStatus()).updating, false);
    assertEquals(events.filter((e) => e.names.includes('update')).length, 2);
    await until(() =>
      frames.filter((v) => v.events?.scan).length >= inFlightEvents.length + 1
    );
  } finally {
    gate.released.resolve();
    stop();
    if (socket) {
      socket.close();
      await until(() => socket!.readyState === WebSocket.CLOSED);
    }
    await f.close();
  }
});

Deno.test('merged scan requests: exactly one full follow-up and exact disjoint folder union', async () => {
  let hold: ReturnType<typeof barrier> | undefined;
  const reads: string[] = [];
  const f = await scanFixture({
    onTags: (p) => reads.push(p),
    beforeTags: async () => {
      if (hold) {
        const h = hold;
        hold = undefined;
        h.entered.resolve();
        await h.released.promise;
      }
    },
  });
  const gate = barrier();
  try {
    for (
      const [rel, title] of [['one/song.mp3', 'One'], ['two/song.mp3', 'Two'], [
        'outside/song.mp3',
        'Outside',
      ]]
    ) {
      await f.write('A', rel, title);
    }
    await f.write('B', 'song.mp3', 'B');
    const a = await f.add('A');
    const b = await f.add('B');
    await f.scan({ mode: 'full' });
    await f.write('A', 'one/song.mp3', 'Changed One');
    await f.write('A', 'two/song.mp3', 'Changed Two');
    await f.write('A', 'outside/song.mp3', 'Do not read');
    reads.length = 0;
    const before = f.notifications.length;
    hold = gate;
    let r = await f.json('/api/v1/admin/scans', 'POST', {
      mode: 'full',
      libraries: [b.id],
    }, f.cookie);
    assertEquals(r.status, 202);
    await r.json();
    await gate.entered.promise;
    const first = (await f.getApi('admin/scans/current')).scan;
    for (const [path, mode] of [['one', 'quick'], ['two', 'full']]) {
      r = await f.json('/api/v1/admin/scans', 'POST', {
        mode,
        folder: { library: a.id, path },
      }, f.bearer);
      assertEquals(r.status, 202);
      const scan = (await r.json()).scan;
      assertEquals(scan.startedAt, first.startedAt);
      assertEquals(scan.scope, { libraries: [b.id] });
    }
    const queued = (await f.getApi('admin/scans/current')).scan.queued;
    assertEquals(queued, {
      mode: 'full',
      scope: {
        scopes: [
          { folder: { library: a.id, path: 'one' } },
          { folder: { library: a.id, path: 'two' } },
        ],
      },
    });
    gate.released.resolve();
    await f.idle();
    assertEquals(reads.map((p) => p.slice(f.root.length + 1)).sort(), [
      'A/one/song.mp3',
      'A/two/song.mp3',
      'B/song.mp3',
    ]);
    assertEquals(
      f.notifications.slice(before).filter((n) => n.includes('database'))
        .length,
      2,
    );
    const titles = (await f.songs()).map((s: { title: string }) => s.title)
      .sort();
    assertEquals(titles, ['B', 'Changed One', 'Changed Two', 'Outside']);
  } finally {
    gate.released.resolve();
    await f.close();
  }
});

Deno.test('scan statistics: whole-library published totals, null before scan, partial/unavailable and restart persistence', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-scan-stats-' });
  let f = await scanFixture({ storeDir: dir });
  try {
    await f.write('A', 'one/song.mp3', 'One');
    await f.write('A', 'two/song.mp3', 'Two');
    await f.write('B', 'song.mp3', 'B');
    const a = await f.add('A');
    const b = await f.add('B');
    const library = async (id: string) =>
      (await f.getApi(`admin/libraries/${id}`)).library;
    assertEquals((await library(a.id)).stats, null);
    await f.scan({ mode: 'full' });
    const stats = (await library(a.id)).stats;
    const files = (await f.store.catalog.scanFilesSnapshot()).filter((s) =>
      s.libraryId === a.id
    );
    assertEquals(stats.songs, 2);
    assertEquals(stats.files, 2);
    assertEquals(stats.albums, 2);
    assertEquals(stats.artists, 1);
    assertEquals(stats.sizeBytes, files.reduce((n, s) => n + s.stat.size!, 0));
    assertEquals(
      stats.durationMs,
      files.reduce((n, s) => n + s.durationMs!, 0),
    );
    assert(stats.durationMs > 0);
    assert(stats.sizeBytes > 0);
    assertEquals(stats.problems, 0);
    assertEquals(stats.available, true);
    assertEquals(stats.lastScanMode, 'full');
    assert(
      Date.parse(stats.lastScanEndedAt) >= Date.parse(stats.lastScanStartedAt),
    );
    const bStats = (await library(b.id)).stats;
    await f.write('A', 'one/new.mp3', 'New');
    await f.scan({ folder: { library: a.id, path: 'one' } });
    assertEquals((await library(a.id)).stats.songs, 3);
    assertEquals((await library(a.id)).stats.lastScanMode, 'quick');
    assertEquals((await library(b.id)).stats, bStats);
    await Deno.rename(`${f.root}/A`, `${f.root}/A-offline`);
    await f.scan({ libraries: [a.id] });
    const unavailable = (await library(a.id)).stats;
    assertEquals(unavailable.songs, 3);
    assertEquals(unavailable.available, false);
    assertEquals(unavailable.problems, 1);
    await f.close();
    f = await scanFixture({ storeDir: dir });
    assertEquals((await library(a.id)).stats, unavailable);
    assertEquals((await library(b.id)).stats, bStats);
  } finally {
    await f.close();
    await Deno.remove(dir, { recursive: true });
  }
});
