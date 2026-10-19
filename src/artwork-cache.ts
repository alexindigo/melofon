// Disposable derived bytes. Filenames are hashes; mtime records LRU across restarts.
// Serialize disk bookkeeping so concurrent writers cannot exceed the byte budget.
export function createArtworkCache(directory?: string) {
  let clock = 0;
  let tail: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn);
    tail = run.catch(() => {});
    return run;
  };
  async function prune(limit: number) {
    const entries = [];
    for await (const entry of Deno.readDir(directory!)) {
      if (
        !entry.isFile || !/^[a-f0-9]{64}\.(png|jpeg|webp)$/.test(entry.name)
      ) continue;
      const path = `${directory}/${entry.name}`;
      const stat = await Deno.stat(path);
      entries.push({ path, size: stat.size, at: stat.mtime?.getTime() ?? 0 });
      clock = Math.max(clock, stat.mtime?.getTime() ?? 0);
    }
    entries.sort((a, b) => a.at - b.at || a.path.localeCompare(b.path));
    let total = entries.reduce((n, entry) => n + entry.size, 0);
    for (const entry of entries) {
      if (total <= limit) break;
      await Deno.remove(entry.path);
      total -= entry.size;
    }
  }
  async function touch(path: string) {
    const now = new Date(clock = Math.max(Date.now(), clock + 1));
    await Deno.utime(path, now, now);
  }
  return {
    get(key: string, limit: number): Promise<Uint8Array | null> {
      return exclusive(async () => {
        if (!directory) return null;
        try {
          await prune(limit);
          const path = `${directory}/${key}`;
          const bytes = await Deno.readFile(path);
          await touch(path);
          return bytes;
        } catch {
          return null;
        } // Deletion/unwritable cache never affects correctness.
      });
    },
    put(key: string, bytes: Uint8Array, limit: number): Promise<void> {
      return exclusive(async () => {
        if (!directory) return;
        const temporary = `${directory}/.write-${crypto.randomUUID()}`;
        try {
          await Deno.mkdir(directory, { recursive: true });
          await prune(limit);
          if (bytes.length <= limit) {
            await Deno.writeFile(temporary, bytes, {
              createNew: true,
              mode: 0o600,
            });
            await Deno.rename(temporary, `${directory}/${key}`);
            await touch(`${directory}/${key}`);
          }
          await prune(limit);
        } catch {
          /* Cache is optional and disposable. */
        } finally {
          try {
            await Deno.remove(temporary);
          } catch { /* Already published. */ }
        }
      });
    },
  };
}
