// Short owner contracts. Real 10/30/270/300s child/interruption cases live in
// the fixed-case VM observer; these tests never substitute shortened clocks.
import { assert, assertEquals, assertRejects, assertThrows } from '@std/assert';
import {
  assertLaunchIdentity,
  assertSignalIdentity,
  OwnedRun,
  RUN_BUDGETS,
  supervisorBound,
} from '../dev/helpers/owned-run.ts';
import type {
  ContainmentTicket,
  ProcessIdentity,
} from '../dev/helpers/transient-watchdog.ts';

const short = {
  ...RUN_BUDGETS,
  active: 100,
  cleanup: 100,
  hard: 1000,
  publication: 100,
  term: 40,
  reap: 30,
  request: 50,
};
const facts: ProcessIdentity = {
  pid: 123,
  boot: 'fixture-boot',
  startTicks: '456',
  argv: ['/home/tester/.deno/bin/deno', 'run', 'fixture.ts'],
  executable: '/home/tester/.deno/bin/deno',
  cwd: '/fixture/source',
  uid: ['1000', '1000', '1000', '1000'],
  cgroup: '0::/user.slice/fixture.service\n',
};
const ticket = {
  boot: facts.boot,
  unit: 'fixture.service',
  invocation: '0'.repeat(32),
  group: '/user.slice/fixture.service',
  properties: { ActiveEnterTimestampMonotonic: '1000000' },
  subject: facts,
  observer: { ...facts, pid: 100 },
  client: { ...facts, pid: 101 },
  launchArgv: facts.argv,
  managerVersion: 'fixture',
  pins: {},
} as ContainmentTicket;

Deno.test('owned run public operation joins actual work/resources before publication and terminal', async () => {
  const owner = new OwnedRun({ budgets: short });
  const order: string[] = [];
  const dir = await Deno.makeTempDir({ prefix: 'owned-run-resource-' });
  const file = await Deno.open(`${dir}/resource`, {
    createNew: true,
    write: true,
  });
  try {
    const result = await owner.run(async (run) => {
      run.resource('native file', () => {
        file.close();
        order.push('resource closed');
      });
      await run.operation(
        'native write',
        () => file.write(new Uint8Array([1, 2, 3])),
      );
      order.push('work ended');
    }, async (run, joined) => {
      assertEquals(run.stage, 'publishing');
      assert(joined.success && joined.workJoined && joined.resourcesClosed);
      assert(joined.joined !== undefined);
      await assertRejects(() => file.stat(), Deno.errors.BadResource);
      order.push('publication');
    });
    assert(result.success);
    assertEquals(result.stage, 'terminal');
    assertEquals(result.unresolved, []);
    assertEquals(order, ['work ended', 'resource closed', 'publication']);
    assertEquals(owner.events.map((e) => e.stage), [
      'preflight',
      'closing',
      'joined',
      'publishing',
      'terminal',
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('owned failure is synchronously latched and close joins a delayed actual finalizer', async () => {
  const owner = new OwnedRun({ budgets: short });
  let finalized = false;
  let finalizerEnd = 0;
  const result = await owner.run(async (run) => {
    run.resource('delayed finalizer', async () => {
      await run.sleep(20, run.cleanupDeadline!, 'finalizer');
      finalized = true;
      finalizerEnd = performance.now();
    });
    await run.operation(
      'intentional rejection',
      () => Promise.reject(new Error('first cause')),
    );
  }, (run, summary) => {
    assert(finalized && summary.joined! >= finalizerEnd);
    assertEquals(run.stage, 'publishing');
    assert(summary.failure?.includes('first cause'));
    return Promise.resolve();
  });
  assert(!result.success && result.workJoined && result.resourcesClosed);
  assertEquals(result.unresolved, []);
});

Deno.test('owned cancellation joins controlled work finally before publishing; later failures cannot erase first cause', async () => {
  const owner = new OwnedRun({ budgets: short });
  const steps: string[] = [];
  const result = await owner.run(async (run) => {
    try {
      const rejecting = run.operation(
        'first',
        () => Promise.reject(new Error('first failure')),
      );
      await rejecting;
    } finally {
      run.fail('later failure');
      await run.sleep(20, run.cleanupDeadline!, 'finalizer');
      steps.push('actual work finalizer');
    }
  }, (_run, summary) => {
    assert(summary.workJoined);
    assertEquals(steps, ['actual work finalizer']);
    assert(summary.failure?.includes('first failure'));
    assert(summary.diagnostics.some((d) => d.includes('later failure')));
    steps.push('publication');
    return Promise.resolve();
  });
  assert(!result.success);
  assertEquals(steps, ['actual work finalizer', 'publication']);
});

Deno.test('owned detached operation is observed immediately and cannot create an unhandled rejection', async () => {
  const owner = new OwnedRun({ budgets: short });
  const result = await owner.run((run) => {
    // Deliberately do not await: the owner still owns this exact native promise.
    run.operation(
      'detached rejection',
      () => Promise.reject(new Error('observed rejection')),
    );
    return Promise.resolve();
  }, (_run, summary) => {
    assert(!summary.success && summary.failure?.includes('observed rejection'));
    assertEquals(summary.unresolved, []);
    return Promise.resolve();
  });
  assert(!result.success && result.workJoined);
});

Deno.test('owned preflight uses the original absolute active bound and blocks new work on failure', async () => {
  const budgets = { ...short, active: 25 };
  const owner = new OwnedRun({ budgets });
  const initialDeadline = owner.activeDeadline;
  let lateStarted = false;
  const result = await owner.run(async (run) => {
    await run.sleep(100);
    await run.operation('must not start', () => {
      lateStarted = true;
      return Promise.resolve();
    });
  }, (_run, summary) => {
    assertEquals(summary.activeDeadline, initialDeadline);
    assertEquals(initialDeadline, summary.started + 25);
    assert(summary.closing! >= initialDeadline);
    return Promise.resolve();
  });
  assert(!result.success && !lateStarted);
  assert(result.failure?.includes('active-work deadline'));
});

Deno.test('owned partial launch failure closes files opened before spawn without launching a child', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'owned-partial-' });
  await Deno.writeTextFile(`${dir}/exists`, 'preserved');
  const owner = new OwnedRun({ budgets: short });
  try {
    const result = await owner.run(async (run) => {
      await run.launch({
        executable: Deno.execPath(),
        args: ['run', 'never-spawn.ts'],
        cwd: Deno.cwd(),
        env: {},
        stdout: `${dir}/stdout`,
        stderr: `${dir}/exists`,
      });
    }, (_run, summary) => {
      assert(!summary.success && summary.resourcesClosed && summary.workJoined);
      assertEquals(summary.childIdentity, undefined);
      assert(
        summary.resources.some((r) => r.name === 'stdout file' && r.closed),
      );
      return Promise.resolve();
    });
    assert(!result.success);
    assertEquals(await Deno.readTextFile(`${dir}/exists`), 'preserved');
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('owned publication rejection remains failure after joined work and resources', async () => {
  const owner = new OwnedRun({ budgets: short });
  const result = await owner.run(
    () => Promise.resolve(),
    () => Promise.reject(new Error('publisher failed')),
  );
  assert(!result.success && result.workJoined && result.resourcesClosed);
  assert(result.failure?.includes('publisher failed'));
  assertEquals(result.unresolved, []);
});

Deno.test('owned deadline helpers reject expired phases rather than round them up', async () => {
  const owner = new OwnedRun({ budgets: short });
  const result = await owner.run((run) => {
    assertThrows(() => run.assertWork(performance.now() - 1));
    assertThrows(() =>
      run.request('http://127.0.0.1:1', {}, {
        phaseDeadline: performance.now() - 1,
      })
    );
    return Promise.resolve();
  }, () => Promise.resolve());
  assert(result.success);
});

Deno.test('same full identity contract guards initial launch and both TERM/KILL with every field and observation error', () => {
  const launch = {
    executable: facts.executable,
    args: facts.argv.slice(1),
    cwd: facts.cwd,
    env: {},
    stdout: 'stdout',
    stderr: 'stderr',
  };
  assertLaunchIdentity(facts, launch, ticket);
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    assertEquals(
      assertSignalIdentity(facts, { ok: true, value: facts }, signal),
      facts,
    );
    for (
      const [field, value] of Object.entries({
        pid: 999,
        boot: 'other',
        startTicks: '457',
        argv: [...facts.argv, 'extra'],
        executable: '/other',
        cwd: '/other',
        uid: ['1001'],
        cgroup: '0::/other.service\n',
      })
    ) {
      assertThrows(() =>
        assertSignalIdentity(facts, {
          ok: true,
          value: { ...facts, [field]: value },
        }, signal)
      );
    }
    for (
      const error of [
        'NotFound without corroboration',
        'PermissionDenied',
        'I/O observation error',
      ]
    ) {
      assertThrows(() =>
        assertSignalIdentity(facts, { ok: false, error }, signal)
      );
    }
  }
  assertThrows(() =>
    assertLaunchIdentity(
      { ...facts, argv: [facts.executable, 'different'] },
      launch,
      ticket,
    )
  );
  assertThrows(() =>
    assertLaunchIdentity({ ...facts, executable: '/other' }, launch, ticket)
  );
  assertThrows(() =>
    assertLaunchIdentity({ ...facts, cwd: '/other' }, launch, ticket)
  );
  assertThrows(() =>
    assertLaunchIdentity({ ...facts, uid: ['1001'] }, launch, ticket)
  );
  assertThrows(() =>
    assertLaunchIdentity({ ...facts, cgroup: '0::/other' }, launch, ticket)
  );
});

Deno.test('supervisor deadline bridge is conservative and rejects malformed clock data', () => {
  assertEquals(supervisorBound(ticket, 50, '1.00 0.00\n'), 300040);
  assertEquals(supervisorBound(ticket, 50, '301.00 0.00\n'), 50);
  assertThrows(() => supervisorBound(ticket, 50, 'garbage'));
  assertThrows(() =>
    supervisorBound(
      { ...ticket, properties: { ActiveEnterTimestampMonotonic: 'NaN' } },
      50,
      '1.00 0.00\n',
    )
  );
});

Deno.test('cold driver import is side-effect-free without CLI arguments or application startup', async () => {
  const module = await import('../dev/opensubsonic/cold-http.ts');
  assertEquals(typeof module.runCold, 'function');
});
