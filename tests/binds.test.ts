// tests/binds.test.ts — listen env policy: MELOFON_LISTEN_REPLACE_<claimed>
// rewrites a claimed port for every hat that dibs it; MELOFON_LISTEN_<layer>
// gives one hat its own positional list and wins over REPLACE_ for that hat.
// Unported hats stay on the default listen no matter what the env says.
import { assertEquals, assertThrows } from '@std/assert';
import {
  actualPorts,
  candidatesForBind,
  parseListensEnv,
} from '../src/binds.ts';
import type { Layer } from '../src/layers.ts';

function hat(name: string, ports: number[]): Layer {
  return {
    name,
    ports,
    mounts: [],
    headers: [],
    dir: `tests/fixtures/layers/${name}`,
  };
}

Deno.test('env parse: replace map, per-layer lists, and the ignored keys', () => {
  const parsed = parseListensEnv({
    MELOFON_LISTEN: '0.0.0.0:4534', // the default listen — not this module
    MELOFON_LISTEN_REPLACE: '4000', // REPLACE without a number — ignored
    MELOFON_LISTEN_REPLACE_3689: '4000',
    MELOFON_LISTEN_REPLACE_3688: '4001',
    'MELOFON_LISTEN_layer-p': '3690, 3691',
    MELOFON_DATA: '/tmp/x', // every other MELOFON_* — ignored
  });
  assertEquals(parsed.replace.get(3689), 4000);
  assertEquals(parsed.replace.get(3688), 4001);
  assertEquals(parsed.replace.size, 2);
  assertEquals(parsed.perLayer.get('layer-p'), [3690, 3691]);
  assertEquals(parsed.perLayer.size, 1);
});

Deno.test('env parse: malformed port values throw naming the key', () => {
  assertThrows(
    () => parseListensEnv({ MELOFON_LISTEN_REPLACE_3689: 'not-a-port' }),
    Error,
    'MELOFON_LISTEN_REPLACE_3689',
  );
  assertThrows(
    () => parseListensEnv({ MELOFON_LISTEN_REPLACE_3689: '4000,4001' }),
    Error,
    'single port',
  );
  assertThrows(
    () => parseListensEnv({ 'MELOFON_LISTEN_layer-p': '3690,0' }),
    Error,
    'MELOFON_LISTEN_layer-p',
  );
});

Deno.test('actualPorts: unported claims nothing, no env claims as-is', () => {
  assertEquals(actualPorts(hat('layer-a', []), {}), []);
  assertEquals(actualPorts(hat('layer-p', [3689]), {}), [3689]);
  assertEquals(actualPorts(hat('layer-two', [3689, 3688]), {}), [3689, 3688]);
});

Deno.test('actualPorts: REPLACE_ rewrites the claim for every hat that dibs it', () => {
  const env = { MELOFON_LISTEN_REPLACE_3689: '4000' };
  assertEquals(actualPorts(hat('layer-p', [3689]), env), [4000]);
  assertEquals(actualPorts(hat('layer-q', [3689]), env), [4000]);
  // A claim with no REPLACE_ key stays as-is.
  assertEquals(actualPorts(hat('layer-two', [3689, 3688]), env), [4000, 3688]);
});

Deno.test('actualPorts: per-layer list is positional and wins over REPLACE_', () => {
  assertEquals(
    actualPorts(hat('layer-two', [3689, 3688]), {
      'MELOFON_LISTEN_layer-two': '4100,4101',
    }),
    [4100, 4101],
  );
  const env = {
    MELOFON_LISTEN_REPLACE_3689: '4000',
    'MELOFON_LISTEN_layer-p': '3690',
  };
  assertEquals(actualPorts(hat('layer-p', [3689]), env), [3690]);
  assertEquals(actualPorts(hat('layer-q', [3689]), env), [4000]);
});

Deno.test('actualPorts: per-layer list must match the claim list length', () => {
  assertThrows(
    () =>
      actualPorts(hat('layer-two', [3689, 3688]), {
        'MELOFON_LISTEN_layer-two': '4100',
      }),
    Error,
    'must list 2 port(s)',
  );
});

Deno.test('candidatesForBind: the default bind serves unported layers only', () => {
  const layers = [
    hat('layer-a', []),
    hat('layer-p', [3689]),
    hat('layer-q', [3689]),
    hat('layer-two', [3689, 3688]),
  ];
  const names = (ls: Layer[]) => ls.map((l) => l.name);
  assertEquals(names(candidatesForBind(layers, undefined, 4534, {})), [
    'layer-a',
  ]);
  // The default port spelled out is still the default bind.
  assertEquals(names(candidatesForBind(layers, 4534, 4534, {})), ['layer-a']);
});

Deno.test('candidatesForBind: a shared extra bind serves every hat on it', () => {
  const layers = [
    hat('layer-a', []),
    hat('layer-p', [3689]),
    hat('layer-q', [3689]),
    hat('layer-two', [3689, 3688]),
  ];
  const names = (ls: Layer[]) => ls.map((l) => l.name);
  assertEquals(names(candidatesForBind(layers, 3689, 4534, {})), [
    'layer-p',
    'layer-q',
    'layer-two',
  ]);
  assertEquals(names(candidatesForBind(layers, 3688, 4534, {})), ['layer-two']);
  // REPLACE_ moves the whole claim: 3689 goes quiet, 4000 takes the hats.
  const env = { MELOFON_LISTEN_REPLACE_3689: '4000' };
  assertEquals(names(candidatesForBind(layers, 3689, 4534, env)), []);
  assertEquals(names(candidatesForBind(layers, 4000, 4534, env)), [
    'layer-p',
    'layer-q',
    'layer-two',
  ]);
  // A per-layer list peels one hat off the shared bind.
  const perLayer = { 'MELOFON_LISTEN_layer-p': '3690' };
  assertEquals(names(candidatesForBind(layers, 3690, 4534, perLayer)), [
    'layer-p',
  ]);
  assertEquals(names(candidatesForBind(layers, 3689, 4534, perLayer)), [
    'layer-q',
    'layer-two',
  ]);
});
