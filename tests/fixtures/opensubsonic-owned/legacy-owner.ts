// Test-only mechanical adapter of H2 cold-http.ts, SHA256
// 2865763f437521efd68c60b07d67ec1c5da8dab374c9eb37b6ded717ffbd031f.
// Anchors: identity 79–92, lifetime 94–187/779–806/1045–1082, request
// 199–239, scan wrappers 367–392. Substitutions: class fields replace CLI
// globals; fixed fixture launch/sinks replace main.ts/files; callback work and
// publisher replace the assertion body/result writer. Fixture-only server
// finalizers are external inputs, not claims about legacy product ownership.
// Decision-07 restores the archived response write to legacy-requests.ndjson.
// Unlike H2 cold-http.ts 224–237, it records performance.now() instead of an ISO
// timestamp, omits method and does not redact URL credentials. Fixture URLs have
// no credentials (baseline-scan-late-red02: http://127.0.0.1:<port>/fixture).
// The missing phase check and uncancelled receipt write are preserved on purpose.
// Preserve discarded pumps, stale boot/partial KILL checks, timer races and
// unpropagated scan deadline. Never imported by production/corrected owner.
import type { Launch, RunSummary } from '../../../dev/helpers/owned-run.ts';

export class LegacyOwner {
  readonly started = performance.now();
  readonly activeDeadline = this.started + 270_000;
  readonly hardDeadline = this.started + 300_000;
  private abort = new AbortController();
  private failure: unknown;
  private child?: Deno.ChildProcess;
  private childIdentity?: Awaited<ReturnType<LegacyOwner['identity']>>;
  private childStatus?: Deno.CommandStatus;
  private cleanup?: Promise<void>;
  private pumps: Promise<void>[] = [];
  private fixtureResources: (() => void | Promise<void>)[] = [];
  private boot = '';
  constructor(private evidence: string) {}
  get workSignal() {
    return this.abort.signal;
  }
  get cleanupDeadline() {
    return this.started + 280_000;
  }
  fail(error: unknown) {
    this.failure ??= error;
    this.abort.abort(error);
  }
  private check(value: unknown, message: string): asserts value {
    if (!value) throw new Error(`legacy mechanism: ${message}`);
  }
  private async identity(pid: number) {
    const raw = await Deno.readTextFile(`/proc/${pid}/stat`);
    return {
      pid,
      boot: this.boot,
      startTicks: raw.slice(raw.lastIndexOf(')') + 2).split(' ')[19],
      argv: (await Deno.readTextFile(`/proc/${pid}/cmdline`)).split('\0')
        .filter(Boolean),
      cgroup: await Deno.readTextFile(`/proc/${pid}/cgroup`),
    };
  }
  private bounded<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    return Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('owned operation deadline exceeded')),
          milliseconds,
        );
      }),
    ]).finally(() => clearTimeout(timer));
  }
  async operation<T>(
    _name: string,
    start: () => Promise<T>,
    _kind?: string,
    _fatal?: boolean,
  ) {
    return await start();
  }
  resource(_name: string, close: () => void | Promise<void>) {
    this.fixtureResources.push(close);
  }
  assertWork(_deadline = this.activeDeadline) {
    this.check(
      performance.now() - this.started < 270_000,
      'active work deadline',
    );
    this.abort.signal.throwIfAborted();
  }
  sleep(ms: number, _deadline?: number, _kind?: string) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
  }
  async launch(input: Launch) {
    const sink = async (value: Launch['stdout']) =>
      typeof value === 'string'
        ? (await Deno.open(value, { createNew: true, write: true })).writable
        : value;
    const stdout = await sink(input.stdout);
    const stderr = await sink(input.stderr);
    this.child = new Deno.Command(input.executable, {
      args: input.args,
      cwd: input.cwd,
      clearEnv: true,
      env: input.env,
      stdin: 'null',
      stdout: 'piped',
      stderr: 'piped',
    }).spawn();
    void this.child.status.then((status) => {
      this.childStatus = status;
      if (!this.cleanup) {
        this.fail(
          new Error(`child exited before owned shutdown: ${status.code}`),
        );
      }
    });
    this.pumps.push(
      this.child.stdout.pipeTo(stdout),
      this.child.stderr.pipeTo(stderr),
    );
    this.childIdentity = await this.identity(this.child.pid);
    return this.childIdentity;
  }
  private async stopOwnedChild() {
    if (this.cleanup) return await this.cleanup;
    this.cleanup = (async () => {
      if (!this.child) return;
      const owned = this.child;
      if (!this.childStatus) {
        const current = await this.identity(owned.pid).catch(() => undefined);
        if (current) {
          this.check(
            this.childIdentity &&
              current.startTicks === this.childIdentity.startTicks &&
              current.boot === this.childIdentity.boot &&
              JSON.stringify(current.argv) ===
                JSON.stringify(this.childIdentity.argv) &&
              current.cgroup === this.childIdentity.cgroup,
            'child ownership changed',
          );
          owned.kill('SIGTERM');
        }
        try {
          this.childStatus = await this.bounded(owned.status, 5_000);
        } catch (error) {
          const current = await this.identity(owned.pid);
          this.check(
            current.startTicks === this.childIdentity?.startTicks,
            'cleanup identity changed',
          );
          owned.kill('SIGKILL');
          this.childStatus = await this.bounded(owned.status, 3_000);
          this.fail(error);
        }
      }
      await this.bounded(Promise.all(this.pumps), 1_500);
      this.check(
        this.childStatus.success && this.childStatus.code === 0,
        `child exit ${this.childStatus.code}`,
      );
    })();
    return await this.cleanup;
  }
  async request(
    url: string | URL,
    init: RequestInit = {},
    _options: { phaseDeadline?: number } = {},
  ) {
    this.assertWork();
    const response = await fetch(url, {
      ...init,
      signal: AbortSignal.any([
        this.abort.signal,
        AbortSignal.timeout(Math.max(1, Math.ceil(Math.min(10_000, 10_000)))),
      ]),
    });
    const body = await response.text();
    // Restore the archived response write; retain its missing phase check and
    // uncancelled receipt completion, rather than improve the red mechanism.
    await Deno.writeTextFile(
      `${this.evidence}/legacy-requests.ndjson`,
      JSON.stringify({
        at: performance.now(),
        url: String(url),
        status: response.status,
        contentType: response.headers.get('content-type'),
        body,
      }) + '\n',
      { append: true },
    );
    return {
      url: String(url),
      status: response.status,
      contentType: response.headers.get('content-type'),
      body,
    };
  }
  async poll<T>(
    deadline: number,
    read: (deadline: number) => Promise<T>,
    accepts: (value: T) => boolean,
  ) {
    let last: T | undefined;
    let complete = false;
    while (performance.now() < deadline && !complete) {
      // H2's wrappers discarded deadline; pass a fresh global request allowance.
      last = await read(this.activeDeadline);
      complete = accepts(last);
      if (!complete) await this.sleep(100);
    }
    this.check(complete, 'scan completion');
    return last!;
  }
  async run(
    work: (run: LegacyOwner) => Promise<void>,
    publish: (run: LegacyOwner, summary: RunSummary) => Promise<void>,
  ) {
    this.boot = (await Deno.readTextFile('/proc/sys/kernel/random/boot_id'))
      .trim();
    const onSignal = () => this.fail(new Error('driver interrupted'));
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      Deno.addSignalListener(signal, onSignal);
    }
    const activeTimer = setTimeout(
      () => this.fail(new Error('270s active-work deadline exceeded')),
      270_000,
    );
    const cleanupTimer = setTimeout(() => {
      this.fail(new Error('280s shutdown deadline'));
      void this.stopOwnedChild().catch((error) => this.fail(error));
    }, 280_000);
    const hardTimer = setTimeout(() => {
      Deno.writeTextFileSync(
        `${this.evidence}/legacy-hard-timeout.json`,
        JSON.stringify({
          incomplete: true,
          childPid: this.child?.pid,
          boot: this.boot,
        }),
      );
      Deno.exit(1);
    }, 300_000);
    let joined = false;
    try {
      await work(this);
    } catch (error) {
      this.fail(error);
    } finally {
      clearTimeout(activeTimer);
      try {
        await this.bounded(this.stopOwnedChild(), 10_000);
        joined = true;
      } catch (error) {
        this.fail(error);
      }
      // Only disposable HTTP-server fixture resources are added by the adapter.
      // Delayed sink close remains inside the original raced pump mechanism.
      for (const close of this.fixtureResources) await close();
      try {
        await this.bounded(publish(this, this.summary(joined)), 20_000);
      } catch (error) {
        this.fail(error);
      }
      clearTimeout(cleanupTimer);
      clearTimeout(hardTimer);
      for (const signal of ['SIGTERM', 'SIGINT'] as const) {
        Deno.removeSignalListener(signal, onSignal);
      }
    }
    return this.summary(joined);
  }
  private summary(joined: boolean): RunSummary {
    return {
      stage: 'terminal',
      success: this.failure === undefined,
      failure: this.failure === undefined ? undefined : String(this.failure),
      diagnostics: [],
      started: this.started,
      joined: joined ? performance.now() : undefined,
      activeDeadline: this.activeDeadline,
      hardDeadline: this.hardDeadline,
      childStatus: this.childStatus,
      childReaped: !!this.childStatus,
      forcedTermination: false,
      logsComplete: joined,
      workJoined: true,
      resourcesClosed: joined,
      signals: [],
      operations: [],
      unresolved: joined ? [] : ['legacy cleanup race'],
      resources: [],
    };
  }
}
