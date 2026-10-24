// Admin projection over lookup hosts and the existing settings service. All
// mutations use one settings batch; neither this service nor the hat owns state.
import type { Store } from './store/index.ts';
import type { createSettings } from './settings.ts';
import type { createLookupRunner } from './lookups/runner.ts';
import type { SettingDescription } from './state.ts';
import { UserError } from './user-errors.ts';
import { SettingsError } from './settings-errors.ts';
import { hostPattern } from './lookups/manifest.ts';
import { intersectHosts } from './lookups/net.ts';

export class PluginError extends Error {
  override name = 'PluginError';
  constructor(
    readonly code: 'not_found' | 'host_not_requested',
    message: string,
  ) {
    super(message);
  }
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function createPlugins(
  store: Pick<Store, 'users'>,
  runner: Pick<Awaited<ReturnType<typeof createLookupRunner>>, 'list'>,
  settings: ReturnType<typeof createSettings>,
) {
  const admin = async (caller: string) => {
    if ((await store.users.byId(caller))?.role !== 'admin') {
      throw new UserError('forbidden');
    }
  };
  const target = async (id: string) => {
    const plugin = (await runner.list()).find((p) => p.id === id);
    if (!plugin) throw new PluginError('not_found', 'Plugin not found');
    return plugin;
  };
  async function detail(caller: string, id: string) {
    const plugin = await target(id);
    const prefix = `lookups.plugin.${id}`;
    const rows = (await settings.describe(caller)).filter((s) =>
      plugin.settingKeys.includes(s.key)
    );
    const form = rows.filter((s) => s.key.startsWith(`${prefix}.settings.`));
    const name = (s: SettingDescription) =>
      s.key.slice(`${prefix}.settings.`.length);
    return {
      ...plugin,
      enabled: rows.find((s) => s.key === `${prefix}.enabled`)!.value,
      hosts: rows.find((s) => s.key === `${prefix}.hosts`)!.value,
      settings: {
        schema: {
          type: 'object' as const,
          properties: Object.fromEntries(form.map((s) => [name(s), {
            ...s.schema,
            ...(s.writeOnly
              ? { writeOnly: true }
              : s.default === null
              ? {}
              : { default: s.default }),
          }])),
        },
        values: Object.fromEntries(form.map((s) => [
          name(s),
          s.writeOnly ? { isSet: s.isSet } : s.value,
        ])),
        // Canonical a6 keys, including enabled/hosts: the same revision tokens
        // work through both admin surfaces without another revision scheme.
        revisions: Object.fromEntries(rows.map((s) => [s.key, s.revision])),
      },
    };
  }
  return Object.freeze({
    async list(caller: string) {
      await admin(caller);
      return { plugins: await runner.list() };
    },
    async get(caller: string, id: string) {
      await admin(caller);
      return detail(caller, id);
    },
    async change(caller: string, id: string, input: unknown) {
      await admin(caller);
      const plugin = await target(id);
      const invalid = (message: string, key?: string): never => {
        throw new SettingsError('invalid_value', message, key);
      };
      if (!object(input)) invalid('Expected an object');
      const body = input as Record<string, unknown>;
      if (
        Object.keys(body).some((k) =>
          !['enabled', 'hosts', 'settings', 'revisions'].includes(k)
        )
      ) {
        invalid('Unknown plugin change field');
      }
      if ('settings' in body && !object(body.settings)) {
        invalid('settings must be an object');
      }
      if ('revisions' in body && !object(body.revisions)) {
        invalid('revisions must be an object');
      }
      const prefix = `lookups.plugin.${id}`;
      const values = new Map<string, unknown>();
      for (const key of ['enabled', 'hosts']) {
        if (key in body) values.set(`${prefix}.${key}`, body[key]);
      }
      for (const [key, value] of Object.entries(body.settings ?? {})) {
        const full = `${prefix}.settings.${key}`;
        if (!plugin.settingKeys.includes(full)) {
          invalid('Unknown plugin setting', full);
        }
        values.set(full, value);
      }
      const revisions = (body.revisions ?? {}) as Record<string, unknown>;
      for (const [key, revision] of Object.entries(revisions)) {
        if (
          !values.has(key) || !Number.isSafeInteger(revision) ||
          (revision as number) < 0
        ) {
          invalid(
            'revision must be a non-negative safe integer for a changed key',
            key,
          );
        }
      }
      if (
        Array.isArray(body.hosts) &&
        body.hosts.every((h) => typeof h === 'string')
      ) {
        const approved = body.hosts.map((host) => {
          try {
            return hostPattern(host);
          } catch {
            return invalid('Invalid network host', `${prefix}.hosts`);
          }
        });
        const requested = plugin.network.requestedHosts.map((h) => h.host);
        const permitted = intersectHosts(requested, approved);
        if (approved.some((host) => !permitted.includes(host))) {
          throw new PluginError(
            'host_not_requested',
            'Approved hosts must be requested by the plugin',
          );
        }
        values.set(`${prefix}.hosts`, approved);
      }
      await settings.change(
        caller,
        [...values].map(([key, value]) => ({
          key,
          ...(value === null ? { reset: true } : { value }),
          ...(Object.hasOwn(revisions, key)
            ? { revision: revisions[key] }
            : {}),
        })),
      );
      // The settings write and runner configuration have been applied. Worker
      // startup is asynchronous, so this may truthfully return starting.
      return detail(caller, id);
    },
  });
}
