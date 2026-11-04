// Protocol-neutral preparation and single-use session admission.
export interface OutputEndpoint {
  id: string;
  protocol: string;
  address: string;
  port?: number;
}

export type PreparationCode =
  | 'unavailable'
  | 'timeout'
  | 'incomplete'
  | 'invalid'
  | 'unsupported'
  | 'cancelled'
  | 'stale'
  | 'start-failed';

export class PreparationError extends Error {
  constructor(readonly code: PreparationCode, message: string) {
    super(message);
    this.name = 'PreparationError';
  }
}

export interface PreparationView {
  state: 'unresolved' | 'preparing' | 'ready' | 'failed';
  targetRevision: number;
  source?: string;
  expiresAt?: number;
  error?: { code: PreparationCode; message: string };
}

export interface TargetObservation<C> {
  config: C;
  source: string;
  expiresAt: number;
}

export interface PreparationRequest {
  id: string;
  targetRevision: number;
  signal: AbortSignal;
  /** Explicit catalog refresh; failed refresh cannot extend/erase valid facts. */
  refresh?: boolean;
  isCurrent(): boolean;
}

export interface OutputAdapter<C, I, T, E> {
  prepare(
    endpoint: OutputEndpoint,
    signal: AbortSignal,
  ): Promise<TargetObservation<C>>;
  validate(config: C, endpoint: OutputEndpoint): void;
  create(onEvent: (event: E) => void): T;
  start(transport: T, config: Readonly<C>, input: I): Promise<void>;
  close(transport: T): Promise<void>;
}

const permitBrand: unique symbol = Symbol('prepared-output');
export interface PreparedTarget<P extends string, C, I, T, E> {
  readonly [permitBrand]: readonly [
    P,
    (v: C) => C,
    (v: I) => I,
    (v: T) => T,
    (v: E) => E,
  ];
}

export type AdmissionResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: PreparationError };

export interface OutputProtocol<P extends string, C, I, T, E> {
  /** Adapter-only fresh normalized facts; never restored preferences. */
  facts(id: string): Readonly<C> | null;
  observe(id: string, observation: TargetObservation<C>): void;
  fail(id: string, error: PreparationError): void;
  prepare(
    request: PreparationRequest,
  ): Promise<AdmissionResult<PreparedTarget<P, C, I, T, E>>>;
  activate(
    permit: PreparedTarget<P, C, I, T, E>,
    input: I,
    lifecycle: { publish(transport: T): void; onEvent(event: E): void },
  ): Promise<AdmissionResult<T>>;
}

interface Slot {
  key: string;
  revision: number;
  endpoint: OutputEndpoint | null;
  view: PreparationView;
  attempts: Set<AbortController>;
  latest?: AbortController;
  expiry?: ReturnType<typeof setTimeout>;
}

function immutable<C>(value: C): Readonly<C> {
  const copy = structuredClone(value);
  const freeze = (v: unknown): void => {
    if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) {
      if (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype) {
        throw new PreparationError(
          'invalid',
          'profile requires normalized immutable facts',
        );
      }
      for (const child of Object.values(v)) freeze(child);
      Object.freeze(v);
    }
  };
  freeze(copy);
  return copy;
}

function sameFacts(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  const entries = Object.entries(a);
  return entries.length === Object.keys(b).length &&
    entries.every(([key, value]) =>
      Object.hasOwn(b, key) &&
      sameFacts(value, (b as Record<string, unknown>)[key])
    );
}

function failure(
  error: unknown,
  code: PreparationCode = 'unavailable',
): PreparationError {
  return error instanceof PreparationError
    ? error
    : new PreparationError(code, String(error).slice(0, 160));
}

export function createOutputAdmission(deps: {
  endpoint(id: string): OutputEndpoint | null;
  changed?(): void;
  now?(): number;
}) {
  const slots = new Map<string, Slot>();
  const protocols = new Set<string>();
  const now = deps.now ?? Date.now;
  let closed = false;
  const sync = (id: string): Slot => {
    const endpoint = deps.endpoint(id);
    const key = JSON.stringify(endpoint);
    let slot = slots.get(id);
    if (!slot) {
      slot = {
        key,
        endpoint,
        revision: 1,
        view: { state: 'unresolved', targetRevision: 1 },
        attempts: new Set(),
      };
      slots.set(id, slot);
    } else if (slot.key !== key) {
      clearTimeout(slot.expiry);
      for (const attempt of slot.attempts) attempt.abort();
      slot.key = key;
      slot.endpoint = endpoint;
      slot.revision++;
      slot.view = { state: 'unresolved', targetRevision: slot.revision };
    }
    return slot;
  };
  const setView = (slot: Slot, view: PreparationView) => {
    clearTimeout(slot.expiry);
    slot.view = view;
    if (view.state === 'ready') {
      const expire = () => {
        if (closed || slot.view !== view) return;
        const remaining = view.expiresAt! - now();
        if (remaining <= 0) {
          setView(slot, { state: 'unresolved', targetRevision: slot.revision });
        } else {
          slot.expiry = setTimeout(expire, Math.min(remaining, 2147483647));
          Deno.unrefTimer(slot.expiry);
        }
      };
      expire();
    }
    deps.changed?.();
  };
  return {
    describe(id: string): PreparationView {
      const slot = sync(id);
      if (slot.view.state === 'ready' && slot.view.expiresAt! <= now()) {
        return { state: 'unresolved', targetRevision: slot.revision };
      }
      return structuredClone(slot.view);
    },
    invalidate(id: string): void {
      const slot = sync(id);
      for (const attempt of slot.attempts) attempt.abort();
      slot.revision++;
      setView(slot, { state: 'unresolved', targetRevision: slot.revision });
    },
    close(): void {
      closed = true;
      for (const slot of slots.values()) {
        clearTimeout(slot.expiry);
        for (const attempt of slot.attempts) attempt.abort();
      }
    },
    register<P extends string, C, I, T, E>(
      protocol: P,
      adapter: OutputAdapter<C, I, T, E>,
    ): OutputProtocol<P, C, I, T, E> {
      if (closed || protocols.has(protocol)) {
        throw new Error(
          'output adapter already registered or admission closed',
        );
      }
      protocols.add(protocol);
      const observations = new Map<
        string,
        { revision: number; observation: TargetObservation<Readonly<C>> }
      >();
      const permits = new WeakMap<PreparedTarget<P, C, I, T, E>, {
        request: PreparationRequest;
        observation: TargetObservation<Readonly<C>>;
        used: boolean;
      }>();
      const check = (request: PreparationRequest) => {
        const slot = sync(request.id);
        if (closed || request.signal.aborted || !request.isCurrent()) {
          throw new PreparationError('cancelled', 'output demand cancelled');
        }
        if (
          !slot.endpoint || slot.endpoint.protocol !== protocol ||
          slot.revision !== request.targetRevision
        ) {
          throw new PreparationError('stale', 'output target changed');
        }
        return slot;
      };
      const cache = (id: string, observation: TargetObservation<C>) => {
        const slot = sync(id);
        if (!slot.endpoint || slot.endpoint.protocol !== protocol) {
          throw new PreparationError('stale', 'output target absent');
        }
        adapter.validate(observation.config, slot.endpoint);
        if (
          !Number.isFinite(observation.expiresAt) ||
          observation.expiresAt <= now()
        ) throw new PreparationError('stale', 'observation expired');
        const old = observations.get(id);
        const config = old?.revision === slot.revision &&
            sameFacts(old.observation.config, observation.config)
          ? old.observation.config
          : immutable(observation.config);
        const snapshot = {
          ...observation,
          config,
        };
        observations.set(id, {
          revision: slot.revision,
          observation: snapshot,
        });
        setView(slot, {
          state: 'ready',
          targetRevision: slot.revision,
          source: observation.source,
          expiresAt: observation.expiresAt,
        });
        return snapshot;
      };
      return {
        facts(id) {
          const slot = sync(id), saved = observations.get(id);
          return slot.view.state === 'ready' &&
              saved?.revision === slot.revision &&
              saved.observation.expiresAt > now()
            ? saved.observation.config
            : null;
        },
        observe(id, observation) {
          cache(id, observation);
        },
        fail(id, error) {
          const slot = sync(id);
          if (slot.endpoint?.protocol !== protocol) {
            throw new PreparationError(
              'stale',
              'output target belongs to another protocol',
            );
          }
          observations.delete(id);
          setView(slot, {
            state: 'failed',
            targetRevision: slot.revision,
            error: { code: error.code, message: error.message },
          });
        },
        async prepare(request) {
          let slot: Slot | undefined;
          const controller = new AbortController();
          const cancel = () => controller.abort();
          request.signal.addEventListener('abort', cancel, { once: true });
          try {
            slot = check(request);
            slot.attempts.add(controller);
            slot.latest = controller;
            const saved = observations.get(request.id);
            let observation =
              !request.refresh && saved?.revision === slot.revision &&
                saved.observation.expiresAt > now()
                ? saved.observation
                : undefined;
            if (!observation) {
              setView(slot, {
                state: 'preparing',
                targetRevision: slot.revision,
              });
              check(request);
              const acquired = await adapter.prepare(
                slot.endpoint!,
                controller.signal,
              );
              check(request);
              if (controller.signal.aborted) {
                throw new PreparationError(
                  'cancelled',
                  'preparation cancelled',
                );
              }
              observation = cache(request.id, acquired);
            }
            check(request);
            const permit = Object.freeze({}) as PreparedTarget<P, C, I, T, E>;
            permits.set(permit, { request, observation, used: false });
            return { ok: true, value: permit };
          } catch (error) {
            let err = failure(error);
            try {
              check(request);
            } catch (stale) {
              err = failure(stale);
            }
            if (controller.signal.aborted) {
              err = new PreparationError('cancelled', 'preparation cancelled');
            }
            if (
              slot && slot.revision === request.targetRevision &&
              slot.latest === controller
            ) {
              if (err.code === 'invalid' || err.code === 'unsupported') {
                observations.delete(request.id);
              }
              const saved = observations.get(request.id);
              if (
                saved?.revision !== slot.revision ||
                saved.observation.expiresAt <= now()
              ) {
                setView(
                  slot,
                  err.code === 'cancelled' || err.code === 'stale'
                    ? { state: 'unresolved', targetRevision: slot.revision }
                    : {
                      state: 'failed',
                      targetRevision: slot.revision,
                      error: { code: err.code, message: err.message },
                    },
                );
              } else {
                setView(slot, {
                  state: 'ready',
                  targetRevision: slot.revision,
                  source: saved.observation.source,
                  expiresAt: saved.observation.expiresAt,
                  error: { code: err.code, message: err.message },
                });
              }
            }
            return { ok: false, error: err };
          } finally {
            request.signal.removeEventListener('abort', cancel);
            slot?.attempts.delete(controller);
          }
        },
        async activate(permit, input, lifecycle) {
          const owned = permits.get(permit);
          if (!owned || owned.used) {
            return {
              ok: false,
              error: new PreparationError(
                'stale',
                'foreign or consumed permit',
              ),
            };
          }
          owned.used = true;
          let transport: T | undefined;
          let published = false;
          const pending: E[] = [];
          const checkFacts = () => {
            if (
              observations.get(owned.request.id)?.observation.config !==
                owned.observation.config
            ) throw new PreparationError('stale', 'receiver facts superseded');
          };
          try {
            check(owned.request);
            checkFacts();
            if (owned.observation.expiresAt <= now()) {
              throw new PreparationError('stale', 'prepared target expired');
            }
            transport = adapter.create((event) => {
              if (published) lifecycle.onEvent(event);
              else pending.push(event);
            });
            lifecycle.publish(transport);
            published = true;
            for (const event of pending) lifecycle.onEvent(event);
            check(owned.request);
            checkFacts();
            await adapter.start(transport, owned.observation.config, input);
            check(owned.request);
            return { ok: true, value: transport };
          } catch (error) {
            if (transport !== undefined) {
              try {
                await adapter.close(transport);
              } catch (cleanup) {
                return { ok: false, error: failure(cleanup, 'start-failed') };
              }
            }
            return { ok: false, error: failure(error, 'start-failed') };
          }
        },
      };
    },
  };
}

export type OutputAdmission = ReturnType<typeof createOutputAdmission>;
