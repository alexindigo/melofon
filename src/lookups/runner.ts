import type { Store } from '../store/index.ts';
import type { LookupInput, LookupJob } from '../store/lookups.ts';
import type { CandidateInput } from '../store/candidates.ts';
import type { State } from '../state.ts';
import type { SettingValue } from '../settings-schema.ts';
import { createLibrary, type Library } from '../library.ts';
import {
  imageExtension,
  imageHash,
  libraryImagesWritable,
  writeCandidateImage,
} from '../images.ts';
import type { Notify } from '../notify.ts';
import { type Log, scopedLog } from '../logging.ts';
import { createUnify, type UnifyHandler } from '../unify.ts';
import { type Capability, discoverLookups, HOST_PATTERN } from './manifest.ts';
import { LookupHost, LookupRevoked } from './host.ts';
import {
  createLookupNetwork,
  intersectHosts,
  type LookupNetwork,
} from './net.ts';

export interface AlbumFacts {
  contract: 1;
  type: 'album';
  id: string;
  name: string | null;
  folderName: string;
  albumArtist: string | null;
  artistKind: string;
  year: number | null;
  library: { id: string; name: string };
  discCount: number;
  tracks: Record<string, unknown>[];
  ids: Record<string, string>;
}
export async function albumFacts(
  store: Store,
  id: string,
): Promise<AlbumFacts | null> {
  const result = await store.catalog.getAlbum(id);
  if (!result || !result.songs.length) return null;
  const library = (await store.catalog.listLibraries()).find((l) =>
    l.id === result.songs[0].libraryId
  );
  if (!library) return null;
  const { album, songs } = result;
  return {
    contract: 1,
    type: 'album',
    id,
    name: album.name,
    folderName: album.folderName,
    albumArtist: album.artistName,
    artistKind: album.artistKind,
    year: album.year,
    library: { id: library.id, name: library.name },
    discCount: new Set(songs.map((s) => s.disc ?? 1)).size,
    tracks: songs.map((s) => ({
      id: s.id,
      title: s.title,
      artist: s.artistName,
      albumId: s.albumId,
      disc: s.disc,
      track: s.track,
      durationMs: s.durationMs,
      year: s.year,
      genre: s.genre,
      ids: {},
    })),
    ids: {},
  };
}
export async function factsHash(
  capability: Capability,
  facts: AlbumFacts,
): Promise<string> {
  return await imageHash(
    new TextEncoder().encode(
      JSON.stringify({ capability: capability.id, facts }),
    ),
  );
}
export async function createLookupRunner(options: {
  store: Store;
  state: State;
  dataDir: string;
  builtin?: string;
  notify?: Notify;
  library?: Library;
  network?: LookupNetwork;
  log?: Log;
  unify?: UnifyHandler;
}) {
  const { store, state } = options;
  const log = options.log ?? scopedLog('lookups');
  const library = options.library ?? createLibrary(store);
  const network = options.network ?? createLookupNetwork({ log });
  const unify = options.unify ?? createUnify(store);
  const declarations = {
    jobTimeoutSeconds: {
      type: 'integer',
      default: 60,
      minimum: 5,
      maximum: 600,
    },
    maxAttempts: { type: 'integer', default: 3, minimum: 1, maximum: 10 },
    retryDelaysSeconds: {
      type: 'array',
      items: { type: 'integer', minimum: 1 },
      default: [60, 600],
    },
    imageMaxMegabytes: {
      type: 'integer',
      default: 20,
      minimum: 1,
      maximum: 200,
    },
    doneRetentionDays: {
      type: 'integer',
      default: 30,
      minimum: 1,
      maximum: 3650,
    },
  };
  for (const [key, schema] of Object.entries(declarations)) {
    state.declare(`lookups.${key}`, schema);
  }
  const plugins = await discoverLookups(
    options.builtin ?? 'lookups',
    options.dataDir,
  );
  const hosts = plugins.map((p) => new LookupHost(p, network, { log }));
  for (const plugin of plugins) {
    const prefix = `lookups.plugin.${plugin.id}`;
    state.declare(`${prefix}.enabled`, { type: 'boolean', default: true });
    state.declare(`${prefix}.hosts`, {
      type: 'array',
      items: {
        type: 'string',
        pattern: HOST_PATTERN,
      },
      default: [],
    });
    for (
      const [key, schema] of Object.entries(plugin.manifest?.settings ?? {})
    ) state.declare(`${prefix}.settings.${key}`, schema);
  }
  let closed = false;
  const shutdown = new AbortController();
  const busy = new Map<LookupHost | string, Promise<void>>();
  let configuration = Promise.resolve();
  const revisions = new Map<LookupHost, number>();
  let intake = Promise.resolve();
  const numeric = async (key: keyof typeof declarations) =>
    Number(await state.getTyped(`lookups.${key}`));
  const limits = async () => ({
    timeoutMs: await numeric('jobTimeoutSeconds') * 1000,
    maxBytes: await numeric('imageMaxMegabytes') * 1024 * 1024,
  });
  const configure = async (host: LookupHost, revision: number) => {
    const manifest = host.plugin.manifest;
    if (!manifest || closed || revisions.get(host) !== revision) return;
    const prefix = `lookups.plugin.${manifest.id}`;
    const enabled = await state.getTyped(`${prefix}.enabled`) as boolean;
    const approved = await state.getTyped(`${prefix}.hosts`) as string[];
    const settings: Record<string, SettingValue | undefined> = {};
    for (const key of Object.keys(manifest.settings)) {
      settings[key] = await state.getTyped(`${prefix}.settings.${key}`);
    }
    if (closed || revisions.get(host) !== revision) return;
    await host.configure(
      enabled,
      intersectHosts(manifest.network.hosts, approved),
      settings,
    );
    if (enabled) {
      void host.start().catch((error) =>
        log.event('lookup_failed', { plugin: manifest.id, error })
      );
    }
  };
  const scheduleConfiguration = (host: LookupHost) => {
    const revision = (revisions.get(host) ?? 0) + 1;
    revisions.set(host, revision);
    configuration = configuration.then(() => configure(host, revision)).catch((
      error,
    ) => log.event('lookup_failed', { plugin: host.plugin.id, error }));
  };
  const unsubscribeState = state.onChange((key, value) => {
    for (const host of hosts) {
      const prefix = `lookups.plugin.${host.plugin.id}.`;
      if (!key.startsWith(prefix)) continue;
      // Retire existing network authority synchronously at the settings boundary.
      if (key === `${prefix}hosts`) host.revoke('Lookup grant changed');
      if (key === `${prefix}enabled` && value === 'false') {
        void host.configure(false, [], {});
      }
      scheduleConfiguration(host);
    }
  });
  await store.lookups.resetActive();
  for (const host of hosts) scheduleConfiguration(host);
  await configuration;

  async function enqueue(
    mode: 'missing' | 'all',
    target?: { type: 'album' | 'song' | 'library'; id: string },
  ) {
    if (closed) return;
    await configuration;
    if (
      !hosts.some((host) =>
        host.state !== 'disabled' &&
        host.plugin.manifest?.capabilities.some((c) => c.requires.length === 0)
      )
    ) return;
    let ids: string[];
    if (target?.type === 'album') ids = [target.id];
    else if (target?.type === 'song') {
      const song = await library.getSong(target.id);
      ids = song?.albumId ? [song.albumId] : [];
    } else {
      ids = [];
      for (let offset = 0;; offset += 100) {
        const page = await library.listAlbums({
          sort: 'name',
          offset,
          size: 100,
          ...(target ? { folderId: target.id } : {}),
        });
        ids.push(...page.map((a) => a.id));
        if (page.length < 100) break;
      }
    }
    const jobs: LookupInput[] = [];
    const writable = new Map<string, boolean>();
    const libraries = await store.catalog.listLibraries();
    for (const id of ids) {
      if (closed) return;
      const facts = await albumFacts(store, id);
      if (!facts) continue;
      if (!writable.has(facts.library.id)) {
        writable.set(
          facts.library.id,
          await libraryImagesWritable(
            libraries.find((l) => l.id === facts.library.id)!,
          ),
        );
      }
      if (!writable.get(facts.library.id)) continue;
      if (mode === 'missing') {
        if (await library.albumCoverPath(id)) continue;
        let embedded = false;
        for (const track of facts.tracks) {
          if (await library.embeddedCover(String(track.id))) {
            embedded = true;
            break;
          }
        }
        if (embedded) continue;
      }
      for (const host of hosts) {
        if (!host.plugin.manifest || host.state === 'disabled') continue;
        for (const capability of host.plugin.manifest.capabilities) {
          // L4 parses dependency vocabulary; chaining is deliberately outside this item.
          if (capability.requires.length) continue;
          jobs.push({
            plugin: host.plugin.id,
            entityType: 'album',
            entityId: id,
            factsHash: await factsHash(capability, facts),
            mode,
          });
        }
      }
      if (jobs.length >= 100) await store.lookups.enqueue(jobs.splice(0));
    }
    if (!closed && jobs.length) await store.lookups.enqueue(jobs);
    pump();
  }
  const queueIntake = (
    mode: 'missing' | 'all',
    target?: { type: 'album' | 'song' | 'library'; id: string },
  ) => {
    const task = intake.then(() => enqueue(mode, target));
    intake = task.catch((error) =>
      log.event('lookup_failed', { plugin: 'runner', error })
    );
    return task;
  };
  async function execute(host: LookupHost | undefined, job: LookupJob) {
    const budget = await limits();
    const controller = new AbortController();
    const signal = AbortSignal.any([shutdown.signal, controller.signal]);
    const timer = setTimeout(() => {
      controller.abort(new Error('Lookup job timed out'));
      host?.revoke('Lookup job timed out', false);
    }, budget.timeoutMs);
    try {
      if (closed) throw new LookupRevoked('Runner closed');
      if (!host) {
        await unify(job, signal);
        signal.throwIfAborted();
        await store.lookups.finish(job.id, { state: 'done' });
        return;
      }
      const facts = await albumFacts(store, job.entityId);
      let capability: Capability | undefined;
      if (facts) {
        for (
          const c of host.plugin.manifest!.capabilities
        ) if (await factsHash(c, facts) === job.factsHash) capability = c;
      }
      if (!facts || !capability) {
        await store.lookups.finish(job.id, { state: 'done' });
        return;
      }
      if (closed) throw new LookupRevoked('Runner closed');
      await host.start();
      const authority = host.authority;
      signal.throwIfAborted();
      const result = await host.call(capability, facts, budget, signal);
      if ('retryAfter' in result) {
        await store.lookups.finish(job.id, {
          state: 'waiting',
          notBeforeMs: Date.now() + result.retryAfter * 1000,
          error: result.reason,
          countAttempt: false,
        });
        return;
      }
      const candidates: CandidateInput[] = [];
      for (const candidate of result.candidates) {
        const target = await albumFacts(store, candidate.target.id);
        if (!target) throw new Error('Candidate target not in catalog');
        const destination = (await store.catalog.listLibraries()).find((l) =>
          l.id === target.library.id
        )!;
        if (!await libraryImagesWritable(destination)) continue;
        const url = candidate.values['album.image.front'].url;
        const response = await network.fetch(
          authority,
          url,
          { signal },
          budget,
        );
        const contentType =
          response.headers.get('content-type')?.split(';')[0].trim()
            .toLowerCase() ?? '';
        if (!response.ok || !/^image\/[a-z0-9]+$/.test(contentType)) {
          throw new Error('Lookup image response is not an image');
        }
        let reference;
        try {
          reference = await writeCandidateImage(
            destination,
            new Uint8Array(await response.arrayBuffer()),
            imageExtension(contentType),
          );
        } catch (error) {
          log.event('lookup_failed', { plugin: host.plugin.id, error });
          continue;
        }
        if (!reference) continue;
        authority.signal.throwIfAborted();
        candidates.push({
          entityType: 'album',
          entityId: target.id,
          kind: 'cover',
          source: host.plugin.id,
          confidence: candidate.confidence,
          imageHash: reference.hash,
          imageExt: reference.ext,
          libraryId: target.library.id,
          origin: url,
          details: {
            ...candidate.evidence,
            ...(candidate.ids ? { ids: candidate.ids } : {}),
          },
        });
      }
      signal.throwIfAborted();
      authority.signal.throwIfAborted();
      await store.candidates.addCandidates(candidates);
      await store.lookups.finish(job.id, { state: 'done' });
    } catch (error) {
      log.event('lookup_failed', { plugin: job.plugin, error });
      const disabled = closed || error instanceof LookupRevoked ||
        (host !== undefined &&
          await state.getTyped(`lookups.plugin.${host.plugin.id}.enabled`) ===
            false);
      const max = await numeric('maxAttempts');
      const delays = await state.getTyped(
        'lookups.retryDelaysSeconds',
      ) as number[];
      const wait = delays[Math.min(job.attempts - 1, delays.length - 1)] ?? 60;
      await store.lookups.finish(
        job.id,
        disabled
          ? { state: 'waiting', notBeforeMs: Date.now(), countAttempt: false }
          : job.attempts >= max
          ? { state: 'failed', error: String(error) }
          : {
            state: 'waiting',
            notBeforeMs: Date.now() + wait * 1000,
            error: String(error),
          },
      );
    } finally {
      clearTimeout(timer);
    }
  }
  function pump() {
    if (closed) return;
    const queues = [undefined, ...hosts];
    for (const host of queues) {
      const key = host ?? 'core.unify';
      const plugin = host?.plugin.id ?? 'core.unify';
      const available = () =>
        !host ||
        (host.plugin.manifest !== undefined && host.state !== 'disabled' &&
          host.state !== 'stopping');
      if (!available() || busy.has(key)) continue;
      const task = (async () => {
        while (!closed) {
          await configuration;
          if (
            closed || !available()
          ) return;
          const job = await store.lookups.claimNext(plugin);
          if (!job) return;
          await execute(host, job);
        }
      })().catch((error) => log.event('lookup_failed', { plugin, error }))
        .finally(() => busy.delete(key));
      busy.set(key, task);
    }
  }
  const unsubscribeNotify = options.notify?.subscribe((types) => {
    if (types.includes('database')) void queueIntake('missing').catch(() => {});
  });
  const poll = setInterval(pump, 50);
  const housekeeping = async () =>
    store.lookups.purgeDone(
      Date.now() - await numeric('doneRetentionDays') * 86400000,
    );
  await housekeeping();
  let cleanup = Promise.resolve();
  const daily = setInterval(() => {
    cleanup = cleanup.then(housekeeping).catch((error) =>
      log.event('lookup_failed', { plugin: 'runner', error })
    );
  }, 86400000);
  return {
    hosts,
    afterScan: () => queueIntake('missing'),
    request(
      target: { type: 'album' | 'song' | 'library'; id: string },
      mode: 'all',
    ) {
      return queueIntake(mode, target);
    },
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(poll);
      clearInterval(daily);
      unsubscribeState();
      unsubscribeNotify?.();
      await Promise.all(hosts.map((host) => host.stop()));
      shutdown.abort(new Error('Lookup runner closed'));
      await Promise.all([configuration, intake, cleanup, ...busy.values()]);
    },
  };
}
