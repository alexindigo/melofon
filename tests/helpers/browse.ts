import { assert } from '@std/assert';
import { apiFixture } from './api.ts';
import { tagged } from './tagged.ts';
import { createLibraries } from '../../src/libraries.ts';
import { createLibrary } from '../../src/library.ts';
import { scanLibrary } from '../../src/scan.ts';
import type { SongRow } from '../../src/library.ts';

/** Real files, scanner, core services and native hat on a household HTTP name. */
export async function browseFixture() {
  const root = await Deno.makeTempDir({ prefix: 'melofon-browse-' });
  let songs: SongRow[] = [];
  const beforeScan = Date.now();
  try {
    const f = await apiFixture({
      services: async (f) => {
        const libraries = createLibraries(f.store, { notify: f.notify });
        for (const name of ['Music', 'Second', 'Offline']) {
          await Deno.mkdir(`${root}/${name}`, { recursive: true });
          await libraries.add(name, `${root}/${name}`);
        }
        await Deno.mkdir(`${root}/Music/Album/CD1`, { recursive: true });
        await Deno.mkdir(`${root}/Music/Album/CD2`, { recursive: true });
        await Deno.mkdir(`${root}/Music/Loose`, { recursive: true });
        await tagged(`${root}/Music/Album/CD1/01_Tagged.mp3`, {
          TIT2: 'Tagged Song',
          TALB: 'Album',
          TPE1: 'Shared Artist',
          TPE2: 'Shared Artist',
          TRCK: '3/9',
          TPOS: '1/2',
          TDRC: '2024',
          TCON: 'Jazz\0Fusion',
          TMOO: 'Calm\0Bright',
          TSOT: 'Song Sort',
          TSOP: 'Artist Sort',
          TSO2: 'Album Artist Sort',
          TSOA: 'Album Sort',
          TBPM: '123',
          TSST: 'First disc',
          TSRC: 'USAAA1234567\0USBBB1234567',
          TDRL: '2024-02-03',
          TDOR: '1999-04',
          TCMP: '1',
          TPUB: 'Label One\0Label Two',
          TXXX: 'MusicBrainz Album Id\0aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        });
        await tagged(`${root}/Music/Album/CD2/02_Other.mp3`, {
          TIT2: 'Other Song',
          TALB: 'Album',
          TPE1: 'Shared Artist',
          TPE2: 'Shared Artist',
          TPOS: '2/2',
        });
        await tagged(`${root}/Music/Loose/no_title_here.mp3`, {});
        await tagged(`${root}/Second/elsewhere.mp3`, {
          TIT2: 'Second library',
          TALB: 'Separate album',
          TPE1: 'Shared Artist',
        });
        await Deno.remove(`${root}/Offline`);
        await scanLibrary(f.store);
        const library = createLibrary(f.store);
        songs = await library.listSongs({ offset: 0, size: 100 });
        assert(songs.length === 4);
        return { libraries, library };
      },
    });
    await f.auth.users.create(f.admin.id, {
      username: 'listener',
      password: 'password-listener',
      role: 'user',
    });
    return {
      ...f,
      root,
      songs,
      beforeScan,
      async close() {
        await f.close();
        await Deno.remove(root, { recursive: true });
      },
    };
  } catch (error) {
    await Deno.remove(root, { recursive: true });
    throw error;
  }
}
