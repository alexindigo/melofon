// main.ts — load config, open DB, seed the first-boot user, scan the library
// sources into the catalog, boot the core tree + glob layers, serve the facade
// on the process default listen plus one Deno.serve per distinct actual extra
// port the layers' claims map to (src/binds.ts). Layers get the injected
// service bag — never a DuckDB handle or deployment credentials.
import { pathfinder } from '@pathfinder/pathfinder';
import { loadConfig } from './config.ts';
import { openStore } from './store/index.ts';
import { seedFirstUser } from './users.ts';
import { createScan } from './scan.ts';
import { createAuthentication } from './authentication.ts';
import { createLibraries } from './libraries.ts';
import { createLibrary } from './library.ts';
import { createFolders } from './folders.ts';
import { createLyrics } from './lyrics.ts';
import { createAnnotation } from './annotation.ts';
import { createListens } from './listens.ts';
import { createIdentity } from './identity.ts';
import { createPlaylists } from './playlists.ts';
import { createRadio } from './radio.ts';
import { createRadioSource } from './radio-source.ts';
import { createPlaybackSource } from './playback-source.ts';
import { createShares } from './shares.ts';
import { createPodcasts } from './podcasts.ts';
import { createNetwork } from './lookups/net.ts';
import { createClientQueue } from './clientqueue.ts';
import { createBookmarks } from './bookmarks.ts';
import { createNowPlaying } from './nowplaying.ts';
import { createStream } from './stream.ts';
import { createFileSource } from './file-source.ts';
import { createZip } from './zip.ts';
import { createMedia } from './media.ts';
import { createArtwork } from './artwork.ts';
import { createOutputs, type Outputs } from './player.ts';
import { createPersistence } from './persistence.ts';
import { createPlayers } from './players.ts';
import {
  createPlaybackReports,
  type PlaybackReports,
} from './playback-reports.ts';
import { createQueueResolver } from './queue-source.ts';
import { createNotify } from './notify.ts';
import { createState } from './state.ts';
import { createPublicAddress } from './public-address.ts';
import { createSettings } from './settings.ts';
import { createPreferences } from './preferences.ts';
import { createPlugins } from './plugins.ts';
import { createLookupRunner } from './lookups/runner.ts';
import { createAirplayBoot } from './boots/airplay.ts';
import { createAirplayDiscovery } from './boots/airplay-mdns.ts';
import { createAirplayDevices } from './boots/airplay-device.ts';
import { createOutputAdmission } from './output-admission.ts';
import { createSpeakers } from './speakers.ts';
import { createSecrets } from './secrets.ts';
import { createSpeakerCredentials } from './speaker-credentials.ts';
import { createHats, type Hats } from './hats.ts';
import { createHatServices } from './hat-service.ts';
import { createHatData } from './hat-data.ts';
import { createBinds, createPortMapping } from './binds.ts';
import { createListenManager } from './listen-manager.ts';
import { scopedLog } from './logging.ts';
import { appLogger, configureLogging } from './logging.ts';
import { createServerStatus } from './server-status.ts';
import { shutdownNativeLogging } from './boots/raop-ffi.ts';
import { createSetup } from './setup.ts';
import { createTermination } from './restart.ts';
import type { Log } from './logging.ts';

export async function startServer(options: {
  env?: Record<string, string>;
  exit?: (code: number) => void;
  setupLog?: Log;
} = {}) {
  const log = scopedLog('server');

  const env = options.env ?? Deno.env.toObject();
  const cfg = loadConfig((name) => env[name]);
  const startedAt = new Date().toISOString();
  const store = await openStore(cfg.dataDir, {
    debugLogQueries: cfg.debugLogRequests,
  });
  const credentials = createSpeakerCredentials({
    store: store.speakers,
    secrets: createSecrets(cfg.secret),
    current(id) {
      return outputs?.get(id, { includeIgnored: true })
        ? {
          revision: outputs.revision(id),
          adopted: outputs.lifetime(id).adopted,
        }
        : null;
    },
  });
  const persistence = createPersistence(store, undefined, credentials);
  await seedFirstUser(store, cfg);
  const setupMode = await store.users.adminCount() === 0;
  const notify = createNotify();
  const state = createState(store, undefined, notify);
  const publicAddress = createPublicAddress(state);
  if (env.MELOFON_BASE_URL !== undefined) {
    await state.seedIfUnset('server.baseUrl', env.MELOFON_BASE_URL);
  }
  const stopLoggingSettings = await configureLogging(state);
  const authentication = createAuthentication(
    store,
    cfg,
    state,
    Date.now,
    notify,
  );
  const media = createMedia(undefined, state);
  const lyrics = createLyrics(store, state);
  const outputs: Outputs = createOutputs({
    notify,
    persistence,
    state,
    releaseCredentials: credentials.release,
  });
  await outputs.ready();
  const scan = createScan(store, media, { notify, lyrics, state });
  const libraries = createLibraries(store, {
    dataDir: cfg.dataDir,
    scan,
    notify,
  });
  const network = createNetwork({ state });
  const radio = createRadio(store, {
    dataDir: cfg.dataDir,
    state,
    notify,
    network,
  });
  const playbackSources = createPlaybackSource({
    media,
    radio: createRadioSource({ network, state }),
    artwork: radio,
    state,
  });
  const podcasts = await createPodcasts({
    store,
    state,
    network,
    media,
    dataDir: cfg.dataDir,
  });
  const lookups = await createLookupRunner({
    store,
    state,
    dataDir: cfg.dataDir,
    notify,
    network,
  });
  const counts = await scan.run();
  log.event('scan_complete', counts);
  const mapping = createPortMapping(env);
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
      const row = outputs.get(id, { includeIgnored: true });
      return row?.host
        ? {
          id,
          protocol: row.type,
          address: row.host,
          ...(row.port === undefined ? {} : { port: row.port }),
        }
        : null;
    },
    changed: () => notify.emit(['outputs'], undefined, 'all'),
  });
  const airplay = createAirplayDevices({
    outputs,
    credentials,
    admission: outputAdmission,
    changed: () => notify.emit(['outputs'], undefined, 'all'),
  });
  const library = createLibrary(store, lyrics, {
    dataDir: cfg.dataDir,
    media,
    state,
    notify,
  });
  const resolveQueueReference = createQueueResolver({
    getSong: (id) => library.getSong(id),
    getStation: (id) => radio.get(id),
  });
  const nowPlaying = createNowPlaying(store, { state });
  const speakers = createSpeakers({
    outputs,
    state,
    prepare: airplay.preparePlayback,
    registerAddress: airplay.registerAddress,
    adapterView: airplay.describe,
    retry: (id) => players.bootForSpeaker(id).retry(id),
    credentials,
    changeCredentials: (id, save) =>
      players.bootForSpeaker(id).changeCredentials(id, save),
    pair: (id) => players.bootForSpeaker(id).pair(id),
    submitPin: (id, pin) => players.bootForSpeaker(id).submitPin(id, pin),
  });
  const reports: PlaybackReports = createPlaybackReports({
    nowPlaying,
    library,
    sessions: authentication.sessions,
    notify,
    serverRows: () => players.serverRows(),
  });

  // Restart transparency (plan restart-transparency): restore the engine —
  // the persisted queue rehydrated via the library (missing tracks drop with
  // a warn), then the snapshot. Auto-resume PLAY only inside the freshness
  // window with the environment still matching; anything else pauses at the
  // saved place, so a stale save can't surprise the household (3am speaker).
  // Only adopted remotes are restored. Identity/preferences are not live
  // observations and never supply admission facts.
  const memberships = new Map(
    (await store.speakers.loadMemberships()).map((row) => [row.speakerId, row]),
  );
  for (const saved of savedOutputs) {
    const membership = memberships.get(saved.id);
    const row = {
      ...saved,
      playerId: membership?.playerId ?? null,
      linked: membership?.linked ?? true,
    };
    const existing = outputs.get(row.id);
    if (existing !== null) {
      // Keep any already registered facts, applying only saved user state.
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
    } else {
      airplay.register({
        id: row.id,
        name: row.name,
        type: row.type,
        selected: row.selected,
        playerId: row.playerId,
        linked: row.linked,
        volume: row.volume,
        connectionStrategy: row.connectionStrategy,
        host: row.host,
        ...(row.port === undefined ? {} : { port: row.port }),
        ...(row.model === undefined ? {} : { model: row.model }),
        ...(row.receiverIdentity === undefined
          ? {}
          : { receiverIdentity: row.receiverIdentity }),
      }, { kind: 'internal', via: 'restore' });
    }
  }
  // Install saved receiver bindings before browsing can introduce aliases.
  const discovery = createAirplayDiscovery({
    outputs,
    state,
    devices: airplay,
    savedOutput: (id) => persistence.savedOutput(id),
  });
  const players = await createPlayers({
    store,
    persistence,
    outputs,
    reports,
    notify,
    maxResumeAgeMs: (cfg.resumeMaxAgeSec ?? 300) * 1000,
    playback: {
      nowPlaying,
      library,
      cfg,
      resolveQueueReference,
      prepareQueueMedia: playbackSources.prepare,
      state,
    },
    targets: (id) => ({
      preparePlayback: (signal) => speakers.preparePlayback(signal, id),
      hasPlaybackTarget: () => speakers.hasPlaybackTarget(id),
    }),
    createBoot: (playerId, playback, outputs) =>
      createAirplayBoot({
        playerId,
        outputs,
        playback,
        media,
        sources: playbackSources,
        notify,
        state,
        devices: airplay,
      }),
  });
  const playback = players.playback;
  const app = {
    store,
    cfg,
    libraries,
    outputs,
    speakers,
    playback,
    players,
    state,
    airplay,
    outputAdmission,
    identity: createIdentity(store),
    reference: lookups.reference,
    log: scopedLog('core'),
  };
  const core = await pathfinder({ roots: ['core/'], app });
  const playlists = createPlaylists(store);
  const settings = createSettings(store, state);
  let hats: Hats | undefined = undefined;
  const bag = {
    log,
    publicAddress,
    ...(setupMode
      ? {
        setup: createSetup({
          users: authentication.users,
          state,
          restartAfter: (completed) => termination.restartAfter(completed),
          log: options.setupLog,
        }),
      }
      : {}),
    settings,
    plugins: createPlugins(store, lookups, settings),
    preferences: createPreferences(store, state, notify),
    hats: createHatServices(store, () => hats!),
    hatData: createHatData(store, cfg, state),
    cfg,
    startedAt,
    server: createServerStatus({
      store,
      version: cfg.version!,
      startedAt,
      hats: () => hats!,
      listens: () => listens.list(),
      scan,
      logger: appLogger(),
    }),
    libraries,
    scan,
    media,
    ...authentication,
    library,
    folders: createFolders(store),
    reference: Object.freeze({
      get: lookups.reference.get,
      artistByName: lookups.reference.artistByName,
      topTracks: lookups.reference.topTracks,
      similarArtists: lookups.reference.similarArtists,
      radio: lookups.reference.radio,
    }),
    annotation: createAnnotation(store),
    listens: createListens(store),
    playlists,
    radio,
    shares: createShares(store, state, library, playlists),
    podcasts,
    clientQueue: createClientQueue(store),
    bookmarks: createBookmarks(store),
    nowPlaying,
    playback,
    players,
    stream: createStream(
      media,
      cfg,
      undefined,
      createFileSource(library, podcasts),
      authentication.sessions,
    ),
    zip: createZip(),
    artwork: createArtwork(library, {
      facts: store.artwork,
      state,
      dataDir: cfg.dataDir,
      playlists,
      podcasts,
      radio,
    }),
    outputs: players.defaultOutputs,
    speakers,
    notify,
    state,
    binds: createBinds(() => hats?.layers() ?? [], mapping),
  };
  const listens = createListenManager({
    core,
    layers: () => hats?.activeLayers() ?? [],
    mapping,
    defaultPort: cfg.listen?.port ?? 8000,
    hostname: cfg.listen?.hostname,
    debugLogRequests: cfg.debugLogRequests,
    debugLogHeaders: cfg.debugLogHeaders,
    setupMode,
    publicAddress,
  });
  hats = await createHats({
    store,
    app: bag,
    mapping,
    listens,
    notify,
    setupMode,
  });

  const onUnload = () => {
    discovery.close();
    airplay.close();
  };
  addEventListener('unload', onUnload);

  await reports.startReportExpiry(state);

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

  const termination = createTermination({
    exit: options.exit,
    close: async () => {
      removeEventListener('unload', onUnload);
      for (const signal of ['SIGTERM', 'SIGINT'] as const) {
        Deno.removeSignalListener(signal, onSignal);
      }
      stopLoggingSettings();
      await lookups.close();
      await podcasts.close();
      discovery.close();
      airplay.close();
      await listens.shutdown();
      await players.close();
      shutdownNativeLogging();
      await reports.close();
      await persistence.drain();
      await store.close();
    },
  });
  const onSignal = () => {
    void termination.shutdown().catch(async (error) => {
      log.event('server_error', { error });
      await appLogger().flush();
      (options.exit ?? Deno.exit)(1);
    });
  };
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    Deno.addSignalListener(signal, onSignal);
  }
  await listens.ensure([cfg.listen?.port ?? 8000]);
  return { shutdown: termination.shutdown, setupMode, hats, players };
}
