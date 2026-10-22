import type { ShareContext } from './types.ts';

// Admission belongs to this public protocol, not to every core stream consumer.
const owners = new WeakMap<
  ShareContext['app']['shares'],
  Map<string, number>
>();
export async function admit(context: ShareContext, id: string) {
  const limit = Number(
    await context.app.state.getTyped('sharing.maxConcurrentStreams'),
  );
  let counts = owners.get(context.app.shares);
  if (!counts) owners.set(context.app.shares, counts = new Map());
  const count = counts.get(id) ?? 0;
  if (count >= limit) return null;
  counts.set(id, count + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (counts.get(id) ?? 1) - 1;
    if (remaining) counts.set(id, remaining);
    else counts.delete(id);
  };
}

/** Retain admission until the consumer finishes, cancels or disconnects. */
export function leased(
  response: Response,
  signal: AbortSignal,
  release: () => void,
) {
  if (!response.body) {
    release();
    return response;
  }
  const reader = response.body.getReader();
  const finish = () => {
    signal.removeEventListener('abort', abort);
    release();
  };
  const abort = () => {
    finish();
    void reader.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          finish();
          controller.close();
        } else controller.enqueue(next.value);
      } catch (err) {
        finish();
        controller.error(err);
      }
    },
    async cancel(reason) {
      finish();
      await reader.cancel(reason);
    },
  }, { highWaterMark: 0 });
  return new Response(body, {
    status: response.status,
    headers: response.headers,
  });
}
