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
  const entries = new Map<
    string,
    {
      failures: number;
      wait: number;
      until: number;
      lastFailure: number;
      windowSeconds: number;
    }
  >();
  const keyOf = (username: string, address: string) =>
    JSON.stringify([username.toLowerCase(), address]);
  function sweep(time: number) {
    for (const [key, entry] of entries) {
      // Keep history for one idle window after the last failure or lockout end,
      // whichever is later. The window records the current wait (initial before
      // the first lockout), so attempts just after a lockout retain their backoff.
      if (
        entry.until <= time &&
        Math.max(entry.lastFailure, entry.until) + entry.windowSeconds * 1000 <=
          time
      ) entries.delete(key);
    }
  }
  return {
    remaining(username: string, address: string) {
      const time = now();
      sweep(time);
      return Math.max(
        0,
        Math.ceil(
          ((entries.get(keyOf(username, address))?.until ?? 0) - time) / 1000,
        ),
      );
    },
    async failure(username: string, address: string) {
      const limit = Number(await state.getTyped('auth.signInFailures'));
      const initial = Number(await state.getTyped('auth.signInWaitSeconds'));
      const max = Number(await state.getTyped('auth.signInWaitMaxSeconds'));
      const time = now();
      sweep(time);
      const key = keyOf(username, address);
      const entry = entries.get(key) ?? {
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
