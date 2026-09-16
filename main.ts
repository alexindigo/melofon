// main.ts — load config, open DB, seed the first-boot user, scan the library
// sources into the catalog, boot the core tree + glob layers, serve the facade
// on the process default listen. Layers get the injected service bag
// (app.user, app.library, app.libraries, cfg) — never a DuckDB handle.
import { pathfinder } from '@pathfinder/pathfinder';
import { loadConfig } from './src/config.ts';
import { openDb } from './src/db.ts';
import { seedFirstUser } from './src/users.ts';
import { createScan } from './src/scan.ts';
import { createUserService } from './src/user.ts';
import { createLibraries } from './src/libraries.ts';
import { createLibrary } from './src/library.ts';
import { createAnnotation } from './src/annotation.ts';
import { createListens } from './src/listens.ts';
import { createPlaylists } from './src/playlists.ts';
import { createClientQueue } from './src/clientqueue.ts';
import { createBookmarks } from './src/bookmarks.ts';
import { createStream } from './src/stream.ts';
import { createArtwork } from './src/artwork.ts';
import { loadLayers } from './src/layers.ts';
import { facade } from './src/facade.ts';

const cfg = loadConfig();
const db = await openDb(cfg.dataDir);
await seedFirstUser(db, cfg);
const libraries = createLibraries(db);
const scan = createScan(db);
const counts = await scan.run();
console.log(
  `[melofon] scan: ${counts.files} files (${counts.skipped} skipped), ` +
    `${counts.artists} artists, ${counts.albums} albums`,
);
const app = { db, cfg, libraries };
const core = await pathfinder({ roots: ['core/'], app });
const library = createLibrary(db);
const bag = {
  cfg,
  libraries,
  scan,
  user: createUserService(db, cfg),
  library,
  annotation: createAnnotation(db),
  listens: createListens(db),
  playlists: createPlaylists(db),
  clientQueue: createClientQueue(db),
  bookmarks: createBookmarks(db),
  stream: createStream(),
  artwork: createArtwork(library),
};
const layers = await loadLayers({ app: bag });
Deno.serve(cfg.listen ?? {}, facade(core, layers));
