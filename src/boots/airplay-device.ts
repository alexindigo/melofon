import type { CommandSource, OutputRegistration, Outputs } from '../player.ts';
import {
  createOutputAdmission,
  type OutputAdmission,
  PreparationError,
} from '../output-admission.ts';
import { createMdnsResolver, type MdnsResolver } from '../mdns-resolver.ts';
import type { MdnsService } from '../mdns.ts';
import { airplayInstance, normalizeAirplayAddress } from './airplay-address.ts';
import { createFfiSpawn } from './raop-ffi.ts';
import {
  type AirplayDriver,
  type AirplayInput,
  airplayOutputId,
  type AirplayProfile,
  type AirplaySpawn,
  type AirplayTransport,
  profileFromService,
  validateAirplayProfile,
} from './airplay-profile.ts';

export function createAirplayDevices(deps: {
  outputs: Outputs;
  admission?: OutputAdmission;
  resolver?: MdnsResolver;
  spawn?: AirplaySpawn;
}) {
  const { outputs } = deps;
  const admission = deps.admission ??
    createOutputAdmission({
      endpoint: (id) => {
        const output = outputs.get(id);
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
  const forgottenReceivers = new Map<string, number>();
  outputs.onCommand((id, command) => {
    if (command.forget) {
      const identity = outputs.get(id)?.receiverIdentity;
      if (identity !== undefined) {
        forgottenReceivers.set(
          identity,
          (forgottenReceivers.get(identity) ?? 0) + 1,
        );
      }
      admission.invalidate(id);
    }
  });
  const spawn = deps.spawn ?? createFfiSpawn();
  const drivers = new WeakMap<AirplayDriver['transport'], AirplayDriver>();
  const receiverIdentity = (id: string, service: MdnsService) => {
    const identity = airplayInstance(service.name)?.id;
    if (!identity) {
      throw new PreparationError('invalid', 'Receiver identity is missing');
    }
    const bound = outputs.get(id)?.receiverIdentity;
    if (bound !== undefined && bound !== identity) {
      throw new PreparationError(
        'invalid',
        'Address belongs to a different receiver',
      );
    }
    return identity;
  };
  const protocol = admission.register<
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
      const config = profileFromService(service, endpoint.address);
      const current = outputs.get(endpoint.id);
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
      return drivers.get(transport)!.start(config, input);
    },
    close: (transport) => transport.close(),
  });
  const accept = (id: string, service: MdnsService) => {
    const row = outputs.get(id);
    if (!row?.host) return;
    receiverIdentity(id, service);
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
    observe: accept,
    observationId(service: MdnsService): string {
      const parsed = airplayInstance(service.name);
      if (!parsed) {
        throw new PreparationError('invalid', 'Receiver identity is missing');
      }
      const rows = outputs.list().filter((o) => o.type === 'AirPlay');
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
      const receiverRevisions = new Map(forgottenReceivers);
      const candidates = outputs.list().filter((o) =>
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
        selected: outputs.get(id)?.selected ?? false,
        volume: outputs.get(id)?.volume ?? 100,
        ...(input.port === undefined ? {} : { port: input.port }),
        ...(input.connectionStrategy === undefined
          ? {}
          : { connectionStrategy: input.connectionStrategy }),
      }, source);
      let revision = outputs.revision(id);
      const isCurrent = () =>
        outputs.get(id) !== null && outputs.revision(id) === revision;
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
      const acquired = outputs.get(id);
      if (
        acquired?.receiverIdentity !== undefined &&
        receiverRevisions.get(acquired.receiverIdentity) !==
          forgottenReceivers.get(acquired.receiverIdentity)
      ) {
        // An alias lookup begun before forget cannot re-adopt that receiver.
        if (!outputs.lifetime(id).adopted) {
          admission.invalidate(id);
          outputs.unregister(id, source);
        }
        return null;
      }
      const canonical = acquired?.receiverIdentity === undefined
        ? undefined
        : outputs.list().find((o) =>
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
