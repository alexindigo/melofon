// Compile this workspace's actual native graph; no checkout .so or interposer.
import { assert, assertEquals } from '@std/assert';
import { startFakeRaop } from './helpers/fake-raop.ts';
import { decodeReceiverAudio } from './helpers/raop-audio-consumer.ts';

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
  'test/probe_player_epoch.c', // Includes vendored raop.c exactly once.
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
type Observation = {
  checkpoint?: string;
  pendingBytes?: number;
  pendingFrames?: number;
  bytesMatch?: boolean;
  peerConnected?: boolean;
  sameMaster?: boolean;
  aLocalReleased?: boolean;
  ok?: boolean;
  packetReady?: boolean;
  cleanup?: boolean;
  freeA?: number;
  freeB?: number;
};

function childEnvironment() {
  return Object.fromEntries(
    Object.entries(Deno.env.toObject()).filter(([key]) =>
      key !== 'LD_PRELOAD' && key !== 'MELOFON_RAOP_LIB' &&
      !key.startsWith('MELOFON_RAOP_FAULT')
    ),
  );
}

async function until(what: string, predicate: () => boolean) {
  const deadline = performance.now() + 15000;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error(`timed out: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function peerPcm() {
  const pcm = new Uint8Array(452 * 4);
  const view = new DataView(pcm.buffer);
  for (let i = 0; i < 452; i++) {
    view.setInt16(i * 4, 1000 + i * 13, true);
    view.setInt16(i * 4 + 2, -2000 - i * 17, true);
  }
  return pcm;
}

for (
  const scenario of [
    'reuse',
    'never-fed',
    'successive',
    'repeated-stop',
    'notifications',
    'flush',
    'read-ahead',
  ]
) {
  Deno.test({
    name:
      `native player epoch: ${scenario} preserves byte-exact surviving feed`,
    // The shared fake receiver owns asynchronous socket-close callbacks.
    // Native cleanup, process exit and receiver closure are asserted explicitly.
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      const evidence = Deno.env.get('MELOFON_RAOP_EPOCH_EVIDENCE');
      const directory = evidence
        ? `${evidence}/${scenario}`
        : await Deno.makeTempDir({ prefix: 'raop-player-epoch-' });
      if (evidence) await Deno.mkdir(directory, { mode: 0o700 });
      const env = childEnvironment();
      const decoder = new TextDecoder();
      const pcArgs = ['--cflags', '--libs', ...packages];
      const pc = await new Deno.Command('pkg-config', {
        args: pcArgs,
        env,
        clearEnv: true,
      }).output();
      await Deno.writeTextFile(
        `${directory}/pkg-config.json`,
        JSON.stringify({ args: pcArgs, code: pc.code }),
      );
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
      const build = await new Deno.Command('cc', {
        args,
        cwd: nativeRoot,
        env,
        clearEnv: true,
      }).output();
      await Deno.writeTextFile(
        `${directory}/build.json`,
        JSON.stringify({
          command: 'cc',
          args,
          cwd: nativeRoot,
          code: build.code,
        }),
      );
      await Deno.writeFile(`${directory}/build.stdout`, build.stdout);
      await Deno.writeFile(`${directory}/build.stderr`, build.stderr);
      assertEquals(build.code, 0, decoder.decode(build.stderr));

      const a = await startFakeRaop({ captureAudio: true });
      const b = await startFakeRaop({ captureAudio: true });
      const probeArgs = [scenario, String(a.port), String(b.port)];
      const child = new Deno.Command(`${directory}/probe`, {
        args: probeArgs,
        env,
        clearEnv: true,
        stdin: 'piped',
        stdout: 'piped',
        stderr: 'piped',
      }).spawn();
      const observations: Observation[] = [];
      let stdout = '', finished = false;
      const read = (async () => {
        let pending = '';
        for await (
          const chunk of child.stdout.pipeThrough(new TextDecoderStream())
        ) {
          stdout += chunk;
          pending += chunk;
          let end;
          while ((end = pending.indexOf('\n')) >= 0) {
            observations.push(JSON.parse(pending.slice(0, end)));
            pending = pending.slice(end + 1);
          }
        }
        assertEquals(pending, '');
      })();
      const stderr = new Response(child.stderr).text();
      const status = child.status.then((value) => {
        finished = true;
        return value;
      });
      try {
        await until(
          'native packet formation or explicit setup failure',
          () => finished || observations.some((o) => o.packetReady),
        );
        assert(!finished, `native setup failed: ${stdout}`);
        await until(
          'receiver audio packet',
          () => b.sessions[0]?.audioPackets > 0,
        );
        const session = b.sessions[0];
        const beforeCleanup = structuredClone(b.sessions);
        const actual = decodeReceiverAudio(
          session.sdp,
          session.audioPayloads.slice(0, 1),
        );
        const pcm = peerPcm();
        const expected = pcm.slice(0, 352 * 4);
        const actualOffset = Array.from({ length: 101 }, (_, i) =>
          i).find((i) =>
            actual.length === expected.length &&
            actual.every((value, j) => value === pcm[i * 4 + j])
          ) ?? -1;
        await Deno.writeFile(`${directory}/expected.pcm`, expected);
        await Deno.writeFile(`${directory}/actual.pcm`, actual);
        await Deno.writeTextFile(
          `${directory}/consumer.json`,
          JSON.stringify({
            expectedOffset: 0,
            actualOffset,
            frames: actual.length / 4,
          }),
        );
        await Deno.writeTextFile(
          `${directory}/receiver-before-cleanup.json`,
          JSON.stringify(beforeCleanup),
        );
        const writer = child.stdin.getWriter();
        await writer.write(new TextEncoder().encode('captured\n'));
        await writer.close();
        writer.releaseLock();
        await until('owned native process exit', () => finished);
        const exit = await status;
        await read;
        assertEquals(exit.code, 0, await stderr);
        assertEquals(observations.at(-1), {
          cleanup: true,
          freeA: 0,
          freeB: 0,
        });
        await until(
          'native receiver connections closed',
          () =>
            [...a.sessions, ...b.sessions].every((s) => s.closedAtMs !== null),
        );
        assertEquals(beforeCleanup.length, 1, 'B must retain its sole session');
        assertEquals(
          session.audioPackets,
          1,
          'one complete packet, no synthetic padding',
        );
        assertEquals(beforeCleanup[0].flushes, 0);
        assertEquals(beforeCleanup[0].teardowns, 0);
        assertEquals(beforeCleanup[0].closedAtMs, null);
        assertEquals(
          a.sessions.length,
          scenario === 'reuse' || scenario === 'successive' ? 2 : 1,
        );
        for (const s of [...a.sessions, ...b.sessions]) {
          for (const method of ['ANNOUNCE', 'SETUP', 'RECORD']) {
            assert(
              s.requests.some((r) => r.method === method),
              `missing ${method}`,
            );
          }
        }
        for (const o of observations.filter((o) => o.checkpoint)) {
          assert(o.ok && o.sameMaster && o.peerConnected, JSON.stringify(o));
        }
        // Consumer failure comes before the intermediate pending-input assertion.
        assertEquals(
          actualOffset,
          0,
          'receiver decoded prefix lost: expected B frame 0',
        );
        assertEquals(
          actual,
          expected,
          'complete receiver-decoded 352-frame block',
        );
        const prefix = observations.find((o) =>
          o.checkpoint?.startsWith('B-prefix-after') ||
          o.checkpoint === 'B-surviving-prefix'
        );
        assertEquals(prefix?.pendingFrames, 100);
        assertEquals(prefix?.pendingBytes, 400);
        assertEquals(prefix?.bytesMatch, true);
      } finally {
        if (!finished) child.kill('SIGKILL');
        const exit = await status;
        await read;
        await Deno.writeTextFile(`${directory}/native.stdout`, stdout);
        await Deno.writeTextFile(`${directory}/native.stderr`, await stderr);
        await Deno.writeTextFile(
          `${directory}/native.json`,
          JSON.stringify({
            command: `${directory}/probe`,
            args: probeArgs,
            code: exit.code,
            observations,
          }),
        );
        await Deno.writeTextFile(
          `${directory}/receivers-final.json`,
          JSON.stringify({ a: a.sessions, b: b.sessions }),
        );
        a.close();
        b.close();
        if (!evidence) await Deno.remove(directory, { recursive: true });
      }
    },
  });
}
