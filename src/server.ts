// main.ts — load config, open DB, seed the first-boot user, scan the library
// sources into the catalog, boot the core tree + glob layers, serve the facade
// on the process default listen plus one Deno.serve per distinct actual extra
// port the layers' claims map to (src/binds.ts). Layers get the injected
// service bag (app.user, app.library, app.libraries, cfg) — never a DuckDB
// handle.
import { pathfinder } from '@pathfinder/pathfinder';
import { loadConfig } from './config.ts';
import { openStore } from './store/index.ts';
import { seedFirstUser } from './users.ts';
import { createScan } from './scan.ts';
import { createUserService } from './user.ts';
import { createLibraries } from './libraries.ts';
import { createLibrary } from './library.ts';
import { createLyrics } from './lyrics.ts';
import { createAnnotation } from './annotation.ts';
import { createListens } from './listens.ts';
import { createIdentity } from './identity.ts';
import { createPlaylists } from './playlists.ts';
import { createClientQueue } from './clientqueue.ts';
import { createBookmarks } from './bookmarks.ts';
import { createNowPlaying } from './nowplaying.ts';
import { createStream } from './stream.ts';
import { createZip } from './zip.ts';
import { createMedia } from './media.ts';
import { createArtwork } from './artwork.ts';
import { createOutputs, createPlayer, planRestore } from './player.ts';
import { createPersistence } from './persistence.ts';
import { createPlayback } from './playback.ts';
import { createNotify } from './notify.ts';
import { createState } from './state.ts';
import { createLookupRunner } from './lookups/runner.ts';
import { createAirplayBoot } from './boots/airplay.ts';
import { createAirplayDiscovery } from './boots/airplay-mdns.ts';
import { createAirplayDevices } from './boots/airplay-device.ts';
import { createOutputAdmission } from './output-admission.ts';
import { loadLayers } from './layers.ts';
import { actualPorts, createBinds } from './binds.ts';
import { facade } from './facade.ts';
import { scopedLog } from './logging.ts';
import { appLogger } from './logging.ts';
import { shutdownNativeLogging } from './boots/raop-ffi.ts';

const log = scopedLog('server');

const cfg = loadConfig();
const store = await openStore(cfg.dataDir, {
  debugLogQueries: cfg.debugLogRequests,
});
const persistence = createPersistence(store);
await seedFirstUser(store, cfg);
const libraries = createLibraries(store);
const notify = createNotify();
const state = createState(store);
const media = createMedia(undefined, state);
const lyrics = createLyrics(store, state);
const outputs = createOutputs({ notify, persistence, state });
await outputs.ready();
const scan = createScan(store, media, { notify, lyrics, state });
const lookups = await createLookupRunner({
  store,
  state,
  dataDir: cfg.dataDir,
  notify,
});
const counts = await scan.run();
log.event('scan_complete', counts);
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
const library = createLibrary(store, lyrics);
const player = createPlayer();
const nowPlaying = createNowPlaying(store, { state });
const playback = createPlayback({
  player,
  nowPlaying,
  library,
  cfg,
  notify,
  persistence,
});
const app = {
  store,
  cfg,
  libraries,
  outputs,
  playback,
  state,
  airplay,
  outputAdmission,
  identity: createIdentity(store),
  reference: lookups.reference,
  log: scopedLog('core'),
};
const core = await pathfinder({ roots: ['core/'], app });

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
  log.event('restore_complete', {
    queued: restoreSnapshot.queue.length,
    state: restoreSnapshot.state,
    currentIndex: restoreSnapshot.currentIndex,
    positionMs: restoreSnapshot.positionMs,
  });
}
const playlists = createPlaylists(store);
const bag = {
  log,
  cfg,
  startedAt: new Date().toISOString(),
  libraries,
  scan,
  media,
  user: createUserService(store, cfg),
  library,
  reference: lookups.reference,
  annotation: createAnnotation(store),
  listens: createListens(store),
  playlists,
  clientQueue: createClientQueue(store),
  bookmarks: createBookmarks(store),
  nowPlaying,
  playback,
  stream: createStream(media, playback, cfg),
  zip: createZip(),
  artwork: createArtwork(library, { state, dataDir: cfg.dataDir, playlists }),
  player,
  outputs,
  notify,
  state,
  binds: createBinds(() => layers, env),
};
const layers = await loadLayers({ app: bag });

// Boots (plane A drives them): AirPlay 1 via the native RAOP helper.
const airplayBoot = createAirplayBoot({
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
const engineClock = setInterval(() => playback.advanceEnded(), 500);

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
  log.event('address_registered', {
    host,
    preparation: row ? outputAdmission.describe(row.id).state : 'failed',
  });
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
const servers: Deno.HttpServer[] = [];
function serve(port: number, kind: 'default' | 'extra') {
  const server = Deno.serve(
    {
      hostname,
      port,
      onListen: ({ hostname, port }) =>
        log.event('listening', { hostname, port, kind }),
      onError(error) {
        log.event('server_error', { error });
        return new Response(new TextEncoder().encode('Internal Server Error'), {
          status: 500,
        });
      },
    },
    facade(core, layers, {
      ...(kind === 'extra' ? { listenPort: port } : {}),
      defaultPort,
      env,
      ...debug,
    }),
  );
  void server.finished.then(
    () => log.event('server_finished', { port }),
    (error) => log.event('server_failed', { port, error }),
  );
  servers.push(server);
}
serve(defaultPort, 'default');
for (const port of extraBinds) {
  serve(port, 'extra');
}

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(engineClock);
  await lookups.close();
  discovery.close();
  airplay.close();
  await Promise.all(servers.map((server) => server.shutdown()));
  await airplayBoot.close();
  shutdownNativeLogging();
  playback.close();
  await persistence.drain();
  await store.close();
  await appLogger().flush();
  Deno.exit(0);
}
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  Deno.addSignalListener(signal, () => {
    void shutdown().catch(async (error) => {
      log.event('server_error', { error });
      await appLogger().flush();
      Deno.exit(1);
    });
  });
}
