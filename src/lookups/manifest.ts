import { basename, resolve, sep } from 'node:path';
import {
  type ReferenceName,
  referenceNames,
  type ReferenceType,
} from '../reference-types.ts';
import {
  parseSettingsSchema,
  type SettingsSchema,
} from '../settings-schema.ts';

export const CONTRACT = 1;
export const HOST_PATTERN =
  '^(?:\\*\\.)?(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)(?:\\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*$';
export type CandidateCapability = {
  id: string;
  accepts: 'album';
  provides: ['album.image.front'];
  requires: string[];
} | {
  id: string;
  accepts: 'artist';
  provides: ['artist.image.primary'];
  requires: string[];
} | {
  id: string;
  accepts: 'track';
  provides: ['track.lyrics'];
  requires: string[];
};
export interface ReferenceCapability {
  id: string;
  accepts: ReferenceType;
  provides: ReferenceName[];
  requires: string[];
}
export type Capability = CandidateCapability | ReferenceCapability;
export function isReference(
  capability: Capability,
): capability is ReferenceCapability {
  return capability.accepts !== 'album' &&
    capability.provides[0] !== 'artist.image.primary' &&
    capability.provides[0] !== 'track.lyrics';
}
export interface Manifest {
  contract: 1;
  id: string;
  name: string;
  version: string;
  description?: string;
  website?: string;
  entry: string;
  capabilities: Capability[];
  network: { hosts: string[]; ratePerMinute: number; reason?: string };
  settings: Record<string, SettingsSchema>;
}
export interface DiscoveredPlugin {
  id: string;
  dir: string;
  manifest?: Manifest;
  error?: string;
}
/** Directory read scopes follow symlinks. Validate code and data before
 * granting the folder to an isolate that cannot itself mutate its contents. */
export async function validatePluginTree(dir: string): Promise<void> {
  const walk = async (path: string) => {
    for await (const entry of Deno.readDir(path)) {
      const child = `${path}/${entry.name}`;
      if (entry.isSymlink) {
        const target = await Deno.realPath(child);
        if (target !== dir && !target.startsWith(`${dir}${sep}`)) {
          throw new Error('Symlink escapes plugin folder');
        }
      } else if (entry.isDirectory) await walk(child);
    }
  };
  await walk(dir);
}
export function object(raw: unknown, keys: string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Expected an object');
  }
  for (const key of Object.keys(raw)) {
    if (!keys.includes(key)) throw new Error(`Unknown key: ${key}`);
  }
  return raw as Record<string, unknown>;
}
function text(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error('Expected a nonempty string');
  }
  return raw;
}
export function hostPattern(raw: unknown): string {
  const value = text(raw).toLowerCase();
  if (
    !new RegExp(HOST_PATTERN).test(value)
  ) {
    throw new Error(`Invalid network host: ${value}`);
  }
  return value;
}
function strings(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new Error('Expected an array');
  return raw.map(text);
}
function dataName(name: string): boolean {
  if (
    [...referenceNames('artist'), ...referenceNames('track')].includes(
      name as ReferenceName,
    )
  ) return true;
  return /^(?:album\.image\.(?:front|back|disc|booklet)|artist\.image\.(?:primary|backdrop)|album\.(?:name|year|artist|discs|genre|notes)|track\.(?:title|artist|number|disc|genre|lyrics)|artist\.biography|(?:album|track|artist)\.id\.[a-z][a-z0-9-]*|file\.track|folder\.album)$/
    .test(name);
}
export function parseManifest(raw: unknown, id: string): Manifest {
  const m = object(raw, [
    'contract',
    'id',
    'name',
    'version',
    'description',
    'website',
    'entry',
    'capabilities',
    'network',
    'settings',
  ]);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error('Invalid plugin id');
  if (m.contract !== CONTRACT) throw new Error('Unsupported lookup contract');
  if (m.id !== undefined && m.id !== id) {
    throw new Error('id must equal the folder name');
  }
  const entry = m.entry === undefined ? 'index.ts' : text(m.entry);
  if (
    basename(entry) !== entry || !/^[a-zA-Z0-9_-]+\.(?:ts|js|mjs)$/.test(entry)
  ) {
    throw new Error('Entry must be a plain code file name');
  }
  if (!Array.isArray(m.capabilities) || !m.capabilities.length) {
    throw new Error('At least one capability is required');
  }
  const ids = new Set<string>();
  const capabilities = m.capabilities.map((raw): Capability => {
    const c = object(raw, ['id', 'accepts', 'provides', 'requires']);
    const cid = text(c.id);
    if (ids.has(cid) || !/^[a-z0-9][a-z0-9-]*$/.test(cid)) {
      throw new Error('Invalid or duplicate capability id');
    }
    ids.add(cid);
    if (
      c.accepts !== 'album' && c.accepts !== 'artist' && c.accepts !== 'track'
    ) {
      throw new Error(`${c.accepts}: not supported yet`);
    }
    const provides = strings(c.provides);
    if (
      !provides.length || new Set(provides).size !== provides.length ||
      (c.accepts === 'album'
        ? provides.length !== 1 || provides[0] !== 'album.image.front'
        : c.accepts === 'artist' && provides.length === 1 &&
            provides[0] === 'artist.image.primary'
        ? false
        : c.accepts === 'track' && provides.length === 1 &&
            provides[0] === 'track.lyrics'
        ? false
        : !provides.every((name) =>
          referenceNames(c.accepts as ReferenceType).includes(
            name as ReferenceName,
          )
        ))
    ) {
      throw new Error('Output not supported yet');
    }
    const requires = strings(c.requires ?? []);
    if (!requires.every(dataName)) {
      throw new Error('Unknown requires data name');
    }
    return c.accepts === 'album'
      ? { id: cid, accepts: 'album', provides: ['album.image.front'], requires }
      : c.accepts === 'artist' && provides[0] === 'artist.image.primary'
      ? {
        id: cid,
        accepts: 'artist',
        provides: ['artist.image.primary'],
        requires,
      }
      : c.accepts === 'track' && provides[0] === 'track.lyrics'
      ? { id: cid, accepts: 'track', provides: ['track.lyrics'], requires }
      : {
        id: cid,
        accepts: c.accepts,
        provides: provides as ReferenceName[],
        requires,
      };
  });
  const n = object(m.network ?? { hosts: [], ratePerMinute: 60 }, [
    'hosts',
    'reason',
    'ratePerMinute',
  ]);
  const hosts = strings(n.hosts).map(hostPattern);
  if (
    typeof n.ratePerMinute !== 'number' ||
    !Number.isSafeInteger(n.ratePerMinute) || n.ratePerMinute < 1
  ) throw new Error('Invalid ratePerMinute');
  const settings: Record<string, SettingsSchema> = {};
  if (m.settings !== undefined) {
    const schema = object(m.settings, ['type', 'properties']);
    if (schema.type !== 'object') {
      throw new Error('Settings must be an object schema');
    }
    if (
      !schema.properties || typeof schema.properties !== 'object' ||
      Array.isArray(schema.properties)
    ) throw new Error('Settings properties must be an object');
    for (const [key, raw] of Object.entries(schema.properties)) {
      if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(key)) {
        throw new Error('Invalid setting name');
      }
      settings[key] = parseSettingsSchema(raw);
    }
  }
  return {
    contract: 1,
    id,
    name: text(m.name),
    version: text(m.version),
    entry,
    capabilities,
    network: {
      hosts,
      ratePerMinute: n.ratePerMinute,
      ...(n.reason === undefined ? {} : { reason: text(n.reason) }),
    },
    settings,
    ...(m.description === undefined
      ? {}
      : { description: text(m.description) }),
    ...(m.website === undefined ? {} : { website: text(m.website) }),
  };
}

/** Select overrides before parsing: a broken operator copy is never hidden. */
export async function discoverLookups(
  builtin: string,
  dataDir: string,
): Promise<DiscoveredPlugin[]> {
  const dirs = new Map<string, string>();
  for (const root of [builtin, `${dataDir}/plugins/lookups`]) {
    try {
      for await (const entry of Deno.readDir(root)) {
        if (entry.isDirectory || entry.isSymlink) {
          dirs.set(entry.name, resolve(root, entry.name));
        }
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  return await Promise.all(
    [...dirs].sort(([a], [b]) => a.localeCompare(b)).map(async ([id, dir]) => {
      try {
        const realDir = await Deno.realPath(dir);
        if (realDir !== dir) {
          throw new Error('Plugin folder must not be a symlink');
        }
        await validatePluginTree(realDir);
        const manifest = parseManifest(
          JSON.parse(await Deno.readTextFile(`${dir}/manifest.json`)),
          id,
        );
        const entry = await Deno.realPath(`${dir}/${manifest.entry}`);
        if (!entry.startsWith(`${realDir}${sep}`)) {
          throw new Error('Entry escapes plugin folder');
        }
        if (!(await Deno.stat(entry)).isFile) {
          throw new Error('Entry is not a file');
        }
        return { id, dir, manifest };
      } catch (error) {
        return { id, dir, error: String(error) };
      }
    }),
  );
}
