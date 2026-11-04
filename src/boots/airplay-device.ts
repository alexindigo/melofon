import type { CommandSource, OutputRegistration, Outputs } from '../player.ts';
import {
  createOutputAdmission,
  type OutputAdmission,
  PreparationError,
} from '../output-admission.ts';
import { createMdnsResolver, type MdnsResolver } from '../mdns-resolver.ts';
import type { MdnsService } from '../mdns.ts';
import type { SpeakerAdapterView, SpeakerSessionView } from '../speakers.ts';
import type { SpeakerCredentials } from '../speaker-credentials.ts';
import { airplayInstance, normalizeAirplayAddress } from './airplay-address.ts';
import { createFfiSpawn } from './raop-ffi.ts';
import {
  airplayAbilities,
  type AirplayCredentials,
  type AirplayDriver,
  type AirplayInput,
  airplayOutputId,
  type AirplayProfile,
  type AirplaySpawn,
  type AirplayTransport,
  passwordRequiredFromTxt,
  profileFromService,
  validateAirplayProfile,
} from './airplay-profile.ts';

export function createAirplayDevices(deps: {
  outputs: Outputs;
  admission?: OutputAdmission;
  resolver?: MdnsResolver;
  spawn?: AirplaySpawn;
  credentials?: Pick<SpeakerCredentials, 'session'>;
  changed?(): void;
}) {
  const { outputs } = deps;
  const admission = deps.admission ??
    createOutputAdmission({
      endpoint: (id) => {
        const output = outputs.get(id, { includeIgnored: true });
        return output?.host
          ? {
            id,
            protocol: output.type,
            address: output.host,
            ...(output.port === undefined ? {} : { port: output.port }),
          }
          : null;
      },
    });
  const resolver = deps.resolver ?? createMdnsResolver();
  const configurationRevisions = new Map<string, number>();
  const sessions = new Map<string, { key: string; view: SpeakerSessionView }>();
  const sessionKey = (id: string) => {
    const row = outputs.get(id, { includeIgnored: true });
    return JSON.stringify([
      outputs.revision(id),
      row?.type,
      row?.host,
      row?.port,
      row?.receiverIdentity,
    ]);
  };
  outputs.onCommand((id, command) => {
    if (command.forget || command.ignore) {
      const identity = outputs.get(id, { includeIgnored: true })
        ?.receiverIdentity;
      if (identity !== undefined) {
        configurationRevisions.set(
          identity,
          (configurationRevisions.get(identity) ?? 0) + 1,
        );
      }
      admission.invalidate(id);
    }
  });
  const spawn = deps.spawn ?? createFfiSpawn();
  const drivers = new WeakMap<AirplayDriver['transport'], AirplayDriver>();
  const privateInputs = new WeakMap<AirplayInput, AirplayCredentials>();
  const receiverIdentity = (id: string, service: MdnsService) => {
    const identity = airplayInstance(service.name)?.id;
    if (!identity) {
      throw new PreparationError('invalid', 'Receiver identity is missing');
    }
    const bound = outputs.get(id, { includeIgnored: true })?.receiverIdentity;
    if (bound !== undefined && bound !== identity) {
      throw new PreparationError(
        'invalid',
        'Address belongs to a different receiver',
      );
    }
    return identity;
  };
  const admitted = admission.register<
    'AirPlay',
    AirplayProfile,
    AirplayInput,
    AirplayTransport,
    { event: string; value?: string }
  >('AirPlay', {
    async prepare(endpoint, signal) {
      const service = await resolver.resolve(
        endpoint.address,
        endpoint.port,
        signal,
      );
      const identity = receiverIdentity(endpoint.id, service);
      const current = outputs.get(endpoint.id, { includeIgnored: true });
      const hasPassword = passwordRequiredFromTxt(service.txt);
      if (
        !signal.aborted && current?.host === endpoint.address &&
        current.port === endpoint.port &&
        (current.hasPassword ?? false) !== hasPassword
      ) {
        outputs.update(endpoint.id, { hasPassword });
      }
      const config = profileFromService(service, endpoint.address);
      if (
        !signal.aborted && current?.host === endpoint.address &&
        current.port === endpoint.port
      ) {
        if (
          current.receiverIdentity !== identity ||
          !outputs.lifetime(endpoint.id).discovered ||
          (config.model !== undefined && current.model !== config.model)
        ) {
          outputs.register(
            {
              ...current,
              model: config.model,
              requiresAuth: config.requiresAuth,
              receiverIdentity: identity,
            },
            { kind: 'internal', via: 'airplay-preparation' },
            'restore',
          );
          if (outputs.lifetime(endpoint.id).adopted) {
            await outputs.adopt(endpoint.id);
          }
        } else if (current.requiresAuth !== config.requiresAuth) {
          outputs.update(endpoint.id, { requiresAuth: config.requiresAuth });
        }
      }
      return {
        config,
        source: 'dns-sd',
        expiresAt: Date.now() + service.ttlMs,
      };
    },
    validate: validateAirplayProfile,
    create(onEvent) {
      const driver = spawn((event, value) => onEvent({ event, value }));
      drivers.set(driver.transport, driver);
      return driver.transport;
    },
    start(transport, config, input) {
      return drivers.get(transport)!.start(
        config,
        input,
        privateInputs.get(input),
      );
    },
    close: (transport) => transport.close(),
  });
  type Permit = Parameters<typeof admitted.activate>[0];
  const contexts = new WeakMap<Permit, { id: string; current(): boolean }>();
  const protocol: typeof admitted = {
    ...admitted,
    async prepare(request) {
      const incarnation = outputs.revision(request.id);
      const context = { id: request.id, current: () => true };
      const result = await admitted.prepare({
        ...request,
        isCurrent: () =>
          request.isCurrent() &&
          outputs.revision(request.id) === incarnation && context.current(),
      });
      if (result.ok) contexts.set(result.value, context);
      return result;
    },
    async activate(permit, input, lifecycle) {
      const context = contexts.get(permit);
      contexts.delete(permit);
      if (!context) {
        return {
          ok: false,
          error: new PreparationError('stale', 'foreign or consumed permit'),
        };
      }
      const privateInput = { ...input };
      try {
        if (deps.credentials) {
          const snapshot = await deps.credentials.session(context.id);
          context.current = snapshot.isCurrent;
          privateInputs.set(privateInput, {
            password: snapshot.password,
            pairingKey: snapshot.pairingKey,
          });
        }
        return await admitted.activate(permit, privateInput, lifecycle);
      } catch {
        // No arbitrary dependency error (or plaintext) crosses into public state.
        return {
          ok: false,
          error: new PreparationError(
            'start-failed',
            'Speaker credentials unavailable',
          ),
        };
      } finally {
        privateInputs.delete(privateInput);
      }
    },
  };
  const accept = (id: string, service: MdnsService) => {
    const row = outputs.get(id, { includeIgnored: true });
    if (!row?.host) return;
    receiverIdentity(id, service);
    const hasPassword = passwordRequiredFromTxt(service.txt);
    if ((row.hasPassword ?? false) !== hasPassword) {
      outputs.update(id, { hasPassword });
    }
    const profile = profileFromService(service, row.host);
    protocol.observe(id, {
      config: profile,
      source: 'dns-sd',
      expiresAt: Date.now() + service.ttlMs,
    });
    if (row.requiresAuth !== profile.requiresAuth) {
      outputs.update(id, { requiresAuth: profile.requiresAuth });
    }
  };
  return {
    admission,
    protocol,
    async preparePlayback(id: string, signal: AbortSignal): Promise<boolean> {
      const revision = outputs.revision(id);
      const result = await protocol.prepare({
        id,
        signal,
        targetRevision: admission.describe(id).targetRevision,
        isCurrent: () =>
          outputs.get(id)?.selected === true &&
          outputs.revision(id) === revision,
      });
      // Preparation supplies facts, not a start grant. The boot owns activation.
      return result.ok;
    },
    describe(id: string): SpeakerAdapterView {
      const preparation = admission.describe(id);
      const facts = protocol.facts(id);
      const saved = sessions.get(id);
      return {
        preparation,
        abilities: facts ? airplayAbilities(facts) : null,
        session: structuredClone(
          saved?.key === sessionKey(id) ? saved.view : {
            connection: 'disconnected',
            authentication: 'none',
          },
        ),
      };
    },
    sessionChanged(id: string, view: SpeakerSessionView) {
      const key = sessionKey(id), previous = sessions.get(id);
      if (
        previous?.key === key &&
        JSON.stringify(previous.view) === JSON.stringify(view)
      ) return;
      sessions.set(id, { key, view: structuredClone(view) });
      deps.changed?.();
    },
    observe: accept,
    observationId(service: MdnsService): string {
      const parsed = airplayInstance(service.name);
      if (!parsed) {
        throw new PreparationError('invalid', 'Receiver identity is missing');
      }
      const rows = outputs.list({ includeIgnored: true }).filter((o) =>
        o.type === 'AirPlay'
      );
      // An acquired identity wins over endpoint aliases, including after restart.
      const known = rows.find((o) => o.receiverIdentity === parsed.id);
      if (known) return known.id;
      const provisional = rows.find((o) =>
        o.receiverIdentity === undefined &&
        o.host !== undefined &&
        normalizeAirplayAddress(o.host) ===
          normalizeAirplayAddress(service.address) &&
        (o.port === undefined || o.port === service.port)
      );
      return provisional?.id ?? parsed.id;
    },
    withdraw(id: string, source?: CommandSource) {
      // Withdrawal is not forgetting: revoke live facts/attempts first, then
      // release only observation-owned registry entries.
      admission.invalidate(id);
      outputs.withdraw(id, source);
    },
    register(
      row: OutputRegistration,
      source?: CommandSource,
      service?: MdnsService,
    ) {
      const id = row.id;
      if (service) {
        outputs.register({
          ...row,
          hasPassword: passwordRequiredFromTxt(service.txt),
          receiverIdentity: receiverIdentity(id, service),
        }, source);
      } else outputs.restore(row, source);
      if (service) {
        try {
          accept(id, service);
        } catch (error) {
          protocol.fail(
            id,
            error instanceof PreparationError
              ? error
              : new PreparationError('invalid', 'invalid receiver observation'),
          );
        }
      }
      return id;
    },
    async registerAddress(
      input: {
        name?: string;
        host: string;
        port?: number;
        connectionStrategy?: OutputRegistration['connectionStrategy'];
      },
      source?: CommandSource,
    ) {
      const host = normalizeAirplayAddress(input.host);
      const receiverRevisions = new Map(configurationRevisions);
      const candidates = outputs.list({ includeIgnored: true }).filter((o) =>
        o.type === 'AirPlay' && o.host !== undefined &&
        normalizeAirplayAddress(o.host) === host
      );
      const existing = candidates.find((o) => o.port === input.port) ??
        (input.port === undefined && candidates.length === 1
          ? candidates[0]
          : undefined);
      let id = existing?.id ??
        airplayOutputId(
          input.port === undefined ? host : `${host}:${input.port}`,
        );
      outputs.restore({
        ...existing,
        id,
        name: input.name ?? existing?.name ?? host,
        host,
        type: 'AirPlay',
        selected: outputs.get(id, { includeIgnored: true })?.selected ?? false,
        volume: outputs.get(id, { includeIgnored: true })?.volume ?? 100,
        ...(input.port === undefined ? {} : { port: input.port }),
        ...(input.connectionStrategy === undefined
          ? {}
          : { connectionStrategy: input.connectionStrategy }),
      }, source);
      let revision = outputs.revision(id);
      const isCurrent = () =>
        outputs.get(id, { includeIgnored: true }) !== null &&
        outputs.revision(id) === revision;
      const controller = new AbortController();
      // Catalog preparation has no playback authority; permits are discarded.
      await protocol.prepare({
        id,
        targetRevision: admission.describe(id).targetRevision,
        signal: controller.signal,
        refresh: true,
        isCurrent,
      });
      if (!isCurrent()) return null;
      const acquired = outputs.get(id, { includeIgnored: true });
      if (
        acquired?.receiverIdentity !== undefined &&
        receiverRevisions.get(acquired.receiverIdentity) !==
          configurationRevisions.get(acquired.receiverIdentity)
      ) {
        // An alias lookup begun before forget/ignore cannot re-adopt that receiver.
        if (!outputs.lifetime(id).adopted) {
          admission.invalidate(id);
          outputs.unregister(id, source);
        }
        return null;
      }
      const canonical = acquired?.receiverIdentity === undefined
        ? undefined
        : outputs.list({ includeIgnored: true }).find((o) =>
          o.id !== id && o.type === 'AirPlay' &&
          o.receiverIdentity === acquired.receiverIdentity
        );
      if (canonical && !outputs.lifetime(id).adopted) {
        // A new address alias resolved to an already known receiver. Keep its
        // stable id/preferences, never move credentials or selection to an alias.
        admission.invalidate(id);
        outputs.unregister(id, source);
        id = canonical.id;
        outputs.restore({
          ...canonical,
          host,
          ...(input.port === undefined ? {} : { port: input.port }),
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.connectionStrategy === undefined
            ? {}
            : { connectionStrategy: input.connectionStrategy }),
        }, source);
        revision = outputs.revision(id);
        await protocol.prepare({
          id,
          targetRevision: admission.describe(id).targetRevision,
          signal: controller.signal,
          refresh: true,
          isCurrent,
        });
      }
      if (!isCurrent()) return null;
      return await outputs.adopt(id);
    },
    close() {
      resolver.close();
      admission.close();
    },
  };
}

export type AirplayDevices = ReturnType<typeof createAirplayDevices>;
