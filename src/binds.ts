// src/binds.ts — which sockets core opens, and which layers are candidates on
// each. Hats only CLAIM default ports in manifest.json (`port`, number or
// list); they never bind. Core decides actual binds from the environment:
//
//   MELOFON_LISTEN_REPLACE_<claimed>=<actual>  global rewrite of a claimed
//                                              port; every hat that dibs
//                                              <claimed> shares <actual>
//   MELOFON_LISTEN_<layer>=p1,p2               per-layer actual ports,
//                                              positional on the claim list;
//                                              wins over REPLACE_ for that hat
//
// MELOFON_LISTEN itself (the default listen) is parsed in config.ts and is
// not this module's business. Core never hardcodes layer names — the env
// suffix IS the folder name.
import type { Layer } from './layers.ts';

export interface ListensEnv {
  /** Claimed port → actual port (MELOFON_LISTEN_REPLACE_<claimed>). */
  replace: Map<number, number>;
  /** Folder name → actual ports (MELOFON_LISTEN_<layer>). */
  perLayer: Map<string, number[]>;
}

function parseOnePort(key: string, raw: string): number {
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(
      `${key} must be a single port 1..65535, got ${JSON.stringify(raw)}`,
    );
  }
  return n;
}

function parsePortList(key: string, raw: string): number[] {
  return raw.split(',').map((piece) => parseOnePort(key, piece));
}

// Walk a plain env map (tests inject; main passes Deno.env.toObject()).
// Ignored: MELOFON_LISTEN, MELOFON_LISTEN_REPLACE without exactly one number,
// an empty layer suffix, and every other MELOFON_* key.
export function parseListensEnv(env: Record<string, string>): ListensEnv {
  const replace = new Map<number, number>();
  const perLayer = new Map<string, number[]>();
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith('MELOFON_LISTEN_')) continue;
    const rest = key.slice('MELOFON_LISTEN_'.length);
    if (rest === 'REPLACE' || rest.startsWith('REPLACE_')) {
      const m = /^REPLACE_(\d+)$/.exec(rest);
      if (m) replace.set(Number(m[1]), parseOnePort(key, value));
      continue;
    }
    if (rest === '') continue;
    perLayer.set(rest, parsePortList(key, value));
  }
  return { replace, perLayer };
}

function actualPortsParsed(
  layer: Pick<Layer, 'name' | 'ports'>,
  parsed: ListensEnv,
): number[] {
  if (layer.ports.length === 0) return [];
  const perLayer = parsed.perLayer.get(layer.name);
  if (perLayer !== undefined) {
    if (perLayer.length !== layer.ports.length) {
      throw new Error(
        `MELOFON_LISTEN_${layer.name} must list ${layer.ports.length} port(s) ` +
          `— one per claimed ${JSON.stringify(layer.ports)} — got ${
            JSON.stringify(perLayer)
          }`,
      );
    }
    return perLayer;
  }
  return layer.ports.map((claimed) => parsed.replace.get(claimed) ?? claimed);
}

// The actual ports a layer ends up on: [] when unported, the per-layer list
// when set (positional on the claim list), else each claim mapped through
// REPLACE_ (missing key → claimed as-is).
export function actualPorts(
  layer: Pick<Layer, 'name' | 'ports'>,
  env: Record<string, string>,
): number[] {
  return actualPortsParsed(layer, parseListensEnv(env));
}

// Candidates for one listen: the default bind (or no bind argument) serves
// unported layers only; an extra bind serves every layer whose actual ports
// include it. Several hats may share one extra bind the same way unported
// hats share the default listen.
export function candidatesForBind(
  layers: Layer[],
  bindPort: number | undefined,
  defaultPort: number | undefined,
  env: Record<string, string>,
): Layer[] {
  if (bindPort === undefined || bindPort === defaultPort) {
    return layers.filter((l) => l.ports.length === 0);
  }
  const parsed = parseListensEnv(env);
  return layers.filter((l) => actualPortsParsed(l, parsed).includes(bindPort));
}

export interface Binds {
  /** The actual port a layer's claim is bound to, after
   * MELOFON_LISTEN_<layer> / REPLACE_ — for hats that must name their own
   * port on the wire (OwnTone's /api/config websocket_port). The hat passes
   * its own folder name; core never hardcodes it. Unresolvable (unknown
   * layer, unclaimed port) → the claim itself. */
  actual(layerName: string, claimed: number): number;
}

export interface PortMapping {
  actual(layer: Pick<Layer, 'name' | 'ports'>): number[];
}

/** Parse once; malformed per-hat mappings fail only hats which use them. */
export function createPortMapping(env: Record<string, string>): PortMapping {
  const values = new Map<string, number[] | Error>();
  for (const [key, raw] of Object.entries(env)) {
    if (!key.startsWith('MELOFON_LISTEN_')) continue;
    try {
      values.set(key, parsePortList(key, raw));
    } catch (error) {
      values.set(
        key,
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }
  function read(key: string): number[] | undefined {
    const value = values.get(key);
    if (value instanceof Error) throw value;
    return value;
  }
  return {
    actual(layer) {
      if (layer.ports.length === 0) return [];
      const perLayer = read(`MELOFON_LISTEN_${layer.name}`);
      if (perLayer !== undefined) {
        if (perLayer.length !== layer.ports.length) {
          throw new Error(
            `MELOFON_LISTEN_${layer.name} must list ${layer.ports.length} port(s) — one per claimed ${
              JSON.stringify(layer.ports)
            } — got ${JSON.stringify(perLayer)}`,
          );
        }
        return [...perLayer];
      }
      return layer.ports.map((claimed) => {
        const replacement = read(`MELOFON_LISTEN_REPLACE_${claimed}`);
        if (replacement === undefined) return claimed;
        if (replacement.length !== 1) {
          throw new Error(
            `MELOFON_LISTEN_REPLACE_${claimed} must be a single port`,
          );
        }
        return replacement[0];
      });
    },
  };
}

// getLayers is lazy: the bag is built before loadLayers runs.
export function createBinds(
  getLayers: () => Layer[],
  env: Record<string, string> | PortMapping,
): Binds {
  const mapping = 'actual' in env && typeof env.actual === 'function'
    ? env as PortMapping
    : createPortMapping(env as Record<string, string>);
  return {
    actual(layerName, claimed) {
      const layer = getLayers().find((l) => l.name === layerName);
      if (layer === undefined) return claimed;
      const idx = layer.ports.indexOf(claimed);
      if (idx === -1) return claimed;
      return mapping.actual(layer)[idx];
    },
  };
}
