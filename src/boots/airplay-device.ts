import type { CommandSource, OutputRegistration, Outputs } from '../player.ts';
import {
  createOutputAdmission,
  type OutputAdmission,
  PreparationError,
} from '../output-admission.ts';
import { createMdnsResolver, type MdnsResolver } from '../mdns-resolver.ts';
import type { MdnsService } from '../mdns.ts';
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
  const spawn = deps.spawn ?? createFfiSpawn();
  const drivers = new WeakMap<AirplayDriver['transport'], AirplayDriver>();
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
      const config = profileFromService(service, endpoint.address);
      const current = outputs.get(endpoint.id);
      if (
        !signal.aborted && current?.host === endpoint.address &&
        current.port === endpoint.port
      ) {
        if (
          !outputs.lifetime(endpoint.id).discovered ||
          (config.model !== undefined && current.model !== config.model)
        ) {
          outputs.register({
            ...current,
            model: config.model,
            requiresAuth: config.requiresAuth,
          }, { kind: 'internal', via: 'airplay-preparation' });
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
      if (service) outputs.register(row, source);
      else outputs.restore(row, source);
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
        name: string;
        host: string;
        port?: number;
        connectionStrategy?: OutputRegistration['connectionStrategy'];
      },
      source?: CommandSource,
    ) {
      const id = outputs.list().find((o) => o.host === input.host)?.id ??
        airplayOutputId(input.host);
      outputs.restore({
        id,
        name: input.name,
        host: input.host,
        type: 'AirPlay',
        selected: outputs.get(id)?.selected ?? false,
        volume: outputs.get(id)?.volume ?? 100,
        ...(input.port === undefined ? {} : { port: input.port }),
        ...(input.connectionStrategy === undefined
          ? {}
          : { connectionStrategy: input.connectionStrategy }),
      }, source);
      const controller = new AbortController();
      // Catalog preparation has no playback authority; permits are discarded.
      await protocol.prepare({
        id,
        targetRevision: admission.describe(id).targetRevision,
        signal: controller.signal,
        refresh: true,
        isCurrent: () => outputs.get(id) !== null,
      });
      await outputs.adopt(id);
      return outputs.get(id);
    },
    close() {
      resolver.close();
      admission.close();
    },
  };
}

export type AirplayDevices = ReturnType<typeof createAirplayDevices>;
