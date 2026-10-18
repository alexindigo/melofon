import { assert, assertEquals, assertRejects } from '@std/assert';
import { Buffer } from 'node:buffer';
import { parseFile } from 'music-metadata';
import { Demuxer, Dictionary, Muxer } from 'node-av';
import { openStore, type Store } from '../src/store/index.ts';
import { rawSql } from '../src/store/testing.ts';
import { createDecisions } from '../src/decisions.ts';
import { createUnify, type UnifyHandler } from '../src/unify.ts';
import { createMedia, remuxPicture } from '../src/media.ts';
import { createState } from '../src/state.ts';
import { createLookupRunner } from '../src/lookups/runner.ts';
import { createLibrary } from '../src/library.ts';
import { createArtwork } from '../src/artwork.ts';
import { createLibraries } from '../src/libraries.ts';
import { scanLibrary } from '../src/scan.ts';
import {
  candidateImagePath,
  imageHash,
  writeCandidateImage,
} from '../src/images.ts';
import { pictured } from './helpers/pictured.ts';
import { eventually } from './helpers/lookup.ts';

const MP3 =
  'tests/fixtures/library/Fixture Artist/Fixture Album/01 - First Song.mp3';
const JPEG = 'tests/fixtures/library/Fixture Artist/Fixture Album/cover.jpg';
const PNG = new Uint8Array(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  ),
);
const stats = (store: Store) => store.lookups.stats('core.unify');
const start = (store: Store, dir: string, unify?: UnifyHandler) =>
  createLookupRunner({
    store,
    state: createState(store),
    dataDir: `${dir}/data`,
    builtin: `${dir}/no-plugins`,
    unify,
  });
const pictureBytes = async (path: string) =>
  (await parseFile(path)).common.picture?.map((p) => p.data);
const tags = async (path: string) => {
  const { picture: _picture, ...other } = (await parseFile(path)).common;
  return other;
};

for (const format of ['flac', 'm4a']) {
  Deno.test(`unify ${format} preserves an original encoder tag from a different tool`, async () => {
    await setup(async ({ store, root, dir, candidateId }) => {
      const path = `${root}/Album/song.${format}`;
      const before = await tags(path);
      const native = Object.values((await parseFile(path)).native).flat();
      assert(
        native.some((tag) => tag.value === 'Original tool'),
        'fixture must carry a distinct original tool tag',
      );
      await createState(store).set('lookups.maxAttempts', '1');
      await createDecisions(store).accept(candidateId);
      const runner = await start(store, dir);
      try {
        await eventually(async () =>
          (await stats(store)).done === 1 || (await stats(store)).failed === 1
        );
        assertEquals(
          await rawSql(store).all('SELECT state, last_error FROM lookup_jobs'),
          [{ state: 'done', last_error: null }],
        );
        assertEquals(await tags(path), before);
        assertEquals(await pictureBytes(path), [PNG]);
      } finally {
        await runner.close();
      }
    }, async (root) => {
      const path = await fixture(root, format, 'song', false);
      const bytes = Buffer.from(await Deno.readFile(path));
      const old = Buffer.from('Lavf62.19.101');
      const replacement = Buffer.from('Original tool');
      assertEquals(replacement.length, old.length);
      let count = 0;
      for (
        let at = bytes.indexOf(old);
        at >= 0;
        at = bytes.indexOf(old, at + old.length)
      ) {
        bytes.set(replacement, at);
        count++;
      }
      assert(count > 0);
      await Deno.writeFile(path, bytes);
    });
  });
}
async function fixture(
  root: string,
  format: string,
  name = 'song',
  oldPicture = true,
) {
  const path = `${root}/Album/${name}.${format}`;
  await Deno.mkdir(`${root}/Album`, { recursive: true });
  if (format === 'ogg' || format === 'opus') {
    const result = (await createMedia().transcodeAudio(MP3, format))!;
    await Deno.writeFile(
      path,
      new Uint8Array(await new Response(result.stream).arrayBuffer()),
    );
  } else {await Deno.copyFile(
      format === 'mp3' ? MP3 : `tests/fixtures/media/clip.${format}`,
      path,
    );}
  if (oldPicture) {
    const output = `${root}/Album/.seed`;
    await remuxPicture(path, JPEG, output);
    await Deno.rename(output, path);
    assertEquals(await pictureBytes(path), [await Deno.readFile(JPEG)]);
  }
  return path;
}

async function setup(
  fn: (
    s: {
      store: Store;
      root: string;
      dir: string;
      albumId: string;
      candidateId: string;
    },
  ) => Promise<void>,
  prepare?: (root: string) => Promise<unknown>,
) {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-unify-' });
  const root = `${dir}/music`;
  await Deno.mkdir(root);
  const store = await openStore(`${dir}/db`);
  try {
    await createLibraries(store).add('Music', root);
    if (prepare) await prepare(root);
    else await pictured(`${root}/Album/song.mp3`);
    await scanLibrary(store);
    const albumId =
      (await store.catalog.listAlbums({ sort: 'name', size: 10, offset: 0 }))[0]
        .id;
    const library = (await store.catalog.listLibraries())[0];
    const image = (await writeCandidateImage(library, PNG, 'png'))!;
    const candidate = (await store.candidates.addCandidates([{
      entityType: 'album',
      entityId: albumId,
      kind: 'cover',
      source: 'fixture',
      confidence: 'strong',
      imageHash: image.hash,
      imageExt: image.ext,
      libraryId: library.id,
      origin: 'fixture',
    }]))[0];
    await fn({ store, root, dir, albumId, candidateId: candidate.id });
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test('accept persists the decision and one coalesced core.unify job atomically', async () => {
  await setup(async ({ store, albumId, candidateId }) => {
    const decisions = createDecisions(store);
    await Promise.all(
      Array.from({ length: 8 }, () => decisions.accept(candidateId)),
    );
    const [candidate] = await store.candidates.candidatesFor('album', albumId);
    assertEquals(candidate.state, 'accepted');
    assert(candidate.decidedAtMs !== null);
    assertEquals(await store.lookups.stats('core.unify'), {
      waiting: 1,
      active: 0,
      done: 0,
      failed: 0,
    });
  });
});

Deno.test('reject persists without queuing file writes and suppresses the strongest candidate', async () => {
  await setup(async ({ store, root, albumId, candidateId }) => {
    const original = await Deno.readFile(`${root}/Album/song.mp3`);
    const [input] = await store.candidates.candidatesFor('album', albumId);
    await createDecisions(store).reject(candidateId);
    assertEquals(
      (await store.candidates.candidatesFor('album', albumId))[0].state,
      'rejected',
    );
    assertEquals(
      await store.candidates.strongestOpen('album', albumId, 'cover'),
      null,
    );
    assertEquals(await store.lookups.stats('core.unify'), {
      waiting: 0,
      active: 0,
      done: 0,
      failed: 0,
    });
    assertEquals(await store.candidates.addCandidates([input]), []);
    assertEquals(await Deno.readFile(`${root}/Album/song.mp3`), original);
    assertEquals(
      new Uint8Array(
        await (await createArtwork(createLibrary(store)).cover(albumId))
          .arrayBuffer(),
      ),
      new Uint8Array(
        await createArtwork(createLibrary(store)).placeholder().arrayBuffer(),
      ),
    );
  });
});

Deno.test('failed candidate decision rolls back the already-enqueued job in the same store transaction', async () => {
  await setup(async ({ store, albumId, candidateId }) => {
    const [choice] = await store.candidates.candidatesFor('album', albumId);
    const [other] = await store.candidates.addCandidates([{
      ...choice,
      source: 'previous-choice',
    }]);
    await store.candidates.setState(other.id, 'accepted');
    // Fault injection in this disposable database: enqueue succeeds, then the
    // accepted-state update must fail and roll back both parts of the operation.
    await rawSql(store).run(
      'CREATE UNIQUE INDEX one_state_for_fault_injection ON candidates(state)',
    );
    await assertRejects(() => createDecisions(store).accept(candidateId));
    assertEquals((await store.candidates.byId(candidateId))!.state, 'open');
    assertEquals(await stats(store), {
      waiting: 0,
      active: 0,
      done: 0,
      failed: 0,
    });
  });
});

for (const format of ['mp3', 'flac', 'm4a', 'ogg', 'opus']) {
  Deno.test(`unify ${format}: exact cover, all other tags, afp/1, song id and next scan stay correct`, async () => {
    await setup(async ({ store, root, dir, albumId, candidateId }) => {
      const path = `${root}/Album/song.${format}`;
      const beforeTags = await tags(path);
      const beforeFingerprint = await createMedia().fingerprint(path);
      const beforeIdentity = await store.catalog.identitySnapshot();
      const current = (await store.catalog.getAlbum(albumId))!;
      const oldCover = await Deno.readFile(`${root}/Album/cover.jpg`);
      const [choice] = (await store.candidates.candidatesFor('album', albumId))
        .filter((c) => c.id === candidateId);
      const [other] = await store.candidates.addCandidates([{
        ...choice,
        source: 'other-source',
      }]);
      await createDecisions(store).accept(candidateId);
      const runner = await start(store, dir);
      try {
        await eventually(async () =>
          (await stats(store)).done === 1 || (await stats(store)).failed === 1
        );
        const jobs = await rawSql(store).all(
          'SELECT state, last_error FROM lookup_jobs',
        );
        assertEquals(jobs, [{ state: 'done', last_error: null }]);
        assertEquals(await pictureBytes(path), [PNG]);
        assertEquals(await Deno.readFile(`${root}/Album/cover.png`), PNG);
        await assertRejects(
          () => Deno.stat(`${root}/Album/cover.jpg`),
          Deno.errors.NotFound,
        );
        assertEquals(await tags(path), beforeTags);
        assertEquals(
          await createMedia().fingerprint(path),
          beforeFingerprint,
          `${format}: afp/1 unchanged`,
        );
        const candidates = await store.candidates.candidatesFor(
          'album',
          albumId,
        );
        for (const image of [await Deno.readFile(JPEG), oldCover]) {
          const hash = await imageHash(image);
          const archived = candidates.find((c) =>
            c.source === 'local' && c.imageHash === hash
          )!;
          assert(archived, `${format}: old image remains a candidate`);
          assertEquals(archived.details.preserved, true);
          assertEquals(
            await Deno.readFile(
              candidateImagePath({ path: root }, hash, archived.imageExt),
            ),
            image,
          );
        }
        assertEquals(
          (await store.candidates.byId(candidateId))!.state,
          'accepted',
        );
        assertEquals((await store.candidates.byId(other.id))!.state, 'open');
        assertEquals(
          new Uint8Array(
            await (await createArtwork(createLibrary(store)).cover(
              current.songs[0].id,
            )).arrayBuffer(),
          ),
          PNG,
        );
        await scanLibrary(store);
        const afterIdentity = await store.catalog.identitySnapshot();
        assertEquals(
          afterIdentity.map((i) => [i.id, i.fingerprint]),
          beforeIdentity.map((i) => [i.id, i.fingerprint]),
        );
        assertEquals(
          (await store.catalog.getAlbum(albumId))!.songs.map((s) => s.id),
          current.songs.map((s) => s.id),
        );
        assertEquals(
          (await store.catalog.getAlbum(albumId))!.songs.map((s) =>
            s.firstSeenMs
          ),
          current.songs.map((s) => s.firstSeenMs),
        );
        assertEquals(
          (await store.catalog.events({ limit: 100 })).filter((event) =>
            event.kind === 'audio_changed'
          ),
          [],
        );
        const afterScan = await store.candidates.candidatesFor(
          'album',
          albumId,
        );
        assertEquals(
          afterScan.filter((c) =>
            c.source === 'local' && c.state === 'open' && !c.details.preserved
          ),
          [],
        );
        assertEquals(afterScan.filter((c) => c.details.preserved).length, 2);
        console.log(
          `${format}: exact image + all tags + unchanged afp/1 + kept song id + no audio_changed verified`,
        );
      } finally {
        await runner.close();
      }
    }, async (root) => {
      await fixture(root, format);
      await Deno.writeFile(
        `${root}/Album/cover.jpg`,
        new Uint8Array([...await Deno.readFile(JPEG), 1]),
      );
    });
  });
}

Deno.test('ignore leaves the candidate open, strong artwork visible and every file unchanged', async () => {
  await setup(async ({ store, root, dir, albumId, candidateId }) => {
    const before = await Deno.readFile(`${root}/Album/song.mp3`);
    const runner = await start(store, dir);
    try {
      assertEquals((await store.candidates.byId(candidateId))!.state, 'open');
      assertEquals(await stats(store), {
        waiting: 0,
        active: 0,
        done: 0,
        failed: 0,
      });
      assertEquals(
        new Uint8Array(
          await (await createArtwork(createLibrary(store)).cover(albumId))
            .arrayBuffer(),
        ),
        PNG,
      );
      assertEquals(await Deno.readFile(`${root}/Album/song.mp3`), before);
      await assertRejects(
        () => Deno.stat(`${root}/Album/cover.png`),
        Deno.errors.NotFound,
      );
    } finally {
      await runner.close();
    }
  });
});

Deno.test('an existing writable candidate cache does not authorize writes into a read-only library root', async () => {
  await setup(async ({ store, root, candidateId }) => {
    await Deno.chmod(root, 0o555);
    try {
      await assertRejects(
        () => createDecisions(store).accept(candidateId),
        Error,
        'read-only',
      );
      assertEquals((await store.candidates.byId(candidateId))!.state, 'open');
      assertEquals((await stats(store)).waiting, 0);
    } finally {
      await Deno.chmod(root, 0o755);
    }
  });
});

Deno.test('covers changed or added while tracks are remuxing are backed up before publication', async () => {
  await setup(async ({ store, root, dir, albumId, candidateId }) => {
    const jpg = await Deno.readFile(JPEG);
    const updated = new Uint8Array([...jpg, 20]);
    const added = new Uint8Array([...jpg, 21]);
    await Deno.writeFile(`${root}/Album/cover.jpg`, jpg);
    const unify = createUnify(store, {
      remux: async (...args) => {
        await remuxPicture(...args);
        await Deno.writeFile(`${root}/Album/cover.jpg`, updated);
        await Deno.writeFile(`${root}/Album/cover.jpeg`, added);
      },
    });
    await createDecisions(store).accept(candidateId);
    const runner = await start(store, dir, unify);
    try {
      await eventually(async () =>
        (await stats(store)).done === 1 || (await stats(store)).failed === 1
      );
      assertEquals((await stats(store)).done, 1);
      const versions = await store.candidates.candidatesFor('album', albumId);
      for (const image of [jpg, updated, added]) {
        const hash = await imageHash(image);
        const backup = versions.find((c) =>
          c.source === 'local' && c.imageHash === hash
        );
        assert(
          backup,
          `all current images must be saved before replacement: ${hash}`,
        );
        assertEquals(
          await Deno.readFile(
            candidateImagePath({ path: root }, hash, backup.imageExt),
          ),
          image,
        );
      }
      assertEquals(
        [...Deno.readDirSync(`${root}/Album`)].filter((entry) =>
          /^cover\./i.test(entry.name)
        ).map((entry) => entry.name),
        ['cover.png'],
      );
    } finally {
      await runner.close();
    }
  });
});

Deno.test('choosing a live local embedded conflict materializes its image and unifies every track', async () => {
  await setup(async ({ store, root, dir, albumId }) => {
    const local = (await store.candidates.candidatesFor('album', albumId)).find(
      (c) => c.source === 'local' && c.origin.length === 32,
    )!;
    assert(local);
    await createDecisions(store).accept(local.id);
    const runner = await start(store, dir);
    try {
      await eventually(async () =>
        (await stats(store)).done === 1 || (await stats(store)).failed === 1
      );
      assertEquals((await stats(store)).done, 1);
      const jpeg = await Deno.readFile(JPEG);
      assertEquals(await pictureBytes(`${root}/Album/song.mp3`), [jpeg]);
      assertEquals(await pictureBytes(`${root}/Album/second.mp3`), [jpeg]);
      assertEquals(await Deno.readFile(`${root}/Album/cover.jpg`), jpeg);
    } finally {
      await runner.close();
    }
  }, async (root) => {
    await pictured(`${root}/Album/song.mp3`, await Deno.readFile(JPEG));
    await pictured(`${root}/Album/second.mp3`);
    await Deno.writeFile(`${root}/Album/cover.png`, PNG);
  });
});

Deno.test('archived local choice restores the previous image after a clean rescan', async () => {
  await setup(async ({ store, root, dir, albumId, candidateId }) => {
    const runner = await start(store, dir);
    try {
      await createDecisions(store).accept(candidateId);
      await eventually(async () =>
        (await stats(store)).done === 1 || (await stats(store)).failed === 1
      );
      assertEquals((await stats(store)).done, 1);
      await scanLibrary(store);
      const old = (await store.candidates.candidatesFor('album', albumId)).find(
        (c) => c.source === 'local' && c.details.preserved,
      )!;
      assert(old);
      await createDecisions(store).accept(old.id);
      await eventually(async () =>
        (await stats(store)).done === 2 || (await stats(store)).failed === 1
      );
      assertEquals((await stats(store)).done, 2);
      assertEquals(await pictureBytes(`${root}/Album/song.mp3`), [
        await Deno.readFile(JPEG),
      ]);
      assertEquals(
        await Deno.readFile(`${root}/Album/cover.jpg`),
        await Deno.readFile(JPEG),
      );
      await assertRejects(
        () => Deno.stat(`${root}/Album/cover.png`),
        Deno.errors.NotFound,
      );
      assertEquals(
        (await store.candidates.byId(candidateId))!.state,
        'accepted',
      );
    } finally {
      await runner.close();
    }
  }, (root) => pictured(`${root}/Album/song.mp3`, Deno.readFileSync(JPEG)));
});

Deno.test('permission failure mid-unify keeps completed tracks and the same persistent job retries only the rest', async () => {
  await setup(async ({ store, root, dir, candidateId }) => {
    const first = `${root}/Album/a.mp3`;
    const second = `${root}/Album/b.mp3`;
    const writes: string[] = [];
    const state = createState(store);
    await state.set('lookups.maxAttempts', '2');
    await state.set('lookups.retryDelaysSeconds', '1');
    const unify = createUnify(store, {
      remux: async (...args) => {
        writes.push(args[0]);
        await remuxPicture(...args);
        if (args[0] === first) await Deno.chmod(second, 0o444);
      },
    });
    await createDecisions(store).accept(candidateId);
    const runner = await start(store, dir, unify);
    try {
      await eventually(async () =>
        (await rawSql(store).all<{ last_error: string | null }>(
          'SELECT last_error FROM lookup_jobs',
        ))[0]?.last_error?.includes(second) ?? false
      );
      assertEquals(await pictureBytes(first), [PNG]);
      assertEquals(await pictureBytes(second), undefined);
      const doneStat = await Deno.stat(first);
      await Deno.chmod(second, 0o644);
      await eventually(async () =>
        (await stats(store)).done === 1 || (await stats(store)).failed === 1
      );
      assertEquals(
        await rawSql(store).all(
          'SELECT state, attempts, last_error FROM lookup_jobs',
        ),
        [{ state: 'done', attempts: 2, last_error: null }],
      );
      assertEquals(writes, [first, second]);
      assertEquals((await Deno.stat(first)).mtime, doneStat.mtime);
      assertEquals(await pictureBytes(second), [PNG]);
      assertEquals(await Deno.readFile(`${root}/Album/cover.png`), PNG);
      assertEquals(
        [...Deno.readDirSync(`${root}/Album`)].filter((entry) =>
          entry.name.startsWith('.unify-')
        ),
        [],
      );
    } finally {
      await runner.close();
      await Deno.chmod(second, 0o644);
    }
  }, async (root) => {
    await pictured(`${root}/Album/a.mp3`, undefined, { TRCK: '1' });
    await pictured(`${root}/Album/b.mp3`, undefined, { TRCK: '2' });
  });
});

Deno.test('an active core.unify job resumes through the runner after store reopen', async () => {
  await setup(async ({ store, root, dir, candidateId }) => {
    await createDecisions(store).accept(candidateId);
    const active = await store.lookups.claimNext('core.unify');
    assert(active);
    await store.close();
    const reopened = await openStore(`${dir}/db`);
    const runner = await start(reopened, dir);
    try {
      await eventually(async () =>
        (await stats(reopened)).done === 1 ||
        (await stats(reopened)).failed === 1
      );
      assertEquals(
        await rawSql(reopened).all(
          'SELECT id, state, attempts FROM lookup_jobs',
        ),
        [{ id: active.id, state: 'done', attempts: 2 }],
      );
      assertEquals(
        (await reopened.candidates.byId(candidateId))!.state,
        'accepted',
      );
      assertEquals(await pictureBytes(`${root}/Album/song.mp3`), [PNG]);
    } finally {
      await runner.close();
      await reopened.close();
    }
  });
});

Deno.test('queued unify resolves kept album/song identities after an external album move and rescan', async () => {
  await setup(async ({ store, root, dir, albumId, candidateId }) => {
    const before = (await store.catalog.getAlbum(albumId))!.songs[0];
    await createDecisions(store).accept(candidateId);
    await Deno.rename(`${root}/Album`, `${root}/Renamed`);
    await scanLibrary(store);
    assertEquals(
      (await store.catalog.getAlbum(albumId))!.songs[0].id,
      before.id,
    );
    const runner = await start(store, dir);
    try {
      await eventually(async () =>
        (await stats(store)).done === 1 || (await stats(store)).failed === 1
      );
      assertEquals((await stats(store)).done, 1);
      assertEquals(await pictureBytes(`${root}/Renamed/song.mp3`), [PNG]);
      assertEquals(await Deno.readFile(`${root}/Renamed/cover.png`), PNG);
      await assertRejects(
        () => Deno.stat(`${root}/Album`),
        Deno.errors.NotFound,
      );
    } finally {
      await runner.close();
    }
  });
});

for (const format of ['ogg', 'opus']) {
  Deno.test(`unify ${format} backs up legacy COVERART, replaces it with one standard PICTURE block and preserves tags/audio`, async () => {
    await setup(async ({ store, root, dir, albumId, candidateId }) => {
      const path = `${root}/Album/song.${format}`;
      const legacy = Object.values((await parseFile(path)).native).flat().find((
        tag,
      ) => tag.id.toUpperCase() === 'COVERART');
      assert(legacy && typeof legacy.value === 'string');
      assertEquals(
        new Uint8Array(Buffer.from(legacy.value, 'base64')),
        await Deno.readFile(JPEG),
      );
      const before = await createMedia().fingerprint(path);
      const beforeTags = await tags(path);
      await createDecisions(store).accept(candidateId);
      const runner = await start(store, dir);
      try {
        await eventually(async () =>
          (await stats(store)).done === 1 || (await stats(store)).failed === 1
        );
        assertEquals((await stats(store)).done, 1);
        assertEquals(await pictureBytes(path), [PNG]);
        assertEquals(await createMedia().fingerprint(path), before);
        assertEquals(await tags(path), beforeTags);
        const native = Object.values((await parseFile(path)).native).flat();
        assertEquals(
          native.filter((tag) => /^(COVERART|COVERARTMIME)$/i.test(tag.id)),
          [],
        );
        const block = native.find((tag) =>
          tag.id.toUpperCase() === 'METADATA_BLOCK_PICTURE'
        );
        assert(block);
        const oldHash = await imageHash(await Deno.readFile(JPEG));
        const old = (await store.candidates.candidatesFor('album', albumId))
          .find((c) => c.source === 'local' && c.imageHash === oldHash);
        assert(old?.details.preserved);
      } finally {
        await runner.close();
      }
    }, async (root) => {
      const path = await fixture(root, format, 'song', false);
      const output = `${root}/Album/.legacy`;
      await using input = await Demuxer.open(path);
      await using mux = await Muxer.open(output, { format: 'ogg', input });
      const stream = input.audio()!;
      const index = mux.addStream(stream);
      using original = stream.metadata;
      using metadata = Dictionary.fromObject({
        ...original?.getAll(),
        COVERART: Buffer.from(await Deno.readFile(JPEG)).toString('base64'),
        COVERARTMIME: 'image/jpeg',
      });
      mux.getStream(index)!.metadata = metadata;
      for await (const packet of input.packets()) {
        if (!packet) continue;
        try {
          await mux.writePacket(packet, index);
        } finally {
          packet.free();
        }
      }
      await mux.close();
      await Deno.rename(output, path);
    });
  });
}

Deno.test('read-only libraries produce no local candidates; a stale choice cannot be accepted after revocation', async () => {
  await setup(async ({ store, root, dir, albumId, candidateId }) => {
    const other = `${dir}/readonly`;
    await pictured(`${other}/Album/a.mp3`, await Deno.readFile(JPEG));
    await Deno.writeFile(`${other}/Album/cover.png`, PNG);
    await createLibraries(store).add('Read only', other);
    await Deno.chmod(other, 0o555);
    try {
      await scanLibrary(store);
      const album =
        (await store.catalog.listAlbums({ sort: 'name', size: 100, offset: 0 }))
          .find((a) => a.id !== albumId)!;
      assertEquals(await store.candidates.candidatesFor('album', album.id), []);
      await assertRejects(
        () => Deno.stat(`${other}/.melofon`),
        Deno.errors.NotFound,
      );
    } finally {
      await Deno.chmod(other, 0o755);
    }
    await Deno.chmod(`${root}/.melofon/candidates`, 0o555);
    try {
      await assertRejects(
        () => createDecisions(store).accept(candidateId),
        Error,
        'read-only',
      );
      assertEquals((await store.candidates.byId(candidateId))!.state, 'open');
      assertEquals((await stats(store)).waiting, 0);
    } finally {
      await Deno.chmod(`${root}/.melofon/candidates`, 0o755);
    }
  });
});

Deno.test('multipart albums publish one root cover and back up/remove every other eligible cover', async () => {
  await setup(async ({ store, root, dir, albumId, candidateId }) => {
    await createDecisions(store).accept(candidateId);
    const runner = await start(store, dir);
    try {
      await eventually(async () =>
        (await stats(store)).done === 1 || (await stats(store)).failed === 1
      );
      assertEquals((await stats(store)).done, 1);
      for (
        const path of [`${root}/Album/CD1/a.mp3`, `${root}/Album/CD2/b.mp3`]
      ) assertEquals(await pictureBytes(path), [PNG]);
      assertEquals(await Deno.readFile(`${root}/Album/cover.png`), PNG);
      for (
        const path of [
          `${root}/Album/CD1/cover.jpg`,
          `${root}/Album/CD2/COVER.JPEG`,
          `${root}/Album/cover.webp`,
        ]
      ) await assertRejects(() => Deno.stat(path), Deno.errors.NotFound);
      assertEquals(
        (await store.candidates.candidatesFor('album', albumId)).filter((c) =>
          c.details.preserved
        ).length,
        3,
      );
      await scanLibrary(store);
      assertEquals((await store.catalog.getAlbum(albumId))!.songs.length, 2);
    } finally {
      await runner.close();
    }
  }, async (root) => {
    await pictured(`${root}/Album/CD1/a.mp3`, undefined, {
      TPOS: '1',
      TRCK: '1',
    });
    await pictured(`${root}/Album/CD2/b.mp3`, undefined, {
      TPOS: '2',
      TRCK: '1',
    });
    const jpg = await Deno.readFile(JPEG);
    await Deno.writeFile(`${root}/Album/CD1/cover.jpg`, jpg);
    await Deno.writeFile(
      `${root}/Album/CD2/COVER.JPEG`,
      new Uint8Array([...jpg, 1]),
    );
    await Deno.writeFile(
      `${root}/Album/cover.webp`,
      new Uint8Array([...jpg, 2]),
    );
  });
});

for (const damage of ['audio', 'tags']) {
  Deno.test(`unify rejects a remux that changes ${damage} before replacing the original`, async () => {
    await setup(async ({ store, root, dir, candidateId }) => {
      const path = `${root}/Album/song.mp3`;
      const original = await Deno.readFile(path);
      const state = createState(store);
      await state.set('lookups.maxAttempts', '1');
      const unify = createUnify(store, {
        remux: async (_path, _image, output) => {
          if (damage === 'audio') {
            await Deno.copyFile(
              'tests/fixtures/library/Fixture Artist/Fixture Album/02 - Second Song.mp3',
              output,
            );
          } else await pictured(output, undefined, { TIT2: 'Different title' });
        },
      });
      await createDecisions(store).accept(candidateId);
      const runner = await start(store, dir, unify);
      try {
        await eventually(async () => (await stats(store)).failed === 1);
        const [job] = await rawSql(store).all<{ last_error: string }>(
          'SELECT last_error FROM lookup_jobs',
        );
        assert(job.last_error.includes(path));
        assert(
          job.last_error.includes(
            damage === 'audio' ? 'afp/1' : 'non-picture tag',
          ),
        );
        assertEquals(await Deno.readFile(path), original);
        assertEquals(
          [...Deno.readDirSync(`${root}/Album`)].filter((entry) =>
            entry.name.startsWith('.unify-')
          ),
          [],
        );
      } finally {
        await runner.close();
      }
    });
  });
}
