import type { ShareContext } from './types.ts';

// Core owns live per-share admission; the hat retains only the response lease.
export function admit(context: ShareContext, id: string) {
  return context.app.shares.admitStream(id);
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
