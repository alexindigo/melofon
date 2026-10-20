import type { Store } from './store/index.ts';
import type { State } from './state.ts';
import {
  type ReferenceName,
  referenceNames,
  type ReferenceType,
  type ReferenceValues,
} from './reference-types.ts';
import type { ReferenceCapability } from './lookups/manifest.ts';

export interface ReferenceProvider {
  plugin: string;
  capability: ReferenceCapability;
}
/** Reference policy owns settings and selection; the lookup runner alone owns
 * Workers and persistent job intake. Neither reads nor refreshes await a Worker. */
export function createReference(options: {
  store: Store;
  state: State;
  providers: (type: ReferenceType) => Promise<ReferenceProvider[]>;
  enqueue: (
    type: ReferenceType,
    id: string,
    providers: ReferenceProvider[],
  ) => Promise<void>;
  now?: () => number;
}) {
  const { store, state } = options;
  const now = options.now ?? Date.now;
  state.declare('reference.order', {
    type: 'array',
    items: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]*$' },
    default: [],
  });
  state.declare('reference.refreshHours', {
    type: 'number',
    minimum: 0.001,
    maximum: 87600,
    default: 24,
  });
  state.declare('reference.maxListItems', {
    type: 'integer',
    minimum: 1,
    maximum: 10000,
    default: 100,
  });
  const capLists = async (
    values: ReferenceValues,
  ): Promise<ReferenceValues> => {
    const max = await state.getTyped('reference.maxListItems') as number;
    return Object.fromEntries(
      Object.entries(values).map((
        [name, value],
      ) => [name, Array.isArray(value) ? value.slice(0, max) : value]),
    );
  };
  const providers = async (type: ReferenceType) => {
    const available = await options.providers(type);
    const order = await state.getTyped('reference.order') as string[];
    const rank = (plugin: string) => {
      const index = order.indexOf(plugin);
      return index < 0 ? order.length : index;
    };
    return available.sort((a, b) => rank(a.plugin) - rank(b.plugin));
  };
  return {
    async get(
      type: ReferenceType,
      id: string,
      names: readonly ReferenceName[],
    ): Promise<ReferenceValues> {
      if (!names.every((name) => referenceNames(type).includes(name))) {
        throw new Error('Reference name does not match entity type');
      }
      const available = await providers(type);
      const facts = await store.reference.get(type, id);
      const cutoff = now() -
        (await state.getTyped('reference.refreshHours') as number) * 3600000;
      const pending: ReferenceProvider[] = [];
      const selected: Record<string, unknown> = {};
      const stale: Record<string, unknown> = {};
      for (const provider of available) {
        let needsFetch = false;
        for (const name of names) {
          if (!provider.capability.provides.includes(name)) continue;
          const fact = facts.find((f) =>
            f.name === name && f.plugin === provider.plugin
          );
          if (!fact || fact.fetchedAtMs < cutoff) needsFetch = true;
          if (fact?.value == null) continue;
          const destination = fact.fetchedAtMs < cutoff ? stale : selected;
          if (!(name in destination)) destination[name] = fact.value;
        }
        if (needsFetch) pending.push(provider);
      }
      // Only local store intake is awaited, never plugin readiness/network/results.
      if (pending.length) await options.enqueue(type, id, pending);
      return capLists({ ...stale, ...selected } as ReferenceValues);
    },
    async refresh(type: ReferenceType, id: string): Promise<void> {
      await options.enqueue(type, id, await providers(type));
    },
    async record(
      type: ReferenceType,
      id: string,
      plugin: string,
      names: readonly ReferenceName[],
      values: ReferenceValues,
    ): Promise<void> {
      await store.reference.put(
        type,
        id,
        plugin,
        names,
        await capLists(values),
        now(),
      );
    },
  };
}
export type Reference = Pick<
  ReturnType<typeof createReference>,
  'get' | 'refresh'
>;
