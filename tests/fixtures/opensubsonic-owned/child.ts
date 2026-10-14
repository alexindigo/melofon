// Disposable containment fixture. Never starts an application or opens a DB.
import {
  observe,
  processIdentity,
  requireFact,
  save,
} from '../../../dev/helpers/transient-watchdog.ts';

if (import.meta.main) {
  const evidence = Deno.args[0];
  const mode = Deno.args[1] ?? 'qualification';
  requireFact(
    ['qualification', 'pulse', 'ignore', 'retained', 'holder'].includes(mode),
    'fixed child mode',
  );
  const timer = setInterval(() => {
    if (mode === 'pulse' || mode === 'ignore') {
      console.log('fixture stdout pulse');
      console.error('fixture stderr pulse');
    }
  }, mode === 'qualification' || mode === 'holder' ? 1_000 : 50);
  const stop = () => {
    if (mode === 'ignore') {
      console.log('TERM-IGNORED');
      return;
    }
    clearInterval(timer);
  };
  Deno.addSignalListener('SIGTERM', stop);
  Deno.addSignalListener('SIGINT', stop);
  if (mode === 'retained') {
    const holder = new Deno.Command(Deno.execPath(), {
      args: [
        'run',
        `--config=${Deno.cwd()}/deno.json`,
        '--frozen',
        '--cached-only',
        '--node-modules-dir=manual',
        '--allow-all',
        `${Deno.cwd()}/tests/fixtures/opensubsonic-owned/child.ts`,
        evidence,
        'holder',
      ],
      cwd: Deno.cwd(),
      clearEnv: true,
      env: {
        HOME: '/home/tester',
        PATH: '/home/tester/.deno/bin:/usr/bin:/bin',
        TMPDIR: Deno.env.get('TMPDIR')!,
        DENO_DIR: Deno.env.get('DENO_DIR')!,
      },
      stdin: 'null',
      stdout: 'inherit',
      stderr: 'inherit',
    }).spawn();
    // Deliberate fixture descendant, independently audited by the observer.
    // Only retained-pipe mode creates it; it holds both descriptors after exit0.
    const holderStatus = observe(holder.status);
    holder.unref();
    await save(`${evidence}/pipe-holder-launch.json`, { pid: holder.pid });
    while (true) {
      try {
        await Deno.stat(`${evidence}/pipe-holder-ready.json`);
        break;
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
        await new Promise((r) => setTimeout(r, 10));
      }
    }
    void holderStatus; // retained outcome; manager, not this exit0 fixture, reaps it
  }
  if (mode !== 'qualification') {
    await save(
      `${evidence}/${
        mode === 'holder' ? 'pipe-holder-mode' : 'child-mode'
      }.json`,
      { mode, ready: true },
    );
  }
  await save(
    `${evidence}/${
      mode === 'holder' ? 'pipe-holder-ready' : 'child-ready'
    }.json`,
    await processIdentity(Deno.pid),
  );
}
