import { assertEquals } from '@std/assert';

/** Observe the real scheduler without adding a heartbeat test seam to core. */
export function observeHeartbeat() {
  const interval = globalThis.setInterval;
  const clear = globalThis.clearInterval;
  const unref = Deno.unrefTimer;
  type Timer = number | ReturnType<typeof setInterval>;
  const timers = new Map<
    Timer,
    { ms: number; ticks: number; unref: boolean }
  >();
  const active = new Set<Timer>();
  globalThis.setInterval = ((
    callback: (...args: unknown[]) => void,
    ms: number,
    ...args: unknown[]
  ) => {
    const id = interval(() => {
      timers.get(id)!.ticks++;
      callback(...args);
    }, ms);
    timers.set(id, { ms: ms!, ticks: 0, unref: false });
    active.add(id);
    return id;
  }) as typeof globalThis.setInterval;
  globalThis.clearInterval = (id) => {
    if (id !== undefined && typeof id !== 'string') active.delete(id);
    clear(id);
  };
  Deno.unrefTimer = (id) => {
    const timer = timers.get(id);
    if (timer) timer.unref = true;
    unref(id);
  };
  return {
    timers,
    active,
    assertActive() {
      assertEquals(active.size, 1);
      assertEquals(timers.get([...active][0])?.ms, 50);
      assertEquals(timers.get([...active][0])?.unref, true);
    },
    [Symbol.dispose]() {
      globalThis.setInterval = interval;
      globalThis.clearInterval = clear;
      Deno.unrefTimer = unref;
      for (const id of active) clear(id);
    },
  };
}
