// External, VM-only qualification observer. Fixed cases, never arbitrary argv.
import {
  bootIdentity,
  type ContainmentTicket,
  groupAbsent,
  observe,
  type ProcessIdentity,
  processIdentity,
  requireFact,
  sameIdentity,
  save,
  savedProcessAbsent,
  serviceProperties,
  signalIdentity,
  sleep,
  stdinLease,
  unitProperties,
  validateProperties,
} from '../helpers/transient-watchdog.ts';
import type { RunSummary } from '../helpers/owned-run.ts';
import { H1C_ASSERTIONS, sameMultiset } from './cold-http.ts';

const qualificationCases = [
  'qualify-manager',
  'qualify-normal-open-lease',
  'qualify-main-exit0',
  'qualify-main-kill',
  'qualify-stopped-client-loss',
  'qualify-lease-eof',
  'qualify-hup',
  'qualify-ssh-loss-arm',
  'qualify-ssh-loss-reconcile',
] as const;
const regressionCases = [
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
  'cold-h1',
  'cold-h2',
  'cold-h1c',
];
const coldPhases: Record<string, string> = {
  'cold-h1': 'H1',
  'cold-h2': 'H2',
  'cold-h1c': 'H1C',
};

function option(name: string) {
  const value = Deno.args.find((a) => a.startsWith(`--${name}=`))?.slice(
    name.length + 3,
  );
  requireFact(value, `missing ${name}`);
  return value;
}

async function readReceipt<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await Deno.readTextFile(path));
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    return undefined;
  }
}

async function fixtureEvents(evidence: string) {
  try {
    const text = await Deno.readTextFile(`${evidence}/subject/events.ndjson`);
    return text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as { event: string; at: number });
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    return [];
  }
}

async function regressionOracle(
  evidence: string,
  caseName: string,
  implementation: string,
  code: number,
) {
  const terminal = await readReceipt<
    {
      summary: RunSummary;
      at: number;
      workFinallyAt?: number;
      sinkFinalizerAt?: number;
      requestStarted?: number;
      headersAt?: number;
      bodySettledAt?: number;
      scanAccepted?: boolean;
    }
  >(`${evidence}/subject/terminal.json`);
  const events = await fixtureEvents(evidence);
  const checks: { name: string; passed: boolean }[] = [];
  const check = (name: string, passed: unknown) =>
    checks.push({ name, passed: !!passed });
  if (implementation === 'baseline') {
    const causal = caseName === 'stdout-reject' || caseName === 'stderr-reject'
      ? events.some((e) =>
        e.event === `${caseName.split('-')[0]}-sink-rejection`
      )
      : caseName === 'scan-late'
      ? events.some((e) => e.event === 'scan-accepted')
      : caseName === 'hup'
      ? events.some((e) => e.event === 'real-headers-stalled-body')
      : !!terminal?.workFinallyAt;
    requireFact(causal, 'baseline fixture causality must be established');
  }
  if (caseName === 'driver-stopped') {
    return {
      proved: true,
      checks: [{
        name: 'manager contained stopped driver; no application join claim',
        passed: true,
      }],
    };
  }
  if (Object.hasOwn(coldPhases, caseName)) {
    const result = await readReceipt<
      {
        complete: boolean;
        assertions: string[];
        parsingAssertions: string[];
        h1cAssertions?: string[];
        originalCaseCount: number;
        owner: RunSummary;
      }
    >(`${evidence}/subject/result.json`);
    check('cold result/exit', code === 0 && result?.complete);
    check(
      'original assertion multiplicities count',
      result?.assertions.length === (caseName === 'cold-h1' ? 144 : 277),
    );
    check(
      'original fixed request cases',
      result?.originalCaseCount === (caseName === 'cold-h1' ? 99 : 191),
    );
    check(
      'separate correction ledger',
      (result?.parsingAssertions.length ?? 0) > 0,
    );
    if (caseName === 'cold-h1c') {
      check(
        'exact literal H1C ledger multiset',
        result?.h1cAssertions !== undefined &&
          sameMultiset(result.h1cAssertions, H1C_ASSERTIONS),
      );
    }
    check(
      'cold child/resource/work/pump join',
      result?.owner.childStatus?.code === 0 && result.owner.childReaped &&
        result.owner.logsComplete && result.owner.workJoined &&
        result.owner.resourcesClosed && result.owner.unresolved.length === 0,
    );
    return { proved: checks.every((c) => c.passed), checks };
  }
  const summary = terminal?.summary;
  check('terminal exists', terminal);
  check(
    'actual child/work/resources/operations joined',
    summary?.childReaped && summary.workJoined && summary.resourcesClosed &&
      summary.unresolved.length === 0 &&
      summary.operations.filter((o) =>
        !['closing owner', 'run lifetime'].includes(o.name)
      ).every((o) => o.settled !== undefined),
  );
  check(
    'publication follows cleanup',
    summary?.joined !== undefined && terminal && summary.joined <= terminal.at,
  );
  check(
    'failed subjects never become success',
    caseName === 'identity-guards'
      ? code === 0 && summary?.success
      : code !== 0 && summary?.success === false,
  );
  if (summary?.lease) {
    const lease = summary.lease as {
      eof: boolean;
      events: { event: string; at: number }[];
    };
    const finalized = lease.events.find((e) => e.event === 'reader-finalized');
    const joined = lease.events.find((e) => e.event === 'lease-joined');
    check(
      'actual lease finalizer before joined',
      finalized && joined && finalized.at <= joined.at &&
        joined.at <= summary.joined!,
    );
  } else if (implementation === 'corrected') {
    check('owned lease receipt', false);
  }
  const expectedCause: Record<string, string> = {
    term: 'driver SIGTERM',
    int: 'driver SIGINT',
    hup: 'driver SIGHUP',
    'lease-eof': 'stdin EOF',
    'term-ignore': 'driver SIGTERM',
    'cancel-join': 'driver SIGTERM',
  };
  if (expectedCause[caseName]) {
    check(
      'actual first cause retained',
      summary?.failure === expectedCause[caseName],
    );
  }
  if (
    [
      'term',
      'int',
      'hup',
      'lease-eof',
      'term-ignore',
      'cancel-join',
      'request-timeout',
    ].includes(caseName)
  ) {
    check(
      'real request headers/body settlement observed',
      terminal?.headersAt && terminal.bodySettledAt && terminal.workFinallyAt &&
        terminal.headersAt <= terminal.bodySettledAt &&
        terminal.bodySettledAt <= terminal.workFinallyAt &&
        terminal.workFinallyAt <= terminal.at,
    );
  }
  if (caseName === 'stdout-reject' || caseName === 'stderr-reject') {
    check(
      'real sink rejection retained',
      events.some((e) =>
        e.event === `${caseName.split('-')[0]}-sink-rejection`
      ) && summary?.failure?.includes('sink'),
    );
  }
  if (caseName === 'term-ignore') {
    const signals = summary?.signals as {
      signal: string;
      at: number;
      identity?: ProcessIdentity;
    }[] | undefined;
    const term = signals?.find((s) => s.signal === 'SIGTERM');
    const kill = signals?.find((s) => s.signal === 'SIGKILL');
    check(
      'fresh full identity at both signal boundaries',
      term?.identity && kill?.identity &&
        sameIdentity(term.identity, kill.identity),
    );
    check(
      'identity checked KILL within TERM allowance',
      term && kill && kill.at - term.at <= 5_000,
    );
    check(
      'forced termination remains failure',
      summary?.forcedTermination && summary.childStatus?.signal === 'SIGKILL',
    );
    check(
      'TERM-ignore acknowledged',
      (await Deno.readTextFile(`${evidence}/subject/child.stdout.log`))
        .includes('TERM-IGNORED'),
    );
  }
  if (caseName === 'request-timeout') {
    check(
      'real ten-second stalled-body deadline',
      terminal?.requestStarted && terminal.bodySettledAt &&
        terminal.bodySettledAt - terminal.requestStarted >= 10_000 &&
        summary?.failure?.includes('deadline'),
    );
  }
  if (caseName === 'cancel-join') {
    check(
      'actual delayed sink finalizer before terminal',
      terminal?.sinkFinalizerAt && terminal.sinkFinalizerAt <= terminal.at,
    );
  }
  if (caseName === 'pump-drain-timeout') {
    check(
      'drain failure joined without claiming complete logs',
      summary?.logsComplete === false && summary.failure?.includes('log drain'),
    );
  }
  if (caseName === 'scan-late') {
    const window = await readReceipt<{ deadline: number; started: number }>(
      `${evidence}/subject/scan-window.json`,
    );
    check(
      'original thirty-second window',
      window && summary &&
        window.deadline ===
          Math.min(window.started + 30_000, summary.activeDeadline),
    );
    check(
      'late scan never accepted',
      terminal?.scanAccepted === false &&
        !events.some((e) => e.event === 'scan-accepted'),
    );
    check(
      'scan cancellation/settlement before terminal',
      terminal?.bodySettledAt && terminal.bodySettledAt <= terminal.at &&
        summary?.failure?.includes('deadline'),
    );
  }
  if (caseName === 'active-deadline') {
    check(
      'real 270s active budget unchanged',
      summary && summary.activeDeadline === summary.started + 270_000,
    );
    check(
      'real active operation reaches boundary and closes by 280s',
      summary?.closing && summary.joined &&
        summary.closing >= summary.activeDeadline &&
        summary.joined <= summary.started + 280_000 &&
        summary.failure?.includes('active-work deadline'),
    );
  }
  if (caseName === 'identity-guards') {
    const oracle = await readReceipt<
      {
        records: { rejected: boolean }[];
        initialRejected: boolean;
        noRealSignalsForMismatches: boolean;
      }
    >(`${evidence}/subject/identity-oracle.json`);
    check(
      'all snapshot/error guards and intended launch',
      oracle?.records.length === 20 && oracle.records.every((r) =>
        r.rejected
      ) && oracle.initialRejected && oracle.noRealSignalsForMismatches,
    );
  }
  if (implementation === 'corrected') {
    check(
      'no unhandled rejection',
      !(await Deno.readTextFile(`${evidence}/client.stderr`)).includes(
        'Uncaught (in promise)',
      ),
    );
  }
  return { proved: checks.every((c) => c.passed), checks };
}

async function run() {
  const root = option('task-root');
  requireFact(
    /^\/home\/tester\/melofon-output-preparation-01\/opensubsonic-prefix-correction-01\/(candidate|verification-\d+)$/
      .test(root) ||
      /^\/home\/tester\/melofon-output-preparation-01\/opensubsonic-h1c-01\/(candidate|verification-\d{2,})$/
        .test(root),
    'task root',
  );
  requireFact(await Deno.realPath(root) === root, 'canonical task root');
  requireFact(
    await Deno.realPath(new URL('../../', import.meta.url)) ===
      `${root}/source`,
    'observer import root',
  );
  requireFact(Deno.cwd() === `${root}/source`, 'observer cwd');
  requireFact(Deno.uid() === 1000 && Deno.gid() === 1000, 'tester account');
  requireFact(
    Deno.execPath() === '/home/tester/.deno/bin/deno',
    'observer executable',
  );
  requireFact(Deno.env.get('TMPDIR') === `${root}/tmp`, 'TMPDIR');
  requireFact(
    Deno.env.get('DENO_DIR') === `${root}/runtime/deno-dir`,
    'DENO_DIR',
  );
  requireFact(
    Deno.env.get('XDG_RUNTIME_DIR') === '/run/user/1000',
    'user runtime',
  );
  requireFact(
    Deno.env.get('DBUS_SESSION_BUS_ADDRESS') === 'unix:path=/run/user/1000/bus',
    'user bus',
  );
  const implementation = option('implementation');
  requireFact(
    ['fixture', 'baseline', 'corrected'].includes(implementation),
    'fixed implementation',
  );
  const caseName = option('case');
  requireFact(
    implementation === 'fixture'
      ? qualificationCases.some((c) => c === caseName)
      : regressionCases.includes(caseName),
    'literal fixed case',
  );
  const cold = Object.hasOwn(coldPhases, caseName);
  requireFact(
    !cold || implementation === 'corrected',
    'cold cases use corrected driver only',
  );
  const attempt = option('attempt');
  requireFact(/^[a-z][a-z0-9-]{0,39}$/.test(attempt), 'safe attempt');
  requireFact(option('transport-lease') === 'stdin', 'transport lease');
  const evidence = `${root}/evidence/${implementation}-${caseName}-${attempt}`;
  requireFact(
    await Deno.realPath(`${root}/evidence`) === `${root}/evidence`,
    'canonical evidence parent',
  );
  if (caseName === 'qualify-ssh-loss-reconcile') {
    const previous = `${root}/evidence/fixture-qualify-ssh-loss-arm-${attempt}`;
    const ticket = await readReceipt<ContainmentTicket>(
      `${previous}/containment.json`,
    );
    requireFact(ticket, 'same invocation ticket required');
    requireFact(
      await bootIdentity() === ticket.boot,
      'same reconciliation boot',
    );
    const child = await readReceipt<ProcessIdentity>(
      `${previous}/subject/child-ready.json`,
    );
    requireFact(child, 'saved child identity required');
    await Deno.mkdir(evidence, { mode: 0o700 });
    const limit = performance.now() + 330_000;
    while (
      !(await groupAbsent(ticket.group) &&
        await savedProcessAbsent(ticket.subject) &&
        await savedProcessAbsent(child))
    ) {
      requireFact(performance.now() < limit, 'reconciliation bound');
      await sleep(100);
    }
    const terminal = await readReceipt<{ cause: string }>(
      `${previous}/subject/terminal.json`,
    );
    await save(`${evidence}/reconciliation.json`, {
      ticket,
      freshBoot: await bootIdentity(),
      groupAbsent: true,
      subjectAbsent: true,
      childAbsent: true,
      termination: terminal?.cause === 'stdin EOF'
        ? 'cooperative-EOF'
        : 'manager',
      terminal,
    });
    console.log(`QUALIFICATION ${caseName} observed same-invocation absence`);
    return;
  }

  await Deno.mkdir(evidence, { mode: 0o700 });
  if (!cold) await Deno.mkdir(`${evidence}/subject`, { mode: 0o700 });
  const boot = await bootIdentity();
  const observer = await processIdentity(Deno.pid);
  const unit =
    `melofon-prefix-${caseName}-${attempt}-${crypto.randomUUID()}.service`;
  const collision = await new Deno.Command('/usr/bin/systemctl', {
    args: ['--user', 'show', unit, '--property=LoadState'],
  }).output();
  requireFact(
    new TextDecoder().decode(collision.stdout).trim() === 'LoadState=not-found',
    'unit collision or observation error',
  );
  const subjectArgs = [
    'run',
    `--config=${root}/source/deno.json`,
    '--frozen',
    '--cached-only',
    '--node-modules-dir=manual',
    '--allow-all', // Approved VM-only harness kernel-observation exception.
    ...(cold
      ? [
        `${root}/source/dev/opensubsonic/cold-http.ts`,
        `--candidate-root=${root}/source`,
        `--phase=${coldPhases[caseName]}`,
        `--evidence=${evidence}/subject`,
        '--lease=stdin',
        `--supervisor-ticket=${evidence}/containment.json`,
        '--corrections=enabled',
      ]
      : [
        `${root}/source/tests/fixtures/opensubsonic-owned/subject.ts`,
        caseName,
        `${evidence}/subject`,
        `${evidence}/containment.json`,
        implementation,
      ]),
  ];
  const launchArgv = [Deno.execPath(), ...subjectArgs];
  const pins: Record<string, string> = {};
  for (
    const path of [
      'dev/helpers/transient-watchdog.ts',
      'dev/opensubsonic/ownership-regression.ts',
      'tests/fixtures/opensubsonic-owned/subject.ts',
      'tests/fixtures/opensubsonic-owned/child.ts',
      'deno.lock',
      'dev/helpers/owned-run.ts',
      'tests/fixtures/opensubsonic-owned/legacy-owner.ts',
      'dev/opensubsonic/cold-http.ts',
    ]
  ) {
    const digest = new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        await Deno.readFile(`${root}/source/${path}`),
      ),
    );
    pins[path] = Array.from(digest, (b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
  const version = await new Deno.Command('/usr/bin/systemctl', {
    args: ['--user', 'show', '--property=Version'],
  }).output();
  requireFact(version.success, 'manager version observation');
  const managerVersion = new TextDecoder().decode(version.stdout).trim();
  requireFact(
    managerVersion.startsWith('Version='),
    'manager version response',
  );
  if (implementation !== 'fixture') {
    const set = option('qualification-set');
    requireFact(
      /^[a-z][a-z0-9-]{0,39}$/.test(set) && set !== 'none',
      'qualification set required',
    );
    for (
      const name of qualificationCases.filter((c) => !c.includes('ssh-loss'))
    ) {
      const qualified = await readReceipt<{ contractProved: boolean }>(
        `${root}/evidence/fixture-${name}-${set}/terminal.json`,
      );
      const ticket = await readReceipt<ContainmentTicket>(
        `${root}/evidence/fixture-${name}-${set}/containment.json`,
      );
      requireFact(
        qualified?.contractProved && ticket && ticket.boot === boot &&
          ticket.managerVersion === managerVersion &&
          JSON.stringify(ticket.pins) === JSON.stringify(pins),
        'qualification boot/version/helper pins differ',
      );
    }
    const reconciled = await readReceipt<
      { groupAbsent: boolean; freshBoot: string }
    >(`${root}/evidence/fixture-qualify-ssh-loss-reconcile-${set}/reconciliation.json`);
    requireFact(
      reconciled?.groupAbsent && reconciled.freshBoot === boot,
      'qualified SSH reconciliation required',
    );
  }
  const args = [
    '--user',
    '--wait',
    '--pipe',
    '--no-ask-password',
    '--expand-environment=no',
    `--unit=${unit}`,
    ...serviceProperties.map((p) => `--property=${p}`),
    `--working-directory=${root}/source`,
    '/usr/bin/env',
    '-i',
    'HOME=/home/tester',
    'PATH=/home/tester/.deno/bin:/usr/bin:/bin',
    `TMPDIR=${root}/tmp`,
    `DENO_DIR=${root}/runtime/deno-dir`,
    `MELOFON_RAOP_LIB=${root}/artifacts/libmelofon_raop.so`,
    ...launchArgv,
  ];
  await save(`${evidence}/intent.json`, {
    boot,
    observer,
    unit,
    args,
    launchArgv,
    pins,
    managerVersion,
    started: Date.now(),
  });
  let cause: string | undefined;
  let subjectWriterClosed = false;
  const lease = stdinLease((reason) => cause ??= reason);
  const stdout = await Deno.open(`${evidence}/client.stdout`, {
    createNew: true,
    write: true,
  });
  const stderr = await Deno.open(`${evidence}/client.stderr`, {
    createNew: true,
    write: true,
  });
  const client = new Deno.Command('/usr/bin/systemd-run', {
    args,
    stdin: 'piped',
    stdout: 'piped',
    stderr: 'piped',
  }).spawn();
  let clientResult:
    | Awaited<ReturnType<typeof observe<Deno.CommandStatus>>>
    | undefined;
  const status = observe(client.status).then((result) => {
    clientResult = result;
    return result;
  });
  const pumps = [
    observe(client.stdout.pipeTo(stdout.writable)),
    observe(client.stderr.pipeTo(stderr.writable)),
  ];
  const writer = client.stdin.getWriter();
  const clientIdentity = await processIdentity(client.pid);
  let ticket: ContainmentTicket | undefined;
  let childIdentity: ProcessIdentity | undefined;
  let holderIdentity: ProcessIdentity | undefined;
  let failure: string | undefined;
  const bound = performance.now() + 335_000;
  try {
    const startBound = performance.now() + 30_000;
    let subject: ProcessIdentity | undefined;
    while (!subject) {
      requireFact(
        !clientResult && !cause && performance.now() < startBound,
        'subject readiness/client/lease',
      );
      subject = await readReceipt(`${evidence}/subject/subject-ready.json`);
      if (!subject) await sleep(20);
    }
    const properties = await unitProperties(unit);
    await save(`${evidence}/properties.json`, properties);
    validateProperties(properties.properties, unit);
    requireFact(
      properties.properties.MainPID === String(subject.pid),
      'subject is MainPID',
    );
    requireFact(
      sameIdentity(subject, await processIdentity(subject.pid)),
      'fresh subject identity',
    );
    requireFact(
      JSON.stringify(subject.argv) === JSON.stringify(launchArgv),
      'actual intended subject argv',
    );
    requireFact(
      subject.executable === Deno.execPath() &&
        subject.cwd === `${root}/source`,
      'subject executable/cwd',
    );
    ticket = {
      boot,
      unit,
      invocation: properties.properties.InvocationID,
      group: properties.properties.ControlGroup,
      properties: properties.properties,
      subject,
      observer,
      client: clientIdentity,
      launchArgv,
      managerVersion,
      pins,
    };
    requireFact(
      subject.cgroup.trim() === `0::${ticket.group}`,
      'subject cgroup',
    );
    requireFact(
      observer.cgroup !== subject.cgroup &&
        clientIdentity.cgroup !== subject.cgroup,
      'outside observer/client',
    );
    await save(`${evidence}/containment.json`, ticket);
    while (!childIdentity) {
      requireFact(
        !clientResult && !cause && performance.now() < startBound,
        'child readiness/client/lease',
      );
      childIdentity = await readReceipt(`${evidence}/subject/child-ready.json`);
      if (!childIdentity) await sleep(20);
    }
    requireFact(
      sameIdentity(childIdentity, await processIdentity(childIdentity.pid)),
      'fresh child identity',
    );
    requireFact(
      childIdentity.cgroup === subject.cgroup,
      'fixture child membership',
    );
    if (caseName === 'pump-drain-timeout') {
      holderIdentity = await readReceipt<ProcessIdentity>(
        `${evidence}/subject/pipe-holder-ready.json`,
      );
      requireFact(
        holderIdentity &&
          sameIdentity(
            holderIdentity,
            await processIdentity(holderIdentity.pid),
          ) && holderIdentity.cgroup === subject.cgroup,
        'retained pipe descendant membership',
      );
    }
    await save(`${evidence}/armed.json`, {
      ticket,
      child: childIdentity,
      at: performance.now(),
    });
    await save(`${evidence}/subject/release.json`, { at: performance.now() });
    console.log(`WATCHDOG-ARMED ${evidence}`);

    if (
      implementation !== 'fixture' &&
      ['term', 'int', 'hup', 'lease-eof', 'term-ignore', 'cancel-join']
        .includes(caseName)
    ) {
      while (
        !(await fixtureEvents(evidence)).some((e) =>
          e.event === 'real-headers-stalled-body'
        )
      ) {
        requireFact(
          !clientResult && !cause && performance.now() < startBound,
          'real pending request readiness before interruption',
        );
        await sleep(20);
      }
    }
    if (caseName === 'driver-stopped') {
      while (
        !(await fixtureEvents(evidence)).some((e) =>
          e.event === 'trigger-ready'
        )
      ) {
        requireFact(
          !clientResult && !cause && performance.now() < startBound,
          'stopped driver readiness',
        );
        await sleep(20);
      }
    }

    if (caseName === 'qualify-main-kill') {
      await save(
        `${evidence}/trigger.json`,
        await signalIdentity(subject, 'SIGKILL'),
      );
    } else if (caseName === 'qualify-stopped-client-loss') {
      await save(
        `${evidence}/trigger.json`,
        await signalIdentity(subject, 'SIGSTOP'),
      );
      await signalIdentity(clientIdentity, 'SIGTERM');
    } else if (caseName === 'driver-stopped') {
      await save(
        `${evidence}/trigger.json`,
        await signalIdentity(subject, 'SIGSTOP'),
      );
    } else if (
      ['term', 'term-ignore', 'cancel-join', 'int', 'hup'].includes(caseName)
    ) {
      await save(
        `${evidence}/trigger.json`,
        await signalIdentity(
          subject,
          caseName === 'int'
            ? 'SIGINT'
            : caseName === 'hup'
            ? 'SIGHUP'
            : 'SIGTERM',
        ),
      );
    } else if (caseName === 'qualify-hup') {
      await save(
        `${evidence}/trigger.json`,
        await signalIdentity(subject, 'SIGHUP'),
      );
    } else if (caseName === 'qualify-lease-eof' || caseName === 'lease-eof') {
      await writer.close();
      subjectWriterClosed = true;
      await save(`${evidence}/trigger.json`, {
        event: 'intentional subject EOF',
        at: performance.now(),
      });
    }
    while (
      !(await groupAbsent(ticket.group) && await savedProcessAbsent(subject) &&
        await savedProcessAbsent(childIdentity) &&
        (!holderIdentity || await savedProcessAbsent(holderIdentity)))
    ) {
      requireFact(
        performance.now() < bound,
        'private group/process absence deadline',
      );
      if (cause && !subjectWriterClosed) {
        await writer.close();
        subjectWriterClosed = true;
        await save(`${evidence}/upstream-loss.json`, {
          cause,
          at: performance.now(),
        });
      }
      await sleep(50);
    }
    const clientStatus = await status;
    const pumpOutcomes = await Promise.all(pumps);
    requireFact(
      clientStatus.ok && pumpOutcomes.every((p) => p.ok),
      'client/pump settlement',
    );
    const joined = await readReceipt<
      {
        cause?: string;
        lease: { eof: boolean; events: { event: string; at: number }[] };
        joinedAt: number;
      }
    >(`${evidence}/subject/joined.json`);
    const terminal = await readReceipt<{ cause?: string; at: number }>(
      `${evidence}/subject/terminal.json`,
    );
    const managerOnly = [
      'qualify-main-exit0',
      'qualify-main-kill',
      'qualify-stopped-client-loss',
    ].includes(caseName);
    if (implementation === 'fixture' && !managerOnly) {
      requireFact(joined && terminal, 'subject joined/terminal receipts');
      const finalized = joined.lease.events.find((e) =>
        e.event === 'reader-finalized'
      );
      const leaseJoined = joined.lease.events.find((e) =>
        e.event === 'lease-joined'
      );
      requireFact(
        finalized && leaseJoined && finalized.at <= leaseJoined.at &&
          leaseJoined.at <= joined.joinedAt && joined.joinedAt <= terminal.at,
        'lease finalizer before joined/terminal',
      );
      const expected = caseName === 'qualify-hup'
        ? 'SIGHUP'
        : ['qualify-lease-eof', 'qualify-ssh-loss-arm'].includes(caseName)
        ? 'stdin EOF'
        : undefined;
      requireFact(
        joined.cause === expected && terminal.cause === expected,
        'actual interruption cause',
      );
      requireFact(
        joined.lease.eof === (expected === 'stdin EOF'),
        'EOF preserved',
      );
      requireFact(
        clientStatus.value.code === (expected ? 1 : 0),
        'subject client status',
      );
    }
    let terminalProperties: unknown;
    try {
      terminalProperties = await unitProperties(unit);
    } catch (error) {
      terminalProperties = {
        unavailable: String(error),
        alreadyAuditedAbsence: true,
      };
    }
    if (clientStatus.value.code !== 0) {
      requireFact(
        terminalProperties && typeof terminalProperties === 'object' &&
          'properties' in terminalProperties,
        'failed transient unit must remain observable',
      );
      const p = (terminalProperties as { properties: Record<string, string> })
        .properties;
      requireFact(
        p.LoadState === 'loaded' && p.InvocationID === ticket.invocation,
        'same failed invocation retained',
      );
      requireFact(
        p.ActiveState === 'failed' && p.MainPID === '0' &&
          p.Result !== 'success',
        'failed subject manager terminal state',
      );
      if (
        caseName === 'qualify-stopped-client-loss' ||
        caseName === 'driver-stopped'
      ) {
        requireFact(
          p.Result === 'timeout' && p.ExecMainCode === '2' &&
            p.ExecMainStatus === '9',
          '300s manager SIGKILL termination',
        );
      }
    }
    const journal = await new Deno.Command('/usr/bin/journalctl', {
      args: [
        '--user',
        '--no-pager',
        '-o',
        'json',
        `_SYSTEMD_INVOCATION_ID=${ticket.invocation}`,
      ],
    }).output();
    requireFact(journal.success, 'unit journal inspection');
    await Deno.writeFile(`${evidence}/unit-journal.jsonl`, journal.stdout, {
      createNew: true,
    });
    const oracle = implementation === 'fixture'
      ? { proved: true, checks: [] }
      : await regressionOracle(
        evidence,
        caseName,
        implementation,
        clientStatus.value.code,
      );
    await save(`${evidence}/oracle.json`, oracle);
    const observerLease = await lease.join();
    if (!subjectWriterClosed) {
      await writer.close();
      subjectWriterClosed = true;
    }
    writer.releaseLock();
    await save(`${evidence}/joined.json`, {
      observerLease,
      subjectJoined: joined,
      terminal,
      clientStatus,
      pumpOutcomes,
      terminalProperties,
      oracle,
      at: performance.now(),
    });
    await save(`${evidence}/terminal.json`, {
      caseName,
      cause,
      implementation,
      contractProved: oracle.proved,
      freshBoot: await bootIdentity(),
      groupAbsent: await groupAbsent(ticket.group),
      subjectAbsent: await savedProcessAbsent(subject),
      childAbsent: await savedProcessAbsent(childIdentity),
      managerOnly,
      holderAbsent: holderIdentity
        ? await savedProcessAbsent(holderIdentity)
        : undefined,
    });
    console.log(
      `${
        implementation === 'fixture' ? 'QUALIFICATION' : 'OWNERSHIP'
      } ${caseName} contract=${oracle.proved}`,
    );
    if (!oracle.proved) Deno.exitCode = 1;
  } catch (error) {
    failure = String(error);
    await save(`${evidence}/observer-failure.json`, {
      failure,
      cause,
      ticket,
      childIdentity,
    });
    // Keep the independent manager armed; no broad signal or failure reset.
    if (!subjectWriterClosed) {
      await observe(writer.close());
      subjectWriterClosed = true;
    }
    if (ticket) {
      while (!(await groupAbsent(ticket.group))) {
        requireFact(performance.now() < bound, 'failure audit bound');
        await sleep(100);
      }
    }
    await status;
    await Promise.all(pumps);
    await lease.join();
    writer.releaseLock();
    throw new Error(failure);
  }
}

if (import.meta.main) await run();
