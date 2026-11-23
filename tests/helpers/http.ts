import { assert, assertEquals } from '@std/assert';
import { setTimeout as delay } from 'node:timers/promises';

/** Functional HTTP tests wait for responses/state, not a latency SLA. Never
 * replay a request: a timed-out mutation may already have committed. The outer
 * bound is only a hang guard and must also cancel readiness checks in flight.
 */
export function createTestHttp(
  origin: string,
  options: { client?: Deno.HttpClient; safetyMs?: number } = {},
) {
  const safetyMs = options.safetyMs ?? 120_000;
  const request = async (path: string, init: RequestInit = {}) => {
    const url = new URL(path, origin);
    const bound = AbortSignal.timeout(safetyMs);
    const signal = init.signal ? AbortSignal.any([init.signal, bound]) : bound;
    try {
      return await fetch(url, {
        ...init,
        signal,
        ...(options.client ? { client: options.client } : {}),
      });
    } catch (cause) {
      // No query strings, headers or bodies: these can contain credentials.
      throw new Error(
        `${init.method ?? 'GET'} ${url.pathname}: ${
          bound.aborted
            ? `HTTP response did not arrive within ${safetyMs}ms hang bound`
            : 'HTTP request failed'
        }`,
        { cause },
      );
    }
  };
  const until = async (
    check: (signal: AbortSignal) => boolean | Promise<boolean>,
    description: string,
  ) => {
    const controller = new AbortController();
    const { signal } = controller;
    const timeout = new Error(
      `Timed out after ${safetyMs}ms waiting for ${description}`,
    );
    const timer = setTimeout(() => controller.abort(timeout), safetyMs);
    const aborted = Promise.withResolvers<never>();
    const abort = () => aborted.reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    const poll = async () => {
      while (true) {
        signal.throwIfAborted();
        const ready = await check(signal);
        signal.throwIfAborted();
        if (ready) return;
        await delay(50, undefined, { signal });
      }
    };
    try {
      await Promise.race([poll(), aborted.promise]);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    }
  };
  return {
    request,
    until,
    ready: () =>
      until(async (signal) => {
        let response: Response;
        try {
          response = await request('/_/health', { signal });
        } catch (error) {
          signal.throwIfAborted();
          // A cold child may not have opened its listener yet. Do not hide
          // HTTP errors, broken JSON or a failed readiness assertion.
          if (error instanceof Error && error.cause instanceof TypeError) {
            return false;
          }
          throw error;
        }
        if (response.status === 503) {
          await response.body?.cancel();
          return false;
        }
        if (response.status !== 200) await response.body?.cancel();
        assertEquals(response.status, 200, 'health probe');
        const body = await response.json();
        assert(typeof body.ok === 'boolean', 'invalid health response');
        return body.ok === true;
      }, 'GET /_/health to report ok=true'),
  };
}
