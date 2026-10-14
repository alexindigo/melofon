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
import { createOutputs, createPlayer, planRestore } from './src/player.ts';
import { createPersistence } from './src/persistence.ts';
import { createPlayback } from './src/playback.ts';
import { createNotify } from './src/notify.ts';
import { createState } from './src/state.ts';
import { createAirplayBoot } from './src/boots/airplay.ts';
import { createAirplayDiscovery } from './src/boots/airplay-mdns.ts';
import { createAirplayDevices } from './src/boots/airplay-device.ts';
import { createOutputAdmission } from './src/output-admission.ts';
import { loadLayers } from './src/layers.ts';
import { actualPorts, createBinds } from './src/binds.ts';
import { facade } from './src/facade.ts';

const cfg = loadConfig();
const db = await openDb(cfg.dataDir, {
  debugLogQueries: cfg.debugLogRequests,
});
const persistence = createPersistence(db);
await seedFirstUser(db, cfg);
const libraries = createLibraries(db);
const media = createMedia();
const notify = createNotify();
const state = createState(db);
const outputs = createOutputs({ notify, persistence, state });
await outputs.ready();
const scan = createScan(db, media, { notify });
const counts = await scan.run();
console.log(
  `[melofon] scan: ${counts.files} files (${counts.skipped} skipped), ` +
    `${counts.artists} artists, ${counts.albums} albums`,
);
const env = Deno.env.toObject();
if (env.MELOFON_AIRPLAY_MDNS !== undefined) {
  await state.seedIfUnset(
    'airplay.mdns',
    env.MELOFON_AIRPLAY_MDNS === 'off' ? 'off' : 'on',
  );
}
// Load persisted remotes BEFORE discovery starts (plan atv3-session-recycle):
// this populates the savedOutput cache discovery consults synchronously, and
// the rows are the restore snapshot below — model identity included.
const savedOutputs = await persistence.loadOutputs();
const outputAdmission = createOutputAdmission({
  endpoint(id) {
    const row = outputs.get(id);
    return row?.host
      ? {
        id,
        protocol: row.type,
        address: row.host,
        ...(row.port === undefined ? {} : { port: row.port }),
      }
      : null;
  },
  changed: () => notify.emit(['outputs']),
});
const airplay = createAirplayDevices({ outputs, admission: outputAdmission });
const discovery = createAirplayDiscovery({
  outputs,
  state,
  devices: airplay,
  savedOutput: (id) => persistence.savedOutput(id),
});
const app = { db, cfg, libraries, outputs, state, airplay, outputAdmission };
const core = await pathfinder({ roots: ['core/'], app });
const library = createLibrary(db);
const player = createPlayer();
const nowPlaying = createNowPlaying(db);
const playback = createPlayback({
  player,
  nowPlaying,
  library,
  cfg,
  notify,
  persistence,
});

// Restart transparency (plan restart-transparency): restore the engine —
// the persisted queue rehydrated via the library (missing tracks drop with
// a warn), then the snapshot. Auto-resume PLAY only inside the freshness
// window with the environment still matching; anything else pauses at the
// saved place, so a stale save can't surprise the household (3am speaker).
// First re-register persisted remotes (hand-added and last-seen mDNS
// alike) so a saved selection is present for the resume decision.
for (const row of savedOutputs) {
  const existing = outputs.get(row.id);
  if (existing !== null) {
    // Discovery beat the restore: keep its fresh record, apply user state.
    outputs.update(row.id, {
      selected: row.selected,
      volume: row.volume,
      connectionStrategy: row.connectionStrategy,
    }, {
      kind: 'internal',
      via: 'restore',
    });
    // Identity merge (plan atv3-session-recycle): discovery's fresh record
    // keeps its address/TXT; only when it carries no model of its own does
    // the saved identity fill in. A fresh explicit `am` always wins.
    if (existing.model === undefined && row.model !== undefined) {
      const fresh = outputs.get(row.id);
      if (fresh !== null) {
        airplay.register({ ...fresh, model: row.model }, {
          kind: 'internal',
          via: 'restore',
        });
      }
    }
  } else if (row.host !== undefined) {
    airplay.register({
      id: row.id,
      name: row.name,
      type: row.type,
      selected: row.selected,
      volume: row.volume,
      connectionStrategy: row.connectionStrategy,
      host: row.host,
      ...(row.port === undefined ? {} : { port: row.port }),
      ...(row.model === undefined ? {} : { model: row.model }),
    }, { kind: 'internal', via: 'restore' });
  }
}
const restoreSnapshot = await planRestore({
  queueIds: await persistence.loadQueue(),
  saved: await persistence.loadPlayerState(),
  getSong: (id) => library.getSong(id),
  nowMs: Date.now(),
  maxAgeMs: (cfg.resumeMaxAgeSec ?? 300) * 1000,
  selectedOutputPresent: outputs.list().some((o) => o.selected),
});
const restoredEngine = restoreSnapshot !== null;
if (restoreSnapshot !== null) {
  playback.restore(restoreSnapshot);
  console.log(
    `[melofon] restore: ${restoreSnapshot.queue.length} queued, ` +
      `state ${restoreSnapshot.state}` +
      (restoreSnapshot.currentIndex !== null
        ? ` at #${restoreSnapshot.currentIndex} ` +
          `${restoreSnapshot.positionMs}ms`
        : ''),
  );
}
const bag = {
  cfg,
  startedAt: new Date().toISOString(),
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
  nowPlaying,
  playback,
  stream: createStream(media, playback, cfg),
  zip: createZip(),
  artwork: createArtwork(library),
  player,
  outputs,
  notify,
  state,
  binds: createBinds(() => layers, env),
};
const layers = await loadLayers({ app: bag });

// Boots (plane A drives them): AirPlay 1 via the native RAOP helper.
createAirplayBoot({
  outputs,
  playback,
  media,
  notify,
  state,
  devices: airplay,
});
addEventListener('unload', () => {
  discovery.close();
  airplay.close();
});

// The engine's clock: wall-clock progress reaching an item's length ends it
// (advance/replay/drop/stop per repeat/consume). Without this the engine sat
// at track-end in 'play' forever and HA extrapolated ("57 min of a 3 min
// track").
setInterval(() => playback.advanceEnded(), 500);

// MELOFON_AIRPLAY_HOST=<ip>[:port] — unicast-resolve TXT at that host, then
// register. The CRUD twin is POST /_/outputs. Bare IP if resolve times out.
const airplayHost = env.MELOFON_AIRPLAY_HOST?.trim();
if (airplayHost) {
  const match = airplayHost.match(/^(.+?)(?::(\d+))?$/);
  const host = match?.[1] ?? airplayHost;
  const port = match?.[2] === undefined ? undefined : Number(match[2]);
  const row = await airplay.registerAddress({
    name: outputs.list().find((o) => o.host === host)?.name ?? host,
    host,
    ...(port === undefined ? {} : { port }),
  }, { kind: 'internal', via: 'airplay-host-env' });
  console.log(
    `[melofon] airplay: registered ${host} preparation=${
      row ? outputAdmission.describe(row.id).state : 'failed'
    }`,
  );
}

// A restored engine announces itself once the boots exist: the AirPlay boot
// reconciles (a resumed play spawns its session — audible without a client
// action) and any connected hats pick up the restored state.
if (restoredEngine) {
  notify.emit(['player', 'queue', 'outputs', 'volume', 'options']);
}

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
