// Development-only transient-service containment. No production dependencies.
export function requireFact(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`containment: ${message}`);
}

export type Outcome<T> = { ok: true; value: T } | { ok: false; error: string };
export function observe<T>(operation: Promise<T>): Promise<Outcome<T>> {
  return operation.then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error: String(error) }),
  );
}

export const bootIdentity = async () =>
  (await Deno.readTextFile('/proc/sys/kernel/random/boot_id')).trim();

export async function processIdentity(pid: number): Promise<ProcessIdentity> {
  const ticks = async () => {
    const stat = await Deno.readTextFile(`/proc/${pid}/stat`);
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  };
  const startTicks = await ticks();
  const boot = await bootIdentity();
  const argv = (await Deno.readTextFile(`/proc/${pid}/cmdline`)).split('\0')
    .filter(Boolean);
  const executable = await Deno.readLink(`/proc/${pid}/exe`);
  const cwd = await Deno.readLink(`/proc/${pid}/cwd`);
  const uid = (await Deno.readTextFile(`/proc/${pid}/status`))
    .match(/^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/m)?.slice(1);
  requireFact(uid && uid.every((n) => n === '1000'), 'process UID');
  const cgroup = await Deno.readTextFile(`/proc/${pid}/cgroup`);
  requireFact(startTicks === await ticks(), 'inconsistent process snapshot');
  requireFact(boot === await bootIdentity(), 'boot changed during observation');
  return { pid, boot, startTicks, argv, executable, cwd, uid, cgroup };
}
// Observation DTO, not a value-dependent certificate inferred from one sampler
// branch. Controlled invalid observations must remain representable at guards.
export type ProcessIdentity = {
  pid: number;
  boot: string;
  startTicks: string;
  argv: string[];
  executable: string;
  cwd: string;
  uid: string[];
  cgroup: string;
};

export function sameIdentity(a: ProcessIdentity, b: ProcessIdentity) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export async function signalIdentity(
  saved: ProcessIdentity,
  signal: Deno.Signal,
) {
  const fresh = await processIdentity(saved.pid);
  requireFact(sameIdentity(saved, fresh), `identity changed before ${signal}`);
  Deno.kill(saved.pid, signal);
  return fresh;
}

export async function savedProcessAbsent(saved: ProcessIdentity) {
  requireFact(await bootIdentity() === saved.boot, 'absence on different boot');
  try {
    const fresh = await processIdentity(saved.pid);
    return !sameIdentity(saved, fresh);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    // Corroborate proc absence, rather than treating any identity error as gone.
    try {
      await Deno.stat(`/proc/${saved.pid}`);
      return false;
    } catch (absence) {
      if (!(absence instanceof Deno.errors.NotFound)) throw absence;
      return true;
    }
  }
}

export async function save(path: string, value: unknown) {
  const pending = `${path}.pending`;
  await Deno.writeTextFile(pending, JSON.stringify(value, null, 2) + '\n', {
    createNew: true,
    mode: 0o600,
  });
  // Publish complete immutable bytes atomically without replacing a collision.
  await Deno.link(pending, path);
}

export async function sleep(ms: number) {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

// Intentional cancellation is latched before cancellation, and cannot erase EOF.
// Joining includes the actual pending reader and its release-lock finalizer.
export function stdinLease(failed: (cause: string) => void) {
  const reader = Deno.stdin.readable.getReader();
  let intentional = false;
  let eof = false;
  const events: { event: string; at: number }[] = [];
  const record = (event: string) =>
    events.push({ event, at: performance.now() });
  const reading = observe((async () => {
    record('reader-started');
    try {
      for (;;) {
        const result = await reader.read();
        if (result.done) {
          if (!intentional) {
            eof = true;
            record('unexpected-eof');
            failed('stdin EOF');
          }
          return;
        }
      }
    } catch (error) {
      record('reader-error');
      failed(`stdin read: ${String(error)}`);
      throw error;
    } finally {
      reader.releaseLock();
      record('reader-finalized');
    }
  })());
  return {
    events,
    outcome: reading,
    get eof() {
      return eof;
    },
    async join() {
      intentional = true;
      record('intentional-cancel');
      // A completed EOF reader has already released the lock.
      const cancelled = eof
        ? { ok: true as const, value: undefined }
        : await observe(reader.cancel('joined normal finalization'));
      const outcome = await reading;
      Deno.stdin.close();
      record('lease-joined');
      requireFact(cancelled.ok && outcome.ok, 'lease cancellation/read failed');
      return { eof, cancelled, outcome, events };
    },
  };
}

export const serviceProperties = [
  'Type=exec',
  'ExitType=main',
  'RemainAfterExit=no',
  'Restart=no',
  'KillMode=control-group',
  'KillSignal=SIGKILL',
  'FinalKillSignal=SIGKILL',
  'SendSIGKILL=yes',
  'SendSIGHUP=no',
  'TimeoutStartSec=30s',
  'TimeoutStartFailureMode=kill',
  'TimeoutStopSec=10s',
  'TimeoutStopFailureMode=kill',
  'RuntimeMaxSec=300s',
  'RuntimeRandomizedExtraSec=0',
  'CollectMode=inactive',
];

const propertyGroups = [
  'LoadState,Id,InvocationID,ControlGroup,MainPID,ExecStart',
  'ActiveState,SubState,Result,ExecMainCode,ExecMainStatus',
  'ActiveEnterTimestampMonotonic,ExecMainExitTimestampMonotonic',
  'Type,ExitType,RemainAfterExit,Restart,NRestarts',
  'KillMode,KillSignal,FinalKillSignal,SendSIGKILL,SendSIGHUP',
  'RuntimeMaxUSec,RuntimeRandomizedExtraUSec',
  'TimeoutStartUSec,TimeoutStopUSec,TimeoutStartFailureMode,TimeoutStopFailureMode',
  'ExecStop,ExecStopPost,CollectMode',
];

export async function unitProperties(unit: string) {
  const args = [
    '--user',
    'show',
    unit,
    '--all',
    ...propertyGroups.map((p) => `--property=${p}`),
  ];
  const output = await new Deno.Command('/usr/bin/systemctl', {
    args,
    env: { SYSTEMD_LOG_LEVEL: 'debug' },
  }).output();
  requireFact(output.success, new TextDecoder().decode(output.stderr));
  const raw = new TextDecoder().decode(output.stdout);
  const stderr = new TextDecoder().decode(output.stderr);
  const properties = Object.fromEntries(
    raw.trim().split('\n').map((line) => {
      const i = line.indexOf('=');
      return [line.slice(0, i), line.slice(i + 1)];
    }),
  );
  // systemctl prints no line for an empty Exec array, even with --all. Its
  // debug output distinguishes that from a requested property absent from GetAll.
  for (const name of propertyGroups.flatMap((p) => p.split(','))) {
    requireFact(
      !stderr.includes(`Property ${name} does not exist.`),
      `unsupported property ${name}`,
    );
  }
  if (properties.LoadState === 'loaded') {
    for (const name of ['ExecStop', 'ExecStopPost']) properties[name] ??= '';
  }
  return {
    args,
    raw,
    stderr,
    status: { code: output.code, signal: output.signal },
    properties,
  };
}

export function validateProperties(p: Record<string, string>, unit: string) {
  const expected = {
    LoadState: 'loaded',
    Id: unit,
    Type: 'exec',
    ExitType: 'main',
    RemainAfterExit: 'no',
    Restart: 'no',
    NRestarts: '0',
    KillMode: 'control-group',
    KillSignal: '9',
    FinalKillSignal: '9',
    SendSIGKILL: 'yes',
    SendSIGHUP: 'no',
    RuntimeMaxUSec: '5min',
    RuntimeRandomizedExtraUSec: '0',
    TimeoutStartUSec: '30s',
    TimeoutStopUSec: '10s',
    TimeoutStartFailureMode: 'kill',
    TimeoutStopFailureMode: 'kill',
    ExecStop: '',
    ExecStopPost: '',
    CollectMode: 'inactive',
  };
  for (const [key, value] of Object.entries(expected)) {
    requireFact(p[key] === value, `${key}: expected ${value}, got ${p[key]}`);
  }
  requireFact(/^[a-f0-9]{32}$/.test(p.InvocationID), 'InvocationID');
  requireFact(p.ControlGroup.endsWith(`/${unit}`), 'private service cgroup');
  requireFact(Number(p.MainPID) > 0, 'MainPID');
  requireFact(Number(p.ActiveEnterTimestampMonotonic) > 0, 'activation time');
}

export async function groupAbsent(group: string) {
  requireFact(
    group.startsWith('/user.slice/') && group.endsWith('.service'),
    'private group',
  );
  try {
    const events = await Deno.readTextFile(
      `/sys/fs/cgroup${group}/cgroup.events`,
    );
    return /^populated 0$/m.test(events);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    try {
      await Deno.stat(`/sys/fs/cgroup${group}`);
      return false;
    } catch (absence) {
      if (!(absence instanceof Deno.errors.NotFound)) throw absence;
      return true;
    }
  }
}

export type ContainmentTicket = {
  boot: string;
  unit: string;
  invocation: string;
  group: string;
  properties: Record<string, string>;
  subject: ProcessIdentity;
  observer: ProcessIdentity;
  client: ProcessIdentity;
  launchArgv: string[];
  managerVersion: string;
  pins: Record<string, string>;
};

export async function checkMembership(ticket: ContainmentTicket) {
  const actual = await processIdentity(Deno.pid);
  requireFact(sameIdentity(actual, ticket.subject), 'subject ticket identity');
  requireFact(
    actual.cgroup.trim() === `0::${ticket.group}`,
    'subject outside group',
  );
  requireFact(
    ticket.observer.cgroup.trim() !== actual.cgroup.trim(),
    'observer inside group',
  );
  requireFact(
    ticket.client.cgroup.trim() !== actual.cgroup.trim(),
    'client inside group',
  );
  validateProperties(ticket.properties, ticket.unit);
  return actual;
}
