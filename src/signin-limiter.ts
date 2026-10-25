import type { State } from './state.ts';

export function createSignInLimiter(
  state: State,
  now: () => number = Date.now,
) {
  state.declare('auth.signInFailures', {
    type: 'integer',
    minimum: 1,
    default: 10,
  });
  state.declare('auth.signInWaitSeconds', {
    type: 'integer',
    minimum: 1,
    default: 60,
  });
  state.declare('auth.signInWaitMaxSeconds', {
    type: 'integer',
    minimum: 1,
    default: 3600,
  });
  type Entry = {
    failures: number;
    wait: number;
    until: number;
    lastFailure: number;
    windowSeconds: number;
  };
  const entries = new Map<string, Entry>();
  let nextSweep = -Infinity;
  const keyOf = (username: string, address: string) =>
    JSON.stringify([username.toLowerCase(), address]);
  function expired(entry: Entry, time: number) {
    // Keep history for one idle window after the last failure or lockout end,
    // whichever is later. The window records the current wait (initial before
    // the first lockout), so attempts just after a lockout retain their backoff.
    return entry.until <= time &&
      Math.max(entry.lastFailure, entry.until) + entry.windowSeconds * 1000 <=
        time;
  }
  function sweep(time: number) {
    if (time < nextSweep) return;
    // Lazy housekeeping at most once a second, independent of attempt volume.
    nextSweep = time + 1000;
    for (const [key, entry] of entries) {
      if (expired(entry, time)) entries.delete(key);
    }
  }
  function getEntry(key: string, time: number) {
    sweep(time);
    const entry = entries.get(key);
    if (entry && expired(entry, time)) {
      entries.delete(key);
      return undefined;
    }
    return entry;
  }
  return {
    remaining(username: string, address: string) {
      const time = now();
      return Math.max(
        0,
        Math.ceil(
          ((getEntry(keyOf(username, address), time)?.until ?? 0) - time) /
            1000,
        ),
      );
    },
    async failure(username: string, address: string) {
      const limit = Number(await state.getTyped('auth.signInFailures'));
      const initial = Number(await state.getTyped('auth.signInWaitSeconds'));
      const max = Number(await state.getTyped('auth.signInWaitMaxSeconds'));
      const time = now();
      const key = keyOf(username, address);
      const entry = getEntry(key, time) ?? {
        failures: 0,
        wait: 0,
        until: 0,
        lastFailure: time,
        windowSeconds: initial,
      };
      if (entry.until > time) return;
      entry.lastFailure = time;
      entry.failures++;
      if (entry.failures >= limit) {
        entry.failures = 0;
        entry.wait = Math.min(max, entry.wait ? entry.wait * 2 : initial);
        entry.until = time + entry.wait * 1000;
      }
      entry.windowSeconds = entry.wait || initial;
      entries.set(key, entry);
    },
    success(username: string, address: string) {
      entries.delete(keyOf(username, address));
    },
  };
}
