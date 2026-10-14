// Compile the native source-address probe against this workspace's graph.
import { assertEquals, assertStringIncludes } from '@std/assert';
import { startFakeRaop } from './helpers/fake-raop.ts';
import { NATIVE_CHANGED } from './helpers/native-changes.ts';

const nativeRoot = decodeURIComponent(
  new URL('../helper/raop/', import.meta.url).pathname,
);
const packages = [
  'libevent',
  'libavcodec',
  'libavformat',
  'libavfilter',
  'libavutil',
  'json-c',
  'libsodium',
  'libplist-2.0',
  'libgcrypt',
  'uuid',
  'libcurl',
];
const sources = [
  'test/probe_sources.c', // Includes vendored raop.c exactly once.
  'ffi.c',
  'player.c',
  'stub/stubs.c',
  'vendor/outputs/rtp_common.c',
  'vendor/evrtsp/rtsp.c',
  'vendor/pair_ap/pair.c',
  'vendor/pair_ap/pair_fruit.c',
  'vendor/pair_ap/pair_homekit.c',
  'vendor/pair_ap/pair-tlv.c',
  'vendor/transcode.c',
  'vendor/misc.c',
];

function childEnvironment() {
  return Object.fromEntries(
    Object.entries(Deno.env.toObject()).filter(([key]) =>
      key !== 'LD_PRELOAD' && key !== 'MELOFON_RAOP_LIB' &&
      !key.startsWith('MELOFON_RAOP_FAULT')
    ),
  );
}

async function build(directory: string) {
  const env = childEnvironment();
  const decoder = new TextDecoder();
  const pc = await new Deno.Command('pkg-config', {
    args: ['--cflags', '--libs', ...packages],
    env,
    clearEnv: true,
  }).output();
  assertEquals(pc.code, 0, decoder.decode(pc.stderr));
  const args = [
    '-O1',
    '-g',
    '-DHAVE_CONFIG_H',
    '-D_GNU_SOURCE',
    '-DCONFIG_GCRYPT=1',
    '-Wall',
    '-Wno-unused',
    '-I',
    'stub',
    '-I',
    'vendor',
    '-I',
    'vendor/outputs',
    '-I',
    'vendor/evrtsp',
    '-o',
    `${directory}/probe`,
    ...sources,
    ...decoder.decode(pc.stdout).trim().split(/\s+/),
    '-levent_pthreads',
    '-lgpg-error',
    '-lunistring',
    '-lpthread',
    '-lm',
  ];
  const cc = await new Deno.Command('cc', {
    args,
    cwd: nativeRoot,
    env,
    clearEnv: true,
  }).output();
  assertEquals(cc.code, 0, decoder.decode(cc.stderr));
  return `${directory}/probe`;
}

Deno.test({
  name: 'native source probe: session mode against fake receiver exits 0',
  ignore: !NATIVE_CHANGED,
  // The shared fake receiver owns asynchronous socket-close callbacks.
  // Receiver closure is asserted explicitly in finally.
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const directory = await Deno.makeTempDir({ prefix: 'raop-source-probe-' });
    try {
      const probe = await build(directory);
      const receiver = await startFakeRaop();
      try {
        const run = await new Deno.Command(probe, {
          args: [String(receiver.port)],
          env: childEnvironment(),
          clearEnv: true,
          signal: AbortSignal.timeout(30_000),
        }).output();
        assertEquals(run.code, 0, new TextDecoder().decode(run.stderr));
      } finally {
        receiver.close();
      }
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  },
});

Deno.test({
  name: 'native source probe: address contracts in rootless netns',
  ignore: !NATIVE_CHANGED,
  fn: async () => {
    const directory = await Deno.makeTempDir({ prefix: 'raop-source-probe-' });
    try {
      const probe = await build(directory);
      const run = await new Deno.Command('unshare', {
        args: ['--user', '--net', probe],
        env: childEnvironment(),
        clearEnv: true,
        signal: AbortSignal.timeout(30_000),
      }).output();
      const decoder = new TextDecoder();
      assertEquals(run.code, 0, decoder.decode(run.stderr));
      assertStringIncludes(decoder.decode(run.stdout), 'SOURCE-CONTRACTS-OK');
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  },
});
