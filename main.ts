// main.ts — load config, open DB, seed the first-boot user, scan the library
// sources into the catalog, boot the core tree + glob layers, serve the facade
// on the process default listen plus one Deno.serve per distinct actual extra
// port the layers' claims map to (src/binds.ts). Layers get the injected
// service bag (app.user, app.library, app.libraries, cfg) — never a DuckDB
// handle.
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
import { createNowPlaying } from './src/nowplaying.ts';
import { createStream } from './src/stream.ts';
import { createZip } from './src/zip.ts';
import { createMedia } from './src/media.ts';
import { createArtwork } from './src/artwork.ts';
import { createOutputs, createPlayer } from './src/player.ts';
import { createNotify } from './src/notify.ts';
import { loadLayers } from './src/layers.ts';
import { actualPorts, createBinds } from './src/binds.ts';
import { facade } from './src/facade.ts';

const cfg = loadConfig();
const db = await openDb(cfg.dataDir, {
  debugLogQueries: cfg.debugLogRequests,
});
await seedFirstUser(db, cfg);
const libraries = createLibraries(db);
const media = createMedia();
const scan = createScan(db, media);
const counts = await scan.run();
console.log(
  `[melofon] scan: ${counts.files} files (${counts.skipped} skipped), ` +
    `${counts.artists} artists, ${counts.albums} albums`,
);
const app = { db, cfg, libraries };
const core = await pathfinder({ roots: ['core/'], app });
const library = createLibrary(db);
const notify = createNotify();
const env = Deno.env.toObject();
const bag = {
  cfg,
  libraries,
  scan,
  media,
  user: createUserService(db, cfg),
  library,
  annotation: createAnnotation(db),
  listens: createListens(db),
  playlists: createPlaylists(db),
  clientQueue: createClientQueue(db),
  bookmarks: createBookmarks(db),
  nowPlaying: createNowPlaying(db),
  stream: createStream(media),
  zip: createZip(),
  artwork: createArtwork(library),
  player: createPlayer({ notify }),
  outputs: createOutputs({ notify }),
  notify,
  binds: createBinds(() => layers, env),
};
const layers = await loadLayers({ app: bag });

// Extra binds: the distinct actual ports every layer's claims map to after
// MELOFON_LISTEN_<layer> / MELOFON_LISTEN_REPLACE_<claimed> — minus the
// default listen port, which is never bound twice. Deno.serve with no port
// argument binds 8000, so the default port is known even without
// MELOFON_LISTEN.
const defaultPort = cfg.listen?.port ?? 8000;
const extraBinds = new Set<number>();
for (const layer of layers) {
  for (const port of actualPorts(layer, env)) {
    if (port !== defaultPort) extraBinds.add(port);
  }
}

const hostname = cfg.listen?.hostname;
const debug = {
  debugLogRequests: cfg.debugLogRequests,
  debugLogHeaders: cfg.debugLogHeaders,
};
Deno.serve(
  cfg.listen ?? {},
  facade(core, layers, { defaultPort, env, ...debug }),
);
console.log(
  `[melofon] listen ${hostname ?? '0.0.0.0'}:${defaultPort} (default)`,
);
for (const port of extraBinds) {
  Deno.serve(
    { hostname, port },
    facade(core, layers, { listenPort: port, defaultPort, env, ...debug }),
  );
  console.log(`[melofon] listen ${hostname ?? '0.0.0.0'}:${port} (extra)`);
}
