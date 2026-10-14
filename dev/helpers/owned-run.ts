// Development-only lifetime owner. Callers supply work, publication and launch
// inputs; this module alone owns child status, pumps, cancellation and joining.
import { createHash } from 'node:crypto';
import {
  checkMembership,
  type ContainmentTicket,
  type Outcome,
  type ProcessIdentity,
  processIdentity,
  requireFact,
  sameIdentity,
  savedProcessAbsent,
  stdinLease,
} from './transient-watchdog.ts';

type Budgets = Readonly<
  {
    active: number;
    cleanup: number;
    hard: number;
    publication: number;
    term: number;
    reap: number;
    request: number;
  }
>;
export const RUN_BUDGETS: Budgets = Object.freeze({
  active: 270_000,
  cleanup: 10_000,
  hard: 300_000,
  publication: 20_000,
  term: 5_000,
  reap: 3_000,
  request: 10_000,
});
export type Stage =
  | 'preflight'
  | 'running'
  | 'closing'
  | 'joined'
  | 'publishing'
  | 'terminal';
type Kind =
  | 'work'
  | 'status'
  | 'identity'
  | 'pump'
  | 'drain'
  | 'lease'
  | 'owner'
  | 'finalizer'
  | 'publication';
type Operation = {
  name: string;
  kind: Kind;
  started: number;
  settled?: number;
  outcome?: Outcome<unknown>;
  joined: Promise<Outcome<unknown>>;
};
type Resource = {
  name: string;
  closed: boolean;
  close: () => void | Promise<void>;
  outcome?: Outcome<void>;
};
export type Launch = {
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  stdout: string | WritableStream<Uint8Array>;
  stderr: string | WritableStream<Uint8Array>;
};
export type RunSummary = {
  stage: Stage;
  success: boolean;
  failure?: string;
  diagnostics: string[];
  started: number;
  closing?: number;
  joined?: number;
  terminal?: number;
  activeDeadline: number;
  cleanupDeadline?: number;
  hardDeadline: number;
  childIdentity?: ProcessIdentity;
  childStatus?: Deno.CommandStatus;
  childReaped: boolean;
  forcedTermination: boolean;
  logsComplete: boolean;
  workJoined: boolean;
  resourcesClosed: boolean;
  lease?: unknown;
  signals: unknown[];
  operations: {
    name: string;
    kind: Kind;
    started: number;
    settled?: number;
    outcome?: Outcome<unknown>;
  }[];
  unresolved: string[];
  resources: { name: string; closed: boolean; outcome?: Outcome<void> }[];
};

// /proc/uptime is CLOCK_BOOTTIME, truncated to hundredths by Linux uptime.c.
// BOOTTIME >= MONOTONIC: its upper quantization edge gives a conservative bound
// for systemd's monotonic activation deadline. Anchor before the async read so
// the read's latency cannot extend that deadline. No wall-clock conversion.
export function supervisorBound(
  ticket: ContainmentTicket,
  beforeRead: number,
  uptime: string,
): number {
  const match = /^([0-9]+)\.([0-9]{2})\s/.exec(uptime);
  requireFact(match, 'kernel uptime format');
  const bootUpperMs = Number(match[1]) * 1_000 + Number(match[2]) * 10 + 10;
  const activatedUs = Number(ticket.properties.ActiveEnterTimestampMonotonic);
  requireFact(
    Number.isSafeInteger(activatedUs) && activatedUs > 0 &&
      Number.isFinite(bootUpperMs),
    'supervisor clock observations',
  );
  return beforeRead +
    Math.max(0, activatedUs / 1_000 + RUN_BUDGETS.hard - bootUpperMs);
}

export function assertLaunchIdentity(
  actual: ProcessIdentity,
  input: Launch,
  ticket?: ContainmentTicket,
) {
  requireFact(
    JSON.stringify(actual.argv) ===
      JSON.stringify([input.executable, ...input.args]),
    'child actual argv differs from intended launch',
  );
  requireFact(
    actual.executable === input.executable && actual.cwd === input.cwd &&
      JSON.stringify(actual.uid) ===
        JSON.stringify(['1000', '1000', '1000', '1000']),
    'child intended executable/cwd/UID',
  );
  if (ticket) {
    requireFact(
      actual.boot === ticket.boot &&
        actual.cgroup.trim() === `0::${ticket.group}`,
      'child private cgroup/boot',
    );
  }
}

export function assertSignalIdentity(
  saved: ProcessIdentity,
  observation: Outcome<ProcessIdentity>,
  signal: Deno.Signal,
) {
  requireFact(observation.ok, `identity observation failed before ${signal}`);
  requireFact(
    sameIdentity(saved, observation.value),
    `full identity changed before ${signal}`,
  );
  return observation.value;
}

export class OwnedRun {
  readonly started: number;
  private readonly workAbort = new AbortController();
  private readonly drainAbort = new AbortController();
  private readonly publicationAbort = new AbortController();
  readonly budgets: Budgets;
  private stageEvents: { stage: Stage; at: number }[] = [];
  private currentStage: Stage = 'preflight';
  private activeBound: number;
  private hardBound: number;
  private cleanupBound?: number;
  private firstFailure?: string;
  get events() {
    return this.stageEvents.map((event) => ({ ...event }));
  }
  get stage() {
    return this.currentStage;
  }
  get activeDeadline() {
    return this.activeBound;
  }
  get hardDeadline() {
    return this.hardBound;
  }
  get cleanupDeadline() {
    return this.cleanupBound;
  }
  get failure() {
    return this.firstFailure;
  }
  get workSignal() {
    return this.workAbort.signal;
  }
  get publicationSignal() {
    return this.publicationAbort.signal;
  }
  private diagnostics: string[] = [];
  private operations: Operation[] = [];
  private resources: Resource[] = [];
  private timers = new Map<
    ReturnType<typeof setTimeout>,
    ReturnType<typeof setTimeout>
  >();
  private activeTimer?: ReturnType<typeof setTimeout>;
  private hardTimer?: ReturnType<typeof setTimeout>;
  private cleanupTimer?: ReturnType<typeof setTimeout>;
  private signalHandlers = new Map<Deno.Signal, () => void>();
  private lease?: ReturnType<typeof stdinLease>;
  private leaseReceipt?: unknown;
  private child?: Deno.ChildProcess;
  private childSaved?: ProcessIdentity;
  private childStatus?: Deno.CommandStatus;
  private childStatusJoin?: Promise<Outcome<Deno.CommandStatus>>;
  private childIdentityJoin?: Promise<Outcome<ProcessIdentity>>;
  private pumps: Operation[] = [];
  private work?: Operation;
  private closeJoin?: Promise<void>;
  private closingAt?: number;
  private joinedAt?: number;
  private terminalAt?: number;
  private forced = false;
  private signals: unknown[] = [];
  private ticket?: ContainmentTicket;

  constructor(
    private options: Readonly<{
      lease?: boolean;
      budgets?: Budgets;
      // Only unit tests replace emergency exit. Fixed real-child/cold CLI maps do not.
      emergencyExit?: (code: number) => void;
    }> = {},
  ) {
    this.options = Object.freeze({ ...options });
    this.started = performance.now();
    this.budgets = Object.freeze({ ...(options.budgets ?? RUN_BUDGETS) });
    this.activeBound = this.started + this.budgets.active;
    this.hardBound = this.started + this.budgets.hard;
    this.stageEvents.push({ stage: 'preflight', at: this.started });
    this.activeTimer = this.timer(
      this.activeDeadline,
      () => this.fail('active-work deadline exceeded'),
    );
    this.armHard();
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
      const handler = () => this.fail(`driver ${signal}`);
      Deno.addSignalListener(signal, handler);
      this.signalHandlers.set(signal, handler);
    }
    if (options.lease) {
      this.lease = stdinLease((cause) => this.fail(cause));
      this.track(
        'stdin lease reader',
        'lease',
        this.lease.outcome,
        true,
        (outcome) => {
          if (!outcome.ok) this.fail(`stdin lease reader: ${outcome.error}`);
        },
      );
    }
  }

  private transition(stage: Stage) {
    this.currentStage = stage;
    this.stageEvents.push({ stage, at: performance.now() });
  }
  private timer(deadline: number, callback: () => void) {
    const tick = () => {
      if (!this.timers.has(key)) return;
      const remaining = deadline - performance.now();
      if (remaining > 0) {
        this.timers.set(key, setTimeout(tick, Math.ceil(remaining)));
        return;
      }
      this.timers.delete(key);
      callback();
    };
    const key = setTimeout(
      tick,
      Math.max(0, Math.ceil(deadline - performance.now())),
    );
    this.timers.set(key, key);
    return key;
  }
  private cancelTimer(timer?: ReturnType<typeof setTimeout>) {
    if (timer !== undefined) {
      const handle = this.timers.get(timer);
      if (handle !== undefined) clearTimeout(handle);
      this.timers.delete(timer);
    }
  }
  private armHard() {
    this.cancelTimer(this.hardTimer);
    this.hardTimer = this.timer(this.hardDeadline, () => {
      this.fail('hard driver deadline exceeded');
      this.drainAbort.abort(new Error('hard driver deadline'));
      this.publicationAbort.abort(new Error('hard driver deadline'));
      // Never put a synchronous evidence write before emergency termination.
      (this.options.emergencyExit ?? Deno.exit)(1);
    });
  }
  fail(cause: unknown) {
    const text = String(cause);
    if (this.stage === 'terminal') return;
    if (this.failure === undefined) this.firstFailure = text;
    else this.diagnostics.push(text);
    this.workAbort.abort(new Error(this.failure));
    this.startClose();
  }
  private track<T>(
    name: string,
    kind: Kind,
    promise: Promise<T>,
    fatal = true,
    success?: (value: T) => void,
  ): Operation {
    const entry: Operation = {
      name,
      kind,
      started: performance.now(),
      joined: undefined!,
    };
    // Neither completion branch rethrows; every derived observer is retained.
    entry.joined = promise.then((value) => {
      try {
        success?.(value);
      } catch (error) {
        this.fail(error);
      }
      const outcome = { ok: true as const, value };
      entry.outcome = outcome;
      entry.settled = performance.now();
      return outcome;
    }, (error) => {
      const outcome = { ok: false as const, error: String(error) };
      entry.outcome = outcome;
      entry.settled = performance.now();
      if (fatal) this.fail(`${name}: ${String(error)}`);
      else this.diagnostics.push(`${name}: ${String(error)}`);
      return outcome;
    });
    this.operations.push(entry);
    return entry;
  }
  operation<T>(
    name: string,
    start: () => Promise<T>,
    kind: Kind = 'work',
    fatal = true,
  ): Promise<T> {
    if (kind === 'work') this.assertWork();
    if (kind === 'publication') this.publicationAbort.signal.throwIfAborted();
    if (this.stage === 'terminal') {
      throw new Error('terminal owner refuses new operation');
    }
    let promise: Promise<T>;
    try {
      promise = start();
    } catch (error) {
      promise = Promise.reject(error);
    }
    this.track(name, kind, promise, fatal);
    return promise;
  }
  assertWork(deadline = this.activeDeadline) {
    this.workAbort.signal.throwIfAborted();
    requireFact(
      this.stage === 'preflight' || this.stage === 'running',
      'owner refuses new work while closing',
    );
    requireFact(
      performance.now() < Math.min(deadline, this.activeDeadline),
      'expired work/phase deadline',
    );
  }
  attachSupervisor(ticket: ContainmentTicket) {
    const intended = structuredClone(ticket);
    return this.operation(
      'attach supervisor',
      () => this.attachSupervisorInner(intended),
    );
  }
  private async attachSupervisorInner(ticket: ContainmentTicket) {
    await this.operation(
      'supervisor membership',
      () => checkMembership(ticket),
    );
    const before = performance.now();
    const uptime = await this.operation(
      'supervisor clock',
      () => Deno.readTextFile('/proc/uptime'),
    );
    this.ticket = ticket;
    this.hardBound = Math.min(
      this.hardDeadline,
      supervisorBound(ticket, before, uptime),
    );
    requireFact(
      this.hardDeadline > performance.now(),
      'expired supervisor deadline',
    );
    this.armHard();
  }
  resource(name: string, close: () => void | Promise<void>) {
    this.addResource(name, close);
  }
  private addResource(name: string, close: () => void | Promise<void>) {
    requireFact(
      this.stage !== 'terminal' && this.stage !== 'publishing',
      'resource registration after join',
    );
    const resource: Resource = { name, close, closed: false };
    this.resources.push(resource);
    return resource;
  }
  private async closeResource(resource: Resource) {
    if (resource.closed) return;
    const promise = (async () => {
      await resource.close();
      resource.closed = true;
    })();
    const op = this.track(`close ${resource.name}`, 'finalizer', promise);
    resource.outcome = await op.joined as Outcome<void>;
  }
  hash(path: string): Promise<string> {
    return this.operation(`hash ${path}`, async () => {
      let owned: Resource | undefined;
      const opening = Deno.open(path);
      const opened = this.track(
        `open hash ${path}`,
        'work',
        opening,
        true,
        (file) => {
          owned = this.addResource(`hash ${path}`, () => file.close());
        },
      );
      const outcome = await opened.joined as Outcome<Deno.FsFile>;
      if (!outcome.ok) throw new Error(outcome.error);
      const file = outcome.value;
      const hash = createHash('sha256');
      const buffer = new Uint8Array(64 * 1024);
      try {
        for (;;) {
          this.assertWork();
          const n = await this.operation(
            `read hash ${path}`,
            () => file.read(buffer),
          );
          if (n === null) break;
          hash.update(buffer.subarray(0, n));
        }
        return hash.digest('hex');
      } finally {
        if (owned) await this.closeResource(owned);
      }
    });
  }
  writeJSON(path: string, value: unknown, publication = false) {
    return this.operation(
      `write ${path}`,
      () =>
        Deno.writeTextFile(path, JSON.stringify(value, null, 2) + '\n', {
          createNew: true,
          mode: 0o600,
          signal: publication
            ? this.publicationAbort.signal
            : this.workAbort.signal,
        }),
      publication ? 'publication' : 'work',
    );
  }
  sleep(
    milliseconds: number,
    deadline = this.activeDeadline,
    kind: Kind = 'work',
  ) {
    const signal = kind === 'work'
      ? this.workAbort.signal
      : kind === 'publication'
      ? this.publicationAbort.signal
      : this.drainAbort.signal;
    if (kind === 'work') this.assertWork(deadline);
    signal.throwIfAborted();
    const end = Math.min(performance.now() + milliseconds, deadline);
    requireFact(end > performance.now(), 'expired sleep deadline');
    return this.operation(
      'owned sleep',
      () =>
        new Promise<void>((resolve, reject) => {
          const aborted = () => {
            this.cancelTimer(timer);
            signal.removeEventListener('abort', aborted);
            reject(signal.reason);
          };
          signal.addEventListener('abort', aborted, { once: true });
          const timer = this.timer(end, () => {
            signal.removeEventListener('abort', aborted);
            resolve();
          });
        }),
      kind,
    );
  }
  private async sink(input: Launch['stdout'], name: string) {
    if (typeof input !== 'string') return input;
    let file!: Deno.FsFile;
    const opening = Deno.open(input, {
      createNew: true,
      write: true,
      mode: 0o600,
    });
    const op = this.track(`open ${name}`, 'work', opening, true, (value) => {
      file = value;
      this.resource(`${name} file`, () => file.close());
    });
    const result = await op.joined;
    if (!result.ok) throw new Error(result.error);
    return new WritableStream<Uint8Array>({
      write: (chunk) =>
        this.operation(`${name} chunk`, async () => {
          let offset = 0;
          while (offset < chunk.length) {
            const written = await this.operation(`${name} write`, () =>
              file.write(chunk.subarray(offset)), 'drain');
            requireFact(written > 0, `${name} writer made no progress`);
            offset += written;
          }
        }, 'drain'),
    });
  }
  launch(input: Launch): Promise<ProcessIdentity> {
    const intended = { ...input, args: [...input.args], env: { ...input.env } };
    return this.operation('launch child', () => this.launchInner(intended));
  }
  private async launchInner(input: Launch): Promise<ProcessIdentity> {
    this.assertWork();
    requireFact(!this.child, 'owner permits exactly one child');
    const stdout = await this.sink(input.stdout, 'stdout');
    const stderr = await this.sink(input.stderr, 'stderr');
    this.assertWork();
    const parent = await this.operation(
      'launch parent identity',
      () => processIdentity(Deno.pid),
    );
    const child = new Deno.Command(input.executable, {
      args: input.args,
      cwd: input.cwd,
      clearEnv: true,
      env: input.env,
      stdin: 'null',
      stdout: 'piped',
      stderr: 'piped',
    }).spawn();
    this.child = child;
    const status = this.track(
      'child status',
      'status',
      child.status,
      true,
      (value) => {
        this.childStatus = value;
        if (this.stage === 'preflight' || this.stage === 'running') {
          this.fail(
            `child exited before owned closing: ${value.code}`,
          );
        }
      },
    );
    this.childStatusJoin = status.joined as Promise<
      Outcome<Deno.CommandStatus>
    >;
    this.pumps = [
      this.track(
        'stdout pump',
        'pump',
        child.stdout.pipeTo(stdout, { signal: this.drainAbort.signal }),
      ),
      this.track(
        'stderr pump',
        'pump',
        child.stderr.pipeTo(stderr, { signal: this.drainAbort.signal }),
      ),
    ];
    const identifying = processIdentity(child.pid);
    const identity = this.track(
      'initial child identity',
      'identity',
      identifying,
      true,
      (actual) => {
        assertLaunchIdentity(actual, input, this.ticket);
        requireFact(
          actual.boot === parent.boot && actual.cgroup === parent.cgroup,
          'child launch inheritance differs from intended parent scope',
        );
        this.childSaved = structuredClone(actual);
      },
    );
    this.childIdentityJoin = identity.joined as Promise<
      Outcome<ProcessIdentity>
    >;
    const outcome = await this.childIdentityJoin;
    if (!outcome.ok) throw new Error(outcome.error);
    this.assertWork();
    this.transition('running');
    return structuredClone(outcome.value);
  }
  request(url: string | URL, init: RequestInit = {}, options: {
    phaseDeadline?: number;
    receipt?: (
      response: {
        url: string;
        status: number;
        contentType: string | null;
        body: string;
      },
      signal: AbortSignal,
    ) => Promise<void>;
    retryableConnect?: boolean;
  } = {}) {
    const phase = Math.min(
      options.phaseDeadline ?? this.activeDeadline,
      this.activeDeadline,
    );
    this.assertWork(phase);
    const deadline = Math.min(performance.now() + this.budgets.request, phase);
    const abort = new AbortController();
    const signal = AbortSignal.any([this.workAbort.signal, abort.signal]);
    const timer = this.timer(deadline, () => {
      const error = new Error('HTTP/phase deadline exceeded');
      abort.abort(error);
      this.fail(error);
    });
    const promise = (async () => {
      try {
        const response = await this.operation(
          'HTTP headers',
          () => fetch(url, { ...init, signal }),
          'work',
          !options.retryableConnect,
        );
        const body = await this.operation('HTTP body', () => response.text());
        this.assertWork(deadline);
        const value = {
          url: String(url),
          status: response.status,
          contentType: response.headers.get('content-type'),
          body,
        };
        if (options.receipt) {
          await this.operation(
            'HTTP receipt',
            () => options.receipt!(value, signal),
          );
        }
        this.assertWork(deadline);
        return value;
      } finally {
        this.cancelTimer(timer);
      }
    })();
    this.track('HTTP chain', 'work', promise, !options.retryableConnect);
    return promise;
  }
  poll<T>(
    deadline: number,
    read: (deadline: number) => Promise<T>,
    accepts: (value: T) => boolean,
  ) {
    return this.operation(
      'poll chain',
      () => this.pollInner(deadline, read, accepts),
    );
  }
  private async pollInner<T>(
    deadline: number,
    read: (deadline: number) => Promise<T>,
    accepts: (value: T) => boolean,
  ) {
    for (;;) {
      this.assertWork(deadline);
      const value = await this.operation('poll read', () => read(deadline));
      this.assertWork(deadline); // A late response cannot become timely success.
      if (accepts(value)) return value;
      await this.sleep(100, deadline);
    }
  }
  private async until(
    promise: Promise<unknown>,
    deadline: number,
  ): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelTimeout!: () => void;
    const timeout = new Promise<boolean>((resolve) => {
      cancelTimeout = () => resolve(true);
      timer = this.timer(deadline, () => resolve(false));
    });
    const timed = this.track(
      'deadline timer outcome',
      'finalizer',
      timeout,
      false,
    );
    // The underlying promise was already retained as an outcome. This race only
    // chooses escalation; callers must still join the original operation.
    const observed = this.track(
      'join group observation',
      'finalizer',
      promise,
      false,
    );
    const selection = observed.joined.then(() => true);
    this.track('deadline selection', 'finalizer', selection, false);
    const race = Promise.race([selection, timeout]);
    this.track('deadline race', 'finalizer', race, false);
    try {
      return await race;
    } finally {
      this.cancelTimer(timer);
      cancelTimeout();
      await timed.joined;
    }
  }
  private async signal(signal: Deno.Signal, deadline = this.cleanupDeadline!) {
    const child = this.child!;
    if (!this.childSaved && this.childIdentityJoin) {
      await this.childIdentityJoin;
    }
    requireFact(this.childSaved, 'cannot signal unverified initial child');
    try {
      const fresh = await this.operation(
        `identity before ${signal}`,
        () => processIdentity(child.pid),
        'identity',
        false,
      );
      assertSignalIdentity(this.childSaved, { ok: true, value: fresh }, signal);
      requireFact(
        performance.now() < deadline,
        `expired verified ${signal} boundary`,
      );
      this.signals.push({ signal, identity: fresh, at: performance.now() });
      child.kill(signal);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        if (!this.childStatus && this.childStatusJoin) {
          await this.until(this.childStatusJoin, this.cleanupDeadline!);
        }
        if (this.childStatus && await savedProcessAbsent(this.childSaved)) {
          this.signals.push({ signal, absent: true, status: this.childStatus });
          return;
        }
      }
      throw error;
    }
  }
  private startClose() {
    if (
      this.closeJoin || this.stage === 'closing' || this.stage === 'joined' ||
      this.stage === 'publishing' || this.stage === 'terminal'
    ) return;
    this.closingAt = performance.now();
    this.cleanupBound = Math.min(
      this.closingAt + this.budgets.cleanup,
      this.started + this.budgets.active + this.budgets.cleanup,
      this.hardDeadline,
    );
    this.transition('closing');
    this.cancelTimer(this.activeTimer);
    this.workAbort.abort(new Error(this.failure ?? 'normal owned shutdown'));
    this.cleanupTimer = this.timer(this.cleanupDeadline!, () => {
      this.fail('cleanup deadline exceeded');
      this.drainAbort.abort(new Error('cleanup deadline'));
    });
    // Assign before the microtask starts, so even synchronous failure is idempotent.
    this.closeJoin = Promise.resolve().then(() => this.close());
    this.track('closing owner', 'finalizer', this.closeJoin, false);
  }
  private async close() {
    const deadline = this.cleanupDeadline!;
    if (this.child && this.childStatusJoin && !this.childStatus) {
      try {
        await this.signal('SIGTERM');
        const termBound = Math.min(
          this.closingAt! + this.budgets.term,
          deadline,
        );
        // TERM's allowance is at most five seconds, including fresh KILL
        // observation. Start escalation earlier and refuse a late/unverified PID.
        const observeBound = Math.min(
          this.closingAt! + this.budgets.term * 0.8,
          termBound,
        );
        if (!await this.until(this.childStatusJoin, observeBound)) {
          await this.signal('SIGKILL', termBound);
          this.forced = true;
          this.fail('forced child SIGKILL');
          await this.until(
            this.childStatusJoin,
            Math.min(performance.now() + this.budgets.reap, deadline),
          );
        }
      } catch (error) {
        this.fail(`child cleanup: ${String(error)}`);
      }
    }
    if (this.childStatusJoin && this.childStatus) await this.childStatusJoin;
    if (this.pumps.some((p) => !p.outcome)) {
      await this.until(
        Promise.all(this.pumps.map((p) => p.joined)),
        Math.min(deadline, performance.now() + 1_500),
      );
      if (this.pumps.some((p) => !p.outcome)) {
        this.fail('log drain incomplete');
        this.drainAbort.abort(new Error('bounded log drain cancellation'));
      }
    }
    // Keep joining actual outcomes after cancellation. A timeout does not mark
    // anything settled, and neither a first rejection nor a timer abandons work.
    const protectedWork = () =>
      this.operations.filter((p) =>
        !['owner', 'lease', 'finalizer', 'publication'].includes(p.kind)
      );
    await this.until(
      Promise.all(protectedWork().map((p) => p.joined)),
      deadline,
    );
    if (protectedWork().some((p) => !p.outcome)) {
      this.fail('unresolved protected operations');
      // Independent containment stays armed through the hard boundary. Never
      // transition to joined/publishing while an actual operation is unresolved.
      await Promise.all(protectedWork().map((p) => p.joined));
    }
    for (const resource of this.resources) await this.closeResource(resource);
    if (this.lease) {
      this.leaseReceipt = await this.operation(
        'stdin lease cancellation/join',
        () => this.lease!.join(),
        'finalizer',
      );
    }
    const finalizers = this.operations.filter((p) =>
      p.kind === 'finalizer' && p.name !== 'closing owner' && !p.outcome
    );
    if (finalizers.length) await Promise.all(finalizers.map((p) => p.joined));
    if (
      this.child && (!this.childStatus?.success || this.childStatus.code !== 0)
    ) {
      this.fail(
        `child not clean exit0: ${this.childStatus?.code ?? 'unreaped'}`,
      );
    }
    this.cancelTimer(this.cleanupTimer);
    this.joinedAt = performance.now();
    this.transition('joined');
  }
  summary(): RunSummary {
    const unresolved = this.operations.filter((p) =>
      !p.outcome && !['closing owner', 'run lifetime'].includes(p.name)
    ).map((p) => p.name);
    const logsComplete = this.pumps.every((p) => p.outcome?.ok === true);
    const workJoined = this.work?.outcome !== undefined;
    const resourcesClosed = this.resources.every((r) => r.closed);
    const evidenceOutcome = (
      outcome?: Outcome<unknown>,
    ): Outcome<unknown> | undefined => {
      if (!outcome) return undefined;
      if (!outcome.ok) return { ok: false, error: outcome.error };
      const value = outcome.value;
      // Outcome telemetry must never expose a child/file/stream handle or a
      // mutable reference into the owner's registry. Consumer receipts own data.
      return {
        ok: true,
        value: value === null ||
            ['string', 'number', 'boolean', 'undefined'].includes(typeof value)
          ? value
          : 'completed',
      };
    };
    return {
      stage: this.stage,
      success: this.failure === undefined && !!this.joinedAt && logsComplete &&
        workJoined && resourcesClosed &&
        (!this.child || this.childStatus?.success === true) &&
        unresolved.length === 0,
      failure: this.failure,
      diagnostics: [...this.diagnostics],
      started: this.started,
      closing: this.closingAt,
      joined: this.joinedAt,
      terminal: this.terminalAt,
      activeDeadline: this.activeDeadline,
      cleanupDeadline: this.cleanupDeadline,
      hardDeadline: this.hardDeadline,
      childIdentity: this.childSaved && structuredClone(this.childSaved),
      childStatus: this.childStatus && { ...this.childStatus },
      childReaped: !this.child || !!this.childStatus,
      forcedTermination: this.forced,
      logsComplete,
      workJoined,
      resourcesClosed,
      lease: this.leaseReceipt === undefined
        ? undefined
        : structuredClone(this.leaseReceipt),
      signals: structuredClone(this.signals),
      operations: this.operations.map((
        { name, kind, started, settled, outcome },
      ) => ({
        name,
        kind,
        started,
        settled,
        outcome: evidenceOutcome(outcome),
      })),
      unresolved,
      resources: this.resources.map(({ name, closed, outcome }) => ({
        name,
        closed,
        outcome: outcome && { ...outcome },
      })),
    };
  }
  run(
    work: (owner: OwnedRun) => Promise<void>,
    publish: (owner: OwnedRun, summary: RunSummary) => Promise<void>,
  ) {
    const promise = this.runInner(work, publish);
    this.track('run lifetime', 'owner', promise);
    return promise;
  }
  private async runInner(
    work: (owner: OwnedRun) => Promise<void>,
    publish: (owner: OwnedRun, summary: RunSummary) => Promise<void>,
  ) {
    const promise = Promise.resolve().then(() => work(this));
    this.work = this.track('work callback', 'work', promise);
    await this.work.joined;
    this.startClose();
    await this.closeJoin;
    requireFact(this.stage === 'joined', 'owner did not finish joined cleanup');
    const joinedSummary = this.summary();
    this.transition('publishing');
    const publicationDeadline = Math.min(
      performance.now() + this.budgets.publication,
      this.hardDeadline,
    );
    const timer = this.timer(publicationDeadline, () => {
      this.fail('publication deadline exceeded');
      this.publicationAbort.abort(new Error('publication deadline'));
    });
    const publishing = Promise.resolve().then(() =>
      publish(this, joinedSummary)
    );
    const published = this.track(
      'publication callback',
      'publication',
      publishing,
    );
    await published.joined;
    await Promise.all(
      this.operations.filter((p) => p.kind === 'publication').map((p) =>
        p.joined
      ),
    );
    this.cancelTimer(timer);
    this.terminalAt = performance.now();
    this.transition('terminal');
    for (const handle of this.timers.values()) clearTimeout(handle);
    this.timers.clear();
    for (const [signal, handler] of this.signalHandlers) {
      Deno.removeSignalListener(signal, handler);
    }
    this.signalHandlers.clear();
    return this.summary();
  }
}
