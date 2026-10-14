// Qualification branch deliberately does not import the corrected owner.
import {
  checkMembership,
  type ContainmentTicket,
  observe,
  processIdentity,
  requireFact,
  save,
  signalIdentity,
  sleep,
  stdinLease,
} from '../../../dev/helpers/transient-watchdog.ts';

async function qualification() {
  const [caseName, evidence, ticketPath] = Deno.args;
  requireFact(caseName.startsWith('qualify-'), 'qualification case');
  let cause: string | undefined;
  let wake!: () => void;
  const interrupted = new Promise<void>((resolve) => wake = resolve);
  const fail = (reason: string) => {
    cause ??= reason;
    wake();
  };
  const lease = stdinLease(fail);
  const onHup = () => fail('SIGHUP');
  Deno.addSignalListener('SIGHUP', onHup);
  await save(`${evidence}/subject-ready.json`, await processIdentity(Deno.pid));
  const deadline = performance.now() + 30_000;
  let ticket: ContainmentTicket | undefined;
  while (!ticket) {
    requireFact(performance.now() < deadline && !cause, 'ticket wait');
    try {
      ticket = JSON.parse(await Deno.readTextFile(ticketPath));
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      await sleep(20);
    }
  }
  await save(`${evidence}/ticket-checked.json`, await checkMembership(ticket));
  const args = [
    'run',
    `--config=${Deno.cwd()}/deno.json`,
    '--frozen',
    '--cached-only',
    '--node-modules-dir=manual',
    '--allow-all', // Disposable VM fixture; never the application's argv.
    `${Deno.cwd()}/tests/fixtures/opensubsonic-owned/child.ts`,
    evidence,
  ];
  const child = new Deno.Command(Deno.execPath(), {
    args,
    cwd: Deno.cwd(),
    clearEnv: true,
    env: {
      HOME: '/home/tester',
      PATH: '/home/tester/.deno/bin:/usr/bin:/bin',
      TMPDIR: Deno.env.get('TMPDIR')!,
      DENO_DIR: Deno.env.get('DENO_DIR')!,
    },
    stdin: 'null',
    stdout: 'null',
    stderr: 'inherit',
  }).spawn();
  const status = observe(child.status);
  await save(`${evidence}/child-launch.json`, { pid: child.pid, args });
  while (true) {
    try {
      await Deno.stat(`${evidence}/release.json`);
      break;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      requireFact(performance.now() < deadline && !cause, 'release wait');
      await sleep(20);
    }
  }
  if (caseName === 'qualify-main-exit0') {
    // Deliberately leaves the fixture descendant to the independent manager.
    Deno.exit(0);
  }
  if (['qualify-main-kill', 'qualify-stopped-client-loss'].includes(caseName)) {
    await interrupted;
  } else if (
    ['qualify-lease-eof', 'qualify-hup', 'qualify-ssh-loss-arm'].includes(
      caseName,
    )
  ) {
    await interrupted;
  }
  const childIdentity = JSON.parse(
    await Deno.readTextFile(`${evidence}/child-ready.json`),
  );
  await signalIdentity(childIdentity, 'SIGTERM');
  const reaped = await status;
  requireFact(reaped.ok && reaped.value.success, 'fixture child exit');
  const leaseReceipt = await lease.join();
  Deno.removeSignalListener('SIGHUP', onHup);
  await save(`${evidence}/joined.json`, {
    cause,
    child: reaped,
    lease: leaseReceipt,
    joinedAt: performance.now(),
  });
  await save(`${evidence}/terminal.json`, {
    cause,
    success: !cause,
    at: performance.now(),
  });
  if (cause) Deno.exitCode = 1;
}

async function regression() {
  const [caseName, evidence, ticketPath, implementation] = Deno.args;
  const cases = [
    'stdout-reject',
    'stderr-reject',
    'term',
    'int',
    'hup',
    'lease-eof',
    'term-ignore',
    'request-timeout',
    'cancel-join',
    'pump-drain-timeout',
    'scan-late',
    'identity-guards',
    'active-deadline',
    'driver-stopped',
  ];
  requireFact(
    cases.includes(caseName) &&
      ['baseline', 'corrected'].includes(implementation),
    'fixed regression inputs',
  );
  const { OwnedRun, assertSignalIdentity, assertLaunchIdentity } = await import(
    '../../../dev/helpers/owned-run.ts'
  );
  const { LegacyOwner } = implementation === 'baseline'
    ? await import('./legacy-owner.ts')
    : { LegacyOwner: undefined };
  type Harness = Pick<
    InstanceType<typeof OwnedRun>,
    | 'started'
    | 'activeDeadline'
    | 'cleanupDeadline'
    | 'workSignal'
    | 'operation'
    | 'resource'
    | 'sleep'
    | 'request'
    | 'poll'
    | 'assertWork'
  >;
  const corrected = implementation === 'corrected';
  const owner = corrected
    ? new OwnedRun({ lease: true })
    : new LegacyOwner!(evidence);
  const externalLease = corrected
    ? undefined
    : stdinLease((cause) => owner.fail(cause));
  let released = false;
  let workFinallyAt: number | undefined;
  let sinkFinalizerAt: number | undefined;
  let scanAccepted = false;
  let requestStarted: number | undefined;
  let headersAt: number | undefined;
  let bodySettledAt: number | undefined;
  const eventsPath = `${evidence}/events.ndjson`;
  const writeEvent = (
    run: Harness,
    event: string,
    kind: 'work' | 'drain' | 'finalizer' = 'work',
  ) =>
    run.operation(
      `event ${event}`,
      () =>
        Deno.writeTextFile(
          eventsPath,
          JSON.stringify({ event, at: performance.now() }) + '\n',
          { append: true },
        ),
      kind,
    );
  const saveReceipt = (
    run: Harness,
    name: string,
    value: unknown,
    publication = false,
  ) =>
    run.operation(
      `receipt ${name}`,
      () =>
        Deno.writeTextFile(
          `${evidence}/${name}.json`,
          JSON.stringify(value, null, 2) + '\n',
          { createNew: true },
        ),
      publication ? 'publication' : 'work',
    );
  const prelude = async (run: Harness) => {
    await saveReceipt(
      run,
      'subject-ready',
      await run.operation('subject identity', () => processIdentity(Deno.pid)),
    );
    const deadline = Math.min(performance.now() + 30_000, run.activeDeadline);
    let ticket: ContainmentTicket | undefined;
    while (!ticket) {
      try {
        ticket = JSON.parse(
          await run.operation(
            'ticket input',
            () => Deno.readTextFile(ticketPath),
            'work',
            false,
          ),
        );
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
        await run.sleep(20, deadline);
      }
      requireFact(performance.now() < deadline, 'ticket deadline');
    }
    await saveReceipt(run, 'ticket-checked', await checkMembership(ticket));
    if (corrected) {
      await (run as InstanceType<typeof OwnedRun>).attachSupervisor(ticket);
    }
  };
  const work = async (run: Harness) => {
    if (corrected) await prelude(run);
    let stdout: string | WritableStream<Uint8Array> =
      `${evidence}/child.stdout.log`;
    let stderr: string | WritableStream<Uint8Array> =
      `${evidence}/child.stderr.log`;
    const faultSink = (name: string) =>
      new WritableStream<Uint8Array>({
        write: (bytes) =>
          run.operation(`${name} fixture sink`, async () => {
            await Deno.writeFile(`${evidence}/child.${name}.log`, bytes, {
              append: true,
            });
            if (released) {
              await writeEvent(run, `${name}-sink-rejection`, 'drain');
              throw new Error(`${name} sink rejection`);
            }
          }, 'drain'),
      });
    if (caseName === 'stdout-reject') stdout = faultSink('stdout');
    if (caseName === 'stderr-reject') stderr = faultSink('stderr');
    if (caseName === 'cancel-join') {
      stdout = new WritableStream<Uint8Array>({
        write: (bytes) =>
          run.operation(
            'controlled stdout write',
            () =>
              Deno.writeFile(`${evidence}/child.stdout.log`, bytes, {
                append: true,
              }),
            'drain',
          ),
        close: () =>
          run.operation('controlled sink finalizer', async () => {
            // Sink-internal bounded finalizer: cancellation must join this actual
            // callback, not just win a timer race against its owning pipe promise.
            await new Promise<void>((resolve) => setTimeout(resolve, 2_000));
            sinkFinalizerAt = performance.now();
            await writeEvent(run, 'sink-finalizer-done', 'finalizer');
          }, 'finalizer'),
      });
    }
    const mode = caseName === 'term-ignore'
      ? 'ignore'
      : caseName === 'pump-drain-timeout'
      ? 'retained'
      : 'pulse';
    const args = [
      'run',
      `--config=${Deno.cwd()}/deno.json`,
      '--frozen',
      '--cached-only',
      '--node-modules-dir=manual',
      '--allow-all',
      `${Deno.cwd()}/tests/fixtures/opensubsonic-owned/child.ts`,
      evidence,
      mode,
    ];
    await owner.launch({
      executable: Deno.execPath(),
      args,
      cwd: Deno.cwd(),
      env: {
        HOME: '/home/tester',
        PATH: '/home/tester/.deno/bin:/usr/bin:/bin',
        TMPDIR: Deno.env.get('TMPDIR')!,
        DENO_DIR: Deno.env.get('DENO_DIR')!,
      },
      stdout,
      stderr,
    });
    const releaseDeadline = Math.min(
      performance.now() + 30_000,
      run.activeDeadline,
    );
    for (;;) {
      try {
        await run.operation(
          'release input',
          () => Deno.stat(`${evidence}/release.json`),
          'work',
          false,
        );
        break;
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
        await run.sleep(20, releaseDeadline);
      }
    }
    released = true;
    await writeEvent(run, 'trigger-ready');
    if (caseName === 'identity-guards') {
      const saved = await processIdentity(Deno.pid);
      const records = [];
      for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
        for (
          const [field, value] of Object.entries({
            boot: 'different',
            startTicks: 'different',
            argv: [...saved.argv, 'extra'],
            executable: '/other',
            cwd: '/other',
            uid: ['1001'],
            cgroup: '0::/other.service\n',
          })
        ) {
          let rejected = false;
          try {
            assertSignalIdentity(saved, {
              ok: true,
              value: { ...saved, [field]: value },
            }, signal);
          } catch {
            rejected = true;
          }
          requireFact(rejected, `${signal} ${field} fixture guard`);
          records.push({ signal, field, rejected });
        }
        for (
          const error of [
            'PermissionDenied',
            'I/O error',
            'NotFound without status corroboration',
          ]
        ) {
          let rejected = false;
          try {
            assertSignalIdentity(saved, { ok: false, error }, signal);
          } catch {
            rejected = true;
          }
          requireFact(rejected, `${signal} observation error`);
          records.push({ signal, error, rejected });
        }
      }
      const launch = {
        executable: saved.executable,
        args: saved.argv.slice(1),
        cwd: saved.cwd,
        env: {},
        stdout: '',
        stderr: '',
      };
      let initialRejected = false;
      try {
        assertLaunchIdentity(
          { ...saved, argv: [...saved.argv, 'extra'] },
          launch,
        );
      } catch {
        initialRejected = true;
      }
      requireFact(initialRejected, 'initial intended launch guard');
      await saveReceipt(run, 'identity-oracle', {
        records,
        initialRejected,
        noRealSignalsForMismatches: true,
      });
      return;
    }
    if (caseName === 'pump-drain-timeout') {
      await writeEvent(run, 'normal-child-return-with-held-pipe');
      return;
    }
    if (
      caseName === 'active-deadline' || caseName === 'driver-stopped' ||
      caseName === 'stdout-reject' || caseName === 'stderr-reject'
    ) {
      await run.sleep(1_000_000, run.activeDeadline);
      return;
    }
    let replies = 0;
    run.assertWork();
    const server = Deno.serve({
      hostname: '127.0.0.1',
      port: 0,
      onListen: () => {},
      onError: () => new Response('fixture cancelled', { status: 499 }),
    }, () =>
      run.operation(
        'fixture HTTP handler',
        async () => {
          if (caseName === 'scan-late') {
            const index = replies++;
            await run.sleep(index < 3 ? 9_000 : 5_000);
            await writeEvent(run, `scan-reply-${index}`);
            return Response.json({ scanning: index < 3 });
          }
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('headers-received;'));
              const aborted = () => {
                try {
                  controller.error(new Error('fixture work cancelled'));
                } catch { /* already cancelled stream */ }
              };
              run.workSignal.addEventListener('abort', aborted, { once: true });
            },
          });
          headersAt = performance.now();
          await writeEvent(run, 'real-headers-stalled-body');
          return new Response(stream);
        },
        'work',
        false,
      ));
    run.resource('fixture HTTP server', () => server.shutdown());
    run.operation(
      'fixture server finished',
      () => server.finished,
      'finalizer',
      false,
    );
    const url = `http://127.0.0.1:${server.addr.port}/fixture`;
    requestStarted = performance.now();
    await saveReceipt(run, 'request-ready', {
      url,
      started: requestStarted,
      caseName,
    });
    try {
      if (caseName === 'scan-late') {
        const started = performance.now();
        const deadline = Math.min(started + 30_000, run.activeDeadline);
        await saveReceipt(run, 'scan-window', { deadline, started });
        await run.poll(deadline, async (deadline) => {
          const res = await run.request(url, {}, {
            phaseDeadline: deadline,
            receipt: (response, signal) =>
              Deno.writeTextFile(
                `${evidence}/requests.ndjson`,
                JSON.stringify({ ...response, at: performance.now() }) + '\n',
                { append: true, signal },
              ),
          });
          await writeEvent(run, 'scan-body-consumed');
          return JSON.parse(res.body) as { scanning: boolean };
        }, (value) => !value.scanning);
        scanAccepted = true;
        await writeEvent(run, 'scan-accepted');
      } else {
        await run.request(url);
      }
    } finally {
      bodySettledAt = performance.now();
      if (caseName === 'cancel-join') {
        await run.sleep(250, run.cleanupDeadline!, 'finalizer');
      }
      workFinallyAt = performance.now();
      await writeEvent(run, 'actual-work-finalizer-done', 'finalizer');
    }
  };
  if (!corrected) await prelude(owner as Harness);
  const published = async (run: Harness, summary: unknown) => {
    await saveReceipt(run, 'joined', {
      summary,
      workFinallyAt,
      sinkFinalizerAt,
      requestStarted,
      headersAt,
      bodySettledAt,
      scanAccepted,
      at: performance.now(),
    }, true);
    await saveReceipt(run, 'terminal', {
      summary,
      caseName,
      implementation,
      workFinallyAt,
      sinkFinalizerAt,
      requestStarted,
      headersAt,
      bodySettledAt,
      scanAccepted,
      at: performance.now(),
    }, true);
  };
  const result = corrected
    ? await (owner as InstanceType<typeof OwnedRun>).run(work, published)
    : await (owner as InstanceType<NonNullable<typeof LegacyOwner>>).run(
      work,
      published,
    );
  if (externalLease) await externalLease.join();
  if (!result.success) Deno.exitCode = 1;
}

if (import.meta.main) {
  if (Deno.args[0]?.startsWith('qualify-')) await qualification();
  else await regression();
}
