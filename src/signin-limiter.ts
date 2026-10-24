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
    { failures: number; wait: number; until: number }
  >();
  const keyOf = (username: string, address: string) =>
    JSON.stringify([username.toLowerCase(), address]);
  return {
    remaining(username: string, address: string) {
      return Math.max(
        0,
        Math.ceil(
          ((entries.get(keyOf(username, address))?.until ?? 0) - now()) / 1000,
        ),
      );
    },
    async failure(username: string, address: string) {
      const limit = Number(await state.getTyped('auth.signInFailures'));
      const initial = Number(await state.getTyped('auth.signInWaitSeconds'));
      const max = Number(await state.getTyped('auth.signInWaitMaxSeconds'));
      const key = keyOf(username, address);
      const entry = entries.get(key) ?? { failures: 0, wait: 0, until: 0 };
      if (entry.until > now()) return;
      entry.failures++;
      if (entry.failures >= limit) {
        entry.failures = 0;
        entry.wait = Math.min(max, entry.wait ? entry.wait * 2 : initial);
        entry.until = now() + entry.wait * 1000;
      }
      entries.set(key, entry);
    },
    success(username: string, address: string) {
      entries.delete(keyOf(username, address));
    },
  };
}
