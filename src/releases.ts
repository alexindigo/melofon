/** Owned releases, not cancellation or proof of native destruction. Owners
 * choose ordering and whether to explicitly retry a failed release. */
export function createReleaseSet() {
  type Entry = {
    name: string;
    phase: number;
    run: () => void | Promise<void>;
    work?: Promise<void>;
  };
  const entries = new Map<string, Entry>();
  const release = (entry: Entry) => {
    if (!entry.work) {
      entry.work = Promise.resolve().then(entry.run).then(() => {
        entries.delete(entry.name);
      }).finally(() => {
        entry.work = undefined;
      });
    }
    return entry.work;
  };
  return {
    add(name: string, run: () => void | Promise<void>, phase = 0) {
      if (entries.has(name)) throw new Error(`Release already owned: ${name}`);
      entries.set(name, { name, run, phase });
    },
    pending: () => [...entries.keys()],
    /** Lower phases release first; independent siblings all settle. Successful
     * records disappear, failed ones remain owned with their original action. */
    async release(names: Iterable<string> = entries.keys()) {
      const selected = [...new Set(names)].flatMap((name) => {
        const entry = entries.get(name);
        return entry ? [entry] : [];
      });
      const released: string[] = [];
      const failed: { name: string; error: unknown }[] = [];
      const phases = [...new Set(selected.map((entry) => entry.phase))].sort((
        a,
        b,
      ) => a - b);
      for (const phase of phases) {
        await Promise.all(
          selected.filter((entry) => entry.phase === phase).map(
            async (entry) => {
              // Another concurrent release may already have succeeded.
              if (entries.get(entry.name) !== entry) return;
              try {
                await release(entry);
                released.push(entry.name);
              } catch (error) {
                failed.push({ name: entry.name, error });
              }
            },
          ),
        );
      }
      return { released, failed };
    },
  };
}

export type ReleaseSet = ReturnType<typeof createReleaseSet>;

/** Preserve acquisition failure as well as every named cleanup failure. */
export async function releaseOrThrow(
  releases: ReleaseSet,
  message: string,
  failure?: { error: unknown },
  names?: Iterable<string>,
) {
  const report = await releases.release(names);
  if (report.failed.length) {
    throw new AggregateError([
      ...(failure ? [failure.error] : []),
      ...report.failed.map(({ name, error }) =>
        new Error(`Release failed: ${name}`, { cause: error })
      ),
    ], message);
  }
  if (failure) throw failure.error;
  return report;
}
