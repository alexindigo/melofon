import { pathToFileURL } from 'node:url';
import { type Log, scopedLog } from '../logging.ts';
import type { SettingValue } from '../settings-schema.ts';
import {
  type Capability,
  type DiscoveredPlugin,
  isReference,
  object,
  validatePluginTree,
} from './manifest.ts';
import {
  type LookupNetwork,
  type NetworkAuthority,
  parentGrant,
} from './net.ts';
import type { ReferenceValues } from '../reference-types.ts';
import { parseReferenceValues } from './reference-values.ts';

export type PluginState =
  | 'discovered'
  | 'disabled'
  | 'starting'
  | 'ready'
  | 'failed'
  | 'stopping';
export class LookupRevoked extends Error {}
export interface LookupCandidate {
  target: { type: 'album' | 'artist'; id: string };
  confidence: 'strong' | 'medium' | 'low';
  values: Partial<
    Record<'album.image.front' | 'artist.image.primary', { url: string }>
  >;
  ids?: Record<string, string>;
  evidence?: Record<string, unknown>;
}
export type LookupResult = { candidates: LookupCandidate[] } | {
  values: ReferenceValues;
} | {
  retryAfter: number;
  reason: string;
};
export function parseResult(
  raw: unknown,
  capability: Capability,
): LookupResult {
  const r = object(
    raw,
    isReference(capability)
      ? ['values', 'retryAfter', 'reason']
      : ['candidates', 'retryAfter', 'reason'],
  );
  if ('retryAfter' in r) {
    if (
      'candidates' in r || 'values' in r || typeof r.retryAfter !== 'number' ||
      !Number.isFinite(r.retryAfter) || r.retryAfter < 0 ||
      typeof r.reason !== 'string'
    ) throw new Error('Invalid retry-later outcome');
    return { retryAfter: r.retryAfter, reason: r.reason };
  }
  if (isReference(capability)) {
    if ('reason' in r) throw new Error('Invalid reference outcome');
    return { values: parseReferenceValues(r.values, capability.provides) };
  }
  if ('reason' in r || !Array.isArray(r.candidates)) {
    throw new Error('Invalid lookup outcome');
  }
  return {
    candidates: r.candidates.map((raw): LookupCandidate => {
      const c = object(raw, [
        'target',
        'confidence',
        'values',
        'ids',
        'evidence',
      ]);
      const target = object(c.target, ['type', 'id']);
      if (
        target.type !== capability.accepts || typeof target.id !== 'string' ||
        !target.id
      ) throw new Error('Invalid candidate target');
      if (
        !['strong', 'medium', 'low'].includes(String(c.confidence))
      ) throw new Error('Invalid candidate confidence');
      const values = object(c.values, capability.provides);
      const image = object(values[capability.provides[0]], ['url']);
      if (
        typeof image.url !== 'string' ||
        !['http:', 'https:'].includes(new URL(image.url).protocol)
      ) throw new Error('Invalid image URL');
      if (
        c.ids !== undefined &&
        (!c.ids || typeof c.ids !== 'object' || Array.isArray(c.ids) ||
          !Object.values(c.ids).every((v) => typeof v === 'string'))
      ) throw new Error('Invalid candidate ids');
      if (
        c.evidence !== undefined &&
        (!c.evidence || typeof c.evidence !== 'object' ||
          Array.isArray(c.evidence))
      ) throw new Error('Invalid evidence');
      return structuredClone(c) as unknown as LookupCandidate;
    }),
  };
}
interface Slot {
  worker: Worker;
  generation: string;
  authority: NetworkAuthority;
  ready: ReturnType<typeof Promise.withResolvers<void>>;
  stopped: ReturnType<typeof Promise.withResolvers<void>>;
  initialized: boolean;
  heartbeat: number;
  timer?: ReturnType<typeof setInterval>;
  call?: {
    id: string;
    signal: AbortSignal;
    limits: { timeoutMs: number; maxBytes: number };
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  };
}
export class LookupHost {
  state: PluginState;
  error?: string;
  private slot?: Slot;
  private enabled = true;
  private hosts: string[] = [];
  private settings: Record<string, SettingValue | undefined> = {};
  private log: Log;
  private revision = 0;
  private starting?: Promise<void>;
  constructor(
    readonly plugin: DiscoveredPlugin,
    private network: LookupNetwork,
    private options: {
      log?: Log;
      heartbeatMs?: number;
      livenessMs?: number;
      startupMs?: number;
      stopMs?: number;
    } = {},
  ) {
    this.state = plugin.error ? 'failed' : 'discovered';
    this.error = plugin.error;
    this.log = options.log ?? scopedLog('lookups');
  }
  get generation(): string | undefined {
    return this.slot?.generation;
  }
  get authority(): NetworkAuthority {
    if (this.state !== 'ready' || !this.slot) {
      throw new Error('Plugin is not ready');
    }
    return this.slot.authority;
  }
  private transition(state: PluginState, error?: string) {
    this.state = state;
    this.error = error;
    this.log.event('lookup_lifecycle', {
      plugin: this.plugin.id,
      state,
      generation: this.generation,
      error,
    });
  }
  /** Synchronous authority retirement. No queued message can outlive its grant. */
  revoke(reason = 'Lookup authority revoked', interrupted = true): void {
    this.revision++;
    const slot = this.slot;
    if (!slot) return;
    this.slot = undefined;
    const error = interrupted ? new LookupRevoked(reason) : new Error(reason);
    this.controllers.get(slot)?.abort(error);
    this.controllers.delete(slot);
    clearInterval(slot.timer);
    slot.ready.reject(error);
    slot.call?.reject(error);
    slot.worker.terminate();
    slot.stopped.resolve();
    this.transition(this.enabled ? 'discovered' : 'disabled');
  }
  private controllers = new WeakMap<Slot, AbortController>();
  async configure(
    enabled: boolean,
    hosts: string[],
    settings: Record<string, SettingValue | undefined>,
  ): Promise<void> {
    const changed = enabled !== this.enabled ||
      JSON.stringify(hosts) !== JSON.stringify(this.hosts) ||
      JSON.stringify(settings) !== JSON.stringify(this.settings);
    if (!enabled) {
      this.enabled = false;
      this.revision++;
      await this.stop();
      this.hosts = hosts;
      this.settings = settings;
      this.transition('disabled');
      return;
    }
    if (changed) this.revoke('Lookup configuration changed');
    this.enabled = enabled;
    this.hosts = hosts;
    this.settings = settings;
    if (this.state === 'disabled' && !this.slot) this.transition('discovered');
  }
  start(): Promise<void> {
    if (!this.enabled) {
      return Promise.reject(new LookupRevoked('Plugin disabled'));
    }
    if (this.starting) return this.starting;
    const task = this.startOnce().catch((error) => {
      if (!(error instanceof LookupRevoked)) {
        this.transition('failed', String(error));
      }
      throw error;
    }).finally(() => {
      if (this.starting === task) this.starting = undefined;
    });
    this.starting = task;
    return task;
  }
  private async startOnce(): Promise<void> {
    if (!this.enabled) throw new Error('Plugin disabled');
    if (!this.plugin.manifest) {
      throw new Error(this.plugin.error ?? 'Invalid manifest');
    }
    if (this.slot) return await this.slot.ready.promise;
    const manifest = this.plugin.manifest;
    const revision = this.revision;
    this.transition('starting');
    const hosts = await parentGrant(this.hosts);
    // A configure/disable while permissions were queried cannot publish stale authority.
    if (!this.enabled || revision !== this.revision) {
      throw new LookupRevoked('Lookup configuration changed');
    }
    const bootstrap = await Deno.readTextFile(
      new URL('./worker.ts', import.meta.url),
    );
    await validatePluginTree(this.plugin.dir);
    if (!this.enabled || revision !== this.revision) {
      throw new LookupRevoked('Lookup configuration changed');
    }
    const worker = new Worker(
      `data:application/typescript,${encodeURIComponent(bootstrap)}`,
      {
        type: 'module',
        deno: {
          permissions: {
            read: [this.plugin.dir],
            write: false,
            env: false,
            ffi: false,
            run: false,
            sys: false,
            // All network authority stays in the RPC-owned service, including
            // granted hosts: native fetch/sockets would bypass its limits.
            net: false,
            import: false,
          },
        },
      },
    );
    const controller = new AbortController();
    const ready = Promise.withResolvers<void>();
    void ready.promise.catch(() => {});
    const slot: Slot = {
      worker,
      generation: crypto.randomUUID(),
      authority: {
        plugin: manifest.id,
        hosts,
        ratePerMinute: manifest.network.ratePerMinute,
        signal: controller.signal,
      },
      ready,
      stopped: Promise.withResolvers<void>(),
      initialized: false,
      heartbeat: performance.now(),
    };
    this.controllers.set(slot, controller);
    this.slot = slot;
    const fail = (error: unknown) => {
      if (this.slot !== slot) return;
      this.revoke(String(error), false);
      this.transition('failed', String(error));
    };
    slot.timer = setInterval(() => {
      if (
        performance.now() - slot.heartbeat >
          (this.state === 'starting'
            ? (this.options.startupMs ?? 10000)
            : (this.options.livenessMs ?? 10000))
      ) fail(new Error('Plugin heartbeat missing'));
    }, this.options.heartbeatMs ?? 1000);
    worker.onerror = (event) => {
      event.preventDefault();
      fail(new Error(event.message));
    };
    worker.onmessageerror = () => fail(new Error('Invalid worker message'));
    worker.onmessage = ({ data }) => {
      if (this.slot !== slot || data?.generation !== slot.generation) return;
      if (data.type === 'ready') slot.initialized = true;
      else if (data.type === 'heartbeat') {
        slot.heartbeat = performance.now();
        if (slot.initialized && this.state === 'starting') {
          this.transition('ready');
          ready.resolve();
        }
      } else if (data.type === 'failed') fail(new Error(data.error));
      else if (data.type === 'stopped') slot.stopped.resolve();
      else if (data.type === 'result' && data.call === slot.call?.id) {
        if (data.error) slot.call?.reject(new Error(data.error));
        else slot.call?.resolve(data.result);
      } else if (data.type === 'log') {
        this.log.event('lookup_plugin_log', {
          plugin: manifest.id,
          payload: data.args,
        });
      } else if (data.type === 'fetch') {
        const call = slot.call;
        if (!call || data.call !== call.id || this.state !== 'ready') return;
        void this.network.fetch(slot.authority, data.url, {
          ...data.init,
          signal: call.signal,
        }, call.limits).then(async (response) => {
          const body = [204, 205, 304].includes(response.status)
            ? null
            : await response.arrayBuffer();
          if (this.slot === slot && slot.call === call) {
            worker.postMessage({
              type: 'fetchResult',
              generation: slot.generation,
              id: data.id,
              body,
              init: { status: response.status, headers: [...response.headers] },
            });
          }
        }).catch((error) => {
          if (this.slot === slot && slot.call === call) {
            worker.postMessage({
              type: 'fetchResult',
              generation: slot.generation,
              id: data.id,
              error: String(error),
            });
          }
        });
      }
    };
    worker.postMessage({
      type: 'init',
      generation: slot.generation,
      entry: pathToFileURL(`${this.plugin.dir}/${manifest.entry}`).href,
      capabilities: manifest.capabilities.map((c) => c.id),
      heartbeatMs: this.options.heartbeatMs ?? 1000,
    });
    return await ready.promise;
  }
  async call(
    capability: Capability,
    item: unknown,
    limits: { timeoutMs: number; maxBytes: number },
    outer?: AbortSignal,
  ): Promise<LookupResult> {
    await this.start();
    const slot = this.slot!;
    if (slot.call) throw new Error('Lookup intake is full');
    const controller = new AbortController();
    const signal = AbortSignal.any([
      slot.authority.signal,
      controller.signal,
      ...(outer ? [outer] : []),
    ]);
    const timer = setTimeout(
      () => controller.abort(new Error('Lookup job timed out')),
      limits.timeoutMs,
    );
    const result = Promise.withResolvers<unknown>();
    const id = crypto.randomUUID();
    const abort = () => {
      if (this.slot === slot && this.state !== 'stopping') {
        slot.worker.postMessage({
          type: 'abort',
          generation: slot.generation,
          call: id,
          reason: String(signal.reason),
        });
        this.revoke(
          String(signal.reason),
          signal.reason instanceof LookupRevoked,
        );
      }
      result.reject(signal.reason);
    };
    slot.call = {
      id,
      signal,
      limits,
      resolve: result.resolve,
      reject: result.reject,
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted();
      slot.worker.postMessage({
        type: 'call',
        generation: slot.generation,
        call: id,
        capability: capability.id,
        item,
        settings: this.settings,
      });
      return parseResult(await result.promise, capability);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      slot.call = undefined;
      controller.abort();
    }
  }
  async stop(): Promise<void> {
    this.enabled = false;
    this.revision++;
    const slot = this.slot;
    if (!slot) return;
    this.transition('stopping');
    this.controllers.get(slot)?.abort(new LookupRevoked('Plugin stopping'));
    slot.call?.reject(new LookupRevoked('Plugin stopping'));
    slot.worker.postMessage({ type: 'stop', generation: slot.generation });
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      slot.stopped.promise,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, this.options.stopMs ?? 100);
      }),
    ]);
    clearTimeout(timer);
    this.revoke('Plugin stopped');
    this.transition('disabled');
  }
}
