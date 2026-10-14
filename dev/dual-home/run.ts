// VM-only kernel regression. Network mutations occur exclusively inside an
// owned rootless user/network namespace with two veth paths and NO uplink.
import { assert, assertEquals } from '@std/assert';
import { Rpc } from './rpc.ts';
import { writeFixture } from './fixture.ts';
import type { ReceiverSession, SenderStatus } from './worker.ts';

const UUID = '1af2f55f-5461-48c1-bb2d-b2d9d6c3d1c3';
const ROOT = '/home/tester/melofon-output-preparation-01/dual-home-01';
const script = new URL(import.meta.url).pathname;
const arg = (key: string) =>
  Deno.args.find((v) => v.startsWith(`--${key}=`))?.split('=').slice(1).join(
    '=',
  );
const role = arg('role');
const candidate = arg('candidate-root') ?? '';
const library = arg('library') ?? '';
const evidence = arg('evidence') ?? '';
const scenarios = arg('scenarios') ?? 'all';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const parentNet = arg('parent-net');

// UUID sysfs is root-readable on this guest. The outer process performs ONLY
// this privileged read; child roles inherit its validated identity and run all
// topology operations in the already-owned rootless namespace.
if (!role) {
  const identity = await new Deno.Command('sudo', {
    args: ['-n', 'cat', '/sys/class/dmi/id/product_uuid'],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  assert(identity.success, 'VM UUID inspection required before any workload');
  assertEquals(
    new TextDecoder().decode(identity.stdout).trim().toLowerCase(),
    UUID,
    'driver refuses any other VM or physical host',
  );
} else {assertEquals(
    Deno.env.get('MELOFON_DUAL_HOME_VERIFIED_VM'),
    UUID,
    'outer VM identity lease required',
  );}
for (const path of [candidate, library, evidence]) {
  assert(
    path.startsWith(ROOT + '/') && !path.split('/').includes('..'),
    'owned disk-backed workspace required',
  );
}
assert(
  !Deno.env.get('LD_PRELOAD'),
  'kernel proof uses production native library without interposers',
);
const net = await Deno.readLink('/proc/self/ns/net');
if (role) {
  assert(
    parentNet && net !== parentNet,
    'worker must be inside isolated topology',
  );
}

async function command(program: string, args: string[]) {
  const result = await new Deno.Command(program, {
    args,
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stdout = new TextDecoder().decode(result.stdout);
  assert(
    result.success,
    `${program} ${args.join(' ')} failed: ${
      new TextDecoder().decode(result.stderr)
    }`,
  );
  return stdout;
}
const denoArgs = (childRole: string, extra: string[] = []) => [
  'run',
  '--frozen',
  '--cached-only',
  '--node-modules-dir=auto',
  '--allow-run',
  '--allow-net',
  '--allow-env',
  '--allow-read',
  '--allow-write',
  '--allow-ffi',
  '--allow-sys',
  script,
  `--role=${childRole}`,
  `--candidate-root=${candidate}`,
  `--library=${library}`,
  `--evidence=${evidence}`,
  `--scenarios=${scenarios}`,
  `--parent-net=${parentNet ?? net}`,
  ...extra,
];

if (!role) {
  await Deno.mkdir(evidence, { mode: 0o700 });
  const initialRoutes = await command('ip', [
    '-j',
    'route',
    'show',
    'table',
    'all',
  ]);
  const result = await new Deno.Command('unshare', {
    args: [
      '--user',
      '--map-root-user',
      '--net',
      Deno.execPath(),
      ...denoArgs('controller'),
    ],
    env: {
      TMPDIR: `${ROOT}/tmp`,
      MELOFON_RAOP_LIB: library,
      MELOFON_DUAL_HOME_VERIFIED_VM: UUID,
    },
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  await Deno.writeFile(`${evidence}/controller.stdout.log`, result.stdout);
  await Deno.writeFile(`${evidence}/controller.stderr.log`, result.stderr);
  assertEquals(
    await command('ip', ['-j', 'route', 'show', 'table', 'all']),
    initialRoutes,
    'guest management routes untouched',
  );
  await Deno.writeTextFile(
    `${evidence}/outer-result.json`,
    JSON.stringify(
      {
        uuid: UUID,
        candidate,
        library,
        exit: result.code,
        guestRoutesUnchanged: true,
        initialNet: net,
        cleanup: 'rootless controller and owned children exited',
      },
      null,
      2,
    ),
  );
  console.log(new TextDecoder().decode(result.stdout));
  console.error(new TextDecoder().decode(result.stderr));
  assert(
    result.success,
    'dual-home kernel regression failed; retained evidence',
  );
  console.log('dual-home: PASS');
} else if (role === 'receiver') {
  const { receiver } = await import('./worker.ts');
  await receiver(arg('ready')!, arg('startup') === 'true');
} else if (role === 'sender') {
  const { sender } = await import('./worker.ts');
  await sender(candidate, library);
} else if (role === 'controller') {
  assertEquals((await command('ip', ['-j', 'link'])).includes('enp1s0'), false);
  const ip = (...args: string[]) => command('ip', args);
  const addresses = { wifi: '192.0.2.138', ethernet: '198.51.100.201' };
  type Path = keyof typeof addresses;
  const metric = async (preferred: Path) => {
    // Replace only this isolated receiver's two explicit routes; old addresses
    // and interfaces stay present. This is NOT a link-failure approximation.
    // Replace metric slots atomically; deleting both routes first would inject
    // an unintended no-route failure into a metric-only/rapid-flap scenario.
    const standby: Path = preferred === 'wifi' ? 'ethernet' : 'wifi';
    for (const name of [preferred, standby]) {
      const gateway = name === 'wifi' ? '192.0.2.1' : '198.51.100.1';
      await ip(
        'route',
        'replace',
        '203.0.113.10/32',
        'via',
        gateway,
        'dev',
        name,
        'src',
        addresses[name],
        'metric',
        name === preferred ? '100' : '600',
      );
    }
  };
  const probe = async () =>
    JSON.parse(
      await command('python3', [
        '-c',
        "import socket,json; s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM|socket.SOCK_NONBLOCK|socket.SOCK_CLOEXEC); s.connect(('203.0.113.10',9)); print(json.dumps({'source':s.getsockname()[0],'nonblocking':not s.getblocking(),'sent':0})); s.close()",
      ]),
    ) as { source: string; sent: number; nonblocking: boolean };
  const strategies = ['melofon', 'owntone', 'audiostation'] as const;
  const allNames = [
    'metric-switch',
    'reverse-metric',
    'source-loss',
    'link-loss',
    'unavailable',
    'startup',
    'flaps',
    'rapid-flaps',
    'retry-off',
    'pause',
    'stop',
    'deselect',
    'peer',
    'peer-retry-off',
  ];
  const names = scenarios === 'all' ? allNames : scenarios.split(',');
  assert(
    names.length > 0 && names.every((name) => allNames.includes(name)),
    'unknown scenario selection',
  );
  const fixture = `${evidence}/position.wav`;
  await writeFixture(fixture);
  const results: Record<string, unknown>[] = [];
  for (const strategy of strategies) {
    for (
      const name of [
        ...names,
        ...(scenarios === 'all' && strategy === 'owntone'
          ? ['hold-unavailable']
          : []),
      ]
    ) {
      const label = `${strategy}-${name}`;
      const dir = `${evidence}/${label}`;
      await Deno.mkdir(dir);
      const ready = `${dir}/topology-ready`;
      const receiver = new Rpc(
        new Deno.Command('unshare', {
          args: [
            '--net',
            Deno.execPath(),
            ...denoArgs('receiver', [
              `--ready=${ready}`,
              `--startup=${name === 'startup'}`,
            ]),
          ],
          stdin: 'piped',
          stdout: 'piped',
          stderr: 'piped',
        }).spawn(),
        `${dir}/receiver.log`,
      );
      let sender: Rpc | undefined;
      const rip = (...args: string[]) =>
        command('nsenter', [
          '--net',
          '--target',
          String(receiver.child.pid),
          'ip',
          ...args,
        ]);
      const snapshot = () => receiver.call<ReceiverSession[][]>('snapshot');
      let before: ReceiverSession | undefined;
      let mutatedAt = 0;
      let failure: unknown;
      const observe = async <T>(
        fn: () => Promise<T | undefined>,
        bound: number,
        reason: string,
      ): Promise<T> => {
        const end = performance.now() + bound;
        while (true) {
          const value = await fn();
          if (value !== undefined) return value;
          assert(performance.now() < end, `${label}: ${reason}`);
          await sleep(50);
        }
      };
      const sound = (source: string, generation?: number) =>
        observe(
          async () => {
            const sessions = (await snapshot())[0];
            const value = sessions.find((s, i) =>
              (generation === undefined || i === generation) &&
              s.rtspPeer.address === source && s.announceSource === source &&
              s.rtpSenders[0]?.address === source &&
              s.decodedFrames >= 16 * 352 && s.exactPcm
            );
            return value;
          },
          20000,
          'required new-source receiver-decoded PCM did not arrive',
        );
      try {
        await ip('link', 'set', 'lo', 'up');
        await rip('link', 'set', 'lo', 'up');
        for (
          const [path, remote, local, gateway] of [
            ['wifi', 'rw', addresses.wifi, '192.0.2.1'],
            ['ethernet', 're', addresses.ethernet, '198.51.100.1'],
          ]
        ) {
          await ip('link', 'add', path, 'type', 'veth', 'peer', 'name', remote);
          await ip('link', 'set', remote, 'netns', String(receiver.child.pid));
          await ip('address', 'add', `${local}/24`, 'dev', path);
          await ip('link', 'set', path, 'up');
          await rip('address', 'add', `${gateway}/24`, 'dev', remote);
          await rip('link', 'set', remote, 'up');
          await ip(
            'route',
            'add',
            '203.0.113.10/32',
            'via',
            gateway,
            'dev',
            path,
            'src',
            local,
            'metric',
            path === 'wifi' ? '100' : '600',
          );
        }
        for (const address of ['203.0.113.10', '203.0.113.11']) {
          await rip('address', 'add', `${address}/32`, 'dev', 'lo');
        }
        await ip(
          'route',
          'add',
          '203.0.113.11/32',
          'via',
          '198.51.100.1',
          'dev',
          'ethernet',
          'src',
          addresses.ethernet,
        );
        const initial: Path = name === 'reverse-metric' ? 'ethernet' : 'wifi';
        if (initial === 'ethernet') {
          await metric(initial);
        }
        const next: Path = initial === 'wifi' ? 'ethernet' : 'wifi';
        await Deno.writeTextFile(ready, 'ready', { createNew: true });
        const ports = await receiver.call<{ primary: number; peer: number }>(
          'ports',
        );
        sender = new Rpc(
          new Deno.Command(Deno.execPath(), {
            args: denoArgs('sender'),
            stdin: 'piped',
            stdout: 'piped',
            stderr: 'piped',
          }).spawn(),
          `${dir}/sender.log`,
        );
        await sender.call('start', {
          fixture,
          ports,
          strategy,
          peer: name.startsWith('peer'),
          retry: ['retry-off', 'peer-retry-off'].includes(name)
            ? 'off'
            : name === 'flaps'
            ? '0,0'
            : '0,0,0',
        });
        assertEquals((await probe()).source, addresses[initial]);
        if (name === 'startup') {
          await observe(
            async () => {
              const s = (await snapshot())[0][0];
              return s?.methods.includes('ANNOUNCE') ? s : undefined;
            },
            10000,
            'initial ANNOUNCE not observed',
          );
        } else {
          before = await sound(addresses[initial], 0);
          const status = await sender.call<SenderStatus>('snapshot');
          assert(
            status.pcmSpans.some((span) =>
              before!.decodedStartFrame! >= span.firstFrame &&
              before!.decodedStartFrame! <= span.lastFrame
            ),
            'initial consumer decoded actual owned feed PCM',
          );
          assert(
            before.controlSenders.length && before.timingSenders.length,
            'independent control/timing endpoints observed',
          );
        }
        const peerBefore = name.startsWith('peer')
          ? await observe(
            async () => {
              const peer = (await snapshot())[1][0];
              return peer?.tailFrame !== null && peer?.tailExactPcm
                ? peer
                : undefined;
            },
            10000,
            'initial peer decoded PCM not observed',
          )
          : undefined;
        const oldInodes =
          (await sender.call<SenderStatus>('snapshot')).connectionInodes;
        assert(
          oldInodes.length >= (name === 'startup' ? 1 : 2),
          'actual owned RTSP/RTP sockets observed',
        );
        mutatedAt = performance.now();
        if (name === 'hold-unavailable') {
          await sender.call('pause');
          await sleep(50);
        }
        if (name === 'link-loss') {
          await ip('link', 'set', initial, 'down');
        } else if (name === 'source-loss') {
          await ip(
            'address',
            'del',
            `${addresses[initial]}/24`,
            'dev',
            initial,
          );
        } else if (['unavailable', 'hold-unavailable'].includes(name)) {
          await ip(
            'route',
            'del',
            '203.0.113.10/32',
            'via',
            '192.0.2.1',
            'dev',
            'wifi',
          );
          await ip(
            'route',
            'del',
            '203.0.113.10/32',
            'via',
            '198.51.100.1',
            'dev',
            'ethernet',
          );
        } else if (name === 'rapid-flaps') {
          for (let i = 0; i < 8; i++) {
            await metric(i % 2 === 0 ? initial : next);
            await sleep(20);
          }
        } else await metric(next);
        if (
          !['unavailable', 'hold-unavailable', 'source-loss', 'link-loss']
            .includes(
              name,
            )
        ) {
          await Deno.writeTextFile(
            `${dir}/source-characterization.json`,
            JSON.stringify(
              {
                before: addresses[initial],
                fresh: await probe(),
                established: (await snapshot())[0][0],
                observation:
                  'fresh nonblocking numeric UDP connect/getsockname/close; zero sends',
              },
              null,
              2,
            ),
          );
        }
        if (['pause', 'stop', 'deselect'].includes(name)) {
          await sender.call(name);
        }
        const negative = [
          'retry-off',
          'peer-retry-off',
          'pause',
          'stop',
          'deselect',
          'unavailable',
          'hold-unavailable',
        ].includes(name);
        // An unavailable path remains unavailable through one failed observation;
        // cancel further demand explicitly after observing failure, without Play.
        const detection = observe(
          async () => {
            const sessions = (await snapshot())[0];
            const status = await sender!.call<SenderStatus>('snapshot');
            // Lost-source FIN cannot reach the receiver. The sender's actual FD
            // inodes prove local destruction independently of helper events.
            return oldInodes.every((inode) =>
                !status.connectionInodes.includes(inode)
              )
              ? sessions[0]
              : undefined;
          },
          3000,
          'obsolete generation not released within three-second detection bound',
        )
          .then(() => performance.now() - mutatedAt).catch(() => null);
        const recovered = !negative
          ? await sound(addresses[next], 1)
          : undefined;
        const firstDecodedMs = performance.now() - mutatedAt;
        const detectionMs = await detection;
        assert(
          detectionMs !== null,
          'obsolete generation not released within three-second detection bound',
        );
        if (name !== 'startup') {
          assert(
            detectionMs <= 3000,
            'obsolete source detection exceeded healthy VM bound',
          );
        }
        if (name === 'unavailable') await sender.call('pause');
        if (negative) {
          await sleep(3200);
          const current = (await snapshot())[0];
          assertEquals(
            current.length,
            1,
            'no automatic replacement with revoked recovery authority',
          );
          const count = current[0].audioPackets;
          await receiver.call('retransmit', { id: current[0].id });
          await sleep(250);
          assertEquals(
            (await snapshot())[0][0].audioPackets,
            count,
            'closed generation cannot revive cached PCM',
          );
          const status = await sender.call<SenderStatus>('snapshot');
          if (name === 'peer-retry-off') {
            assertEquals(
              status.state,
              'play',
              'usable peer keeps engine playing',
            );
          } else if (name !== 'stop' && name !== 'deselect') {
            assertEquals(status.state, 'pause');
            assert(status.progressMs >= 20000, 'paused bookmark retained');
          }
          results.push({
            label,
            detectionMs,
            negative: true,
            status,
            sessions: current,
          });
          if (name === 'hold-unavailable') {
            assert(
              (await Deno.readTextFile(`${dir}/sender.log`)).includes(
                'Local source unavailable',
              ),
              'idle observer explicitly classified unavailable source without PCM send failure',
            );
          }
        } else {
          assertEquals(
            (await probe()).source,
            addresses[next],
            'fresh nonblocking no-send source changed',
          );
          const fresh = recovered!;
          const status = await sender.call<SenderStatus>('snapshot');
          assert(
            fresh.decodedStartFrame !== null &&
              fresh.decodedStartFrame >= 20000 * 44.1,
          );
          const failed = status.events.find((event) =>
            event.target === '203.0.113.10' && event.value === 'failed'
          );
          assert(failed, 'failure bookmark independently observed');
          const survivingFeed = name.startsWith('peer') &&
            status.pcmSpans.some((span) =>
              span.target === '203.0.113.11' &&
              fresh.decodedStartFrame! >= span.firstFrame &&
              fresh.decodedStartFrame! <= span.lastFrame
            );
          // A surviving feed retains its continuous packet timeline. A packet
          // may straddle the engine's millisecond bookmark; it must be exact
          // current peer PCM and extend through that bookmark. A replaced feed
          // instead begins at its fresh current-position decode.
          assert(
            fresh.decodedStartFrame! >= Math.round(failed.bookmarkMs * 44.1) ||
              (survivingFeed &&
                fresh.tailFrame! >= Math.round(failed.bookmarkMs * 44.1)),
            'new-source decoded current owned feed crosses the retained failure bookmark',
          );
          assert(
            status.pcmSpans.some((span) =>
              fresh.decodedStartFrame! >= span.firstFrame &&
              fresh.decodedStartFrame! <= span.lastFrame &&
              (span.target !== '203.0.113.10' || span.atMs >= failed.atMs)
            ),
            'exact decoded new-source PCM belongs to current owned feed, not retired target generation',
          );
          if (name === 'startup') {
            assertEquals(
              (await snapshot())[0][0].audioPackets,
              0,
              'split-source startup was never published for PCM',
            );
            assertEquals(
              status.events.filter((e) =>
                e.target === '203.0.113.10' && e.value === 'connected'
              ).length,
              1,
              'only consistent replacement emits CONNECTED',
            );
          }
          if (name === 'flaps') {
            await metric(initial);
            await sound(addresses[initial], 2);
            await metric(next);
            await observe(
              async () => {
                const s = (await snapshot())[0][2];
                return s.closedAtMs !== null ? s : undefined;
              },
              3000,
              'final exhausted generation not released',
            );
            await sleep(3200);
            assertEquals(
              (await snapshot())[0].length,
              3,
              'connected/flaps never refill finite budget',
            );
            assertEquals(
              (await sender.call<SenderStatus>('snapshot')).state,
              'pause',
            );
          }
          const oldCount = (await snapshot())[0][0].audioPackets;
          await receiver.call('retransmit', {
            id: (await snapshot())[0][0].id,
          });
          await sleep(250);
          assertEquals(
            (await snapshot())[0][0].audioPackets,
            oldCount,
            'retired endpoint never revives PCM',
          );
          results.push({
            label,
            detectionMs,
            firstDecodedMs,
            initial: before,
            status,
            sessions: await snapshot(),
          });
        }
        if (name.startsWith('peer')) {
          const peer = await observe(
            async () => {
              const peers = (await snapshot())[1];
              assertEquals(
                peers.length,
                1,
                'unchanged receiver route is not retired',
              );
              assertEquals(peers[0].closedAtMs, null);
              return peers[0].tailExactPcm &&
                  peers[0].tailFrame! > peerBefore!.tailFrame!
                ? peers[0]
                : undefined;
            },
            3000,
            'unchanged peer did not consume fresh decoded PCM after target release',
          );
          results.at(-1)!.peerAfter = peer;
        }
        const finalStatus = await sender.call<SenderStatus>('snapshot');
        const finalSessions = (await snapshot())[0];
        results.at(-1)!.finalStatus = finalStatus;
        results.at(-1)!.timings = {
          detectionAndLocalReleaseMs: detectionMs,
          closeApiMs: finalStatus.releases.filter((release) =>
            release.target === '203.0.113.10'
          )
            .map((release) => release.completedAtMs - release.startedAtMs),
          wire: finalSessions.map((session) => {
            const options = session.requests.find((request) =>
              request.method === 'OPTIONS'
            )?.atMs;
            const volume = session.requests.find((request) =>
              request.method === 'SET_PARAMETER'
            )?.atMs;
            return {
              id: session.id,
              startupRequestSpanMs:
                options !== undefined && volume !== undefined
                  ? volume - options
                  : null,
              startupVolumeRequestToFirstRtpMs:
                volume !== undefined && session.firstRtpAtMs !== null
                  ? session.firstRtpAtMs - volume
                  : null,
              remoteTcpClosedAtMs: session.closedAtMs,
            };
          }),
          newSourceDecodedPrefixObservedMs: negative ? null : firstDecodedMs,
        };
        await Deno.writeTextFile(
          `${dir}/result.json`,
          JSON.stringify(results.at(-1), null, 2),
        );
        console.log(`dual-home scenario: PASS ${label}`);
      } catch (error) {
        await Deno.writeTextFile(
          `${dir}/failure.json`,
          JSON.stringify(
            {
              error: String(error),
              mutatedAt,
              sessions: await snapshot(),
              sender: sender ? await sender.call('snapshot') : null,
            },
            null,
            2,
          ),
        );
        failure = error;
      } finally {
        let error: unknown;
        try {
          await sender?.close();
        } catch (failure) {
          error = failure;
        }
        const remaining = await ip('-j', 'link');
        for (const path of ['wifi', 'ethernet']) {
          if (remaining.includes(`"ifname":"${path}"`)) {
            await ip('link', 'del', path);
          }
        }
        try {
          await receiver.close();
        } catch (failure) {
          error ??= failure;
        }
        assertEquals(
          JSON.parse(await ip('-j', 'link')).length,
          1,
          'only isolated loopback remains',
        );
        await Deno.writeTextFile(
          `${dir}/cleanup.json`,
          JSON.stringify(
            {
              senderReaped: !sender || (await sender.child.status).success,
              receiverReaped: (await receiver.child.status).success,
              vethsRemoved: true,
              isolatedNet: net,
              managementNet: parentNet,
            },
            null,
            2,
          ),
        );
        failure ??= error;
      }
      if (failure) throw failure;
    }
  }
  await Deno.writeTextFile(
    `${evidence}/results.json`,
    JSON.stringify(results, null, 2),
  );
} else throw new Error('unknown worker role');
