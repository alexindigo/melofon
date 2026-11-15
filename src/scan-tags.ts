import type { IAudioMetadata } from 'music-metadata';
import type { State } from './state.ts';
import {
  createWorkerIntake,
  createWorkerSession,
  type WorkerSession,
} from './worker-host.ts';

export interface TagReader extends Disposable {
  read(path: string, signal?: AbortSignal): Promise<IAudioMetadata>;
}

export function declareTagSettings(state: State): void {
  state.declare('scan.tagParseTimeoutSeconds', {
    type: 'number',
    default: 30,
    minimum: 0.001,
    maximum: 3600,
  });
  state.declare('scan.tagWorkerStartupSeconds', {
    type: 'number',
    default: 120,
    minimum: 0.001,
    maximum: 3600,
  });
  state.declare('scan.tagParseMaxBytes', {
    type: 'integer',
    default: 20 * 1024 * 1024,
    minimum: 1,
  });
}

// One sequential worker per scan amortizes startup; an over-budget parser is
// terminated, and the next file receives a new worker. The parse timer starts only
// once the worker reports it is loaded (its own startup bound applies before that).
// Nothing runs in the DB slot.
export function createTagReader(
  state: State,
  workerUrl = new URL('./scan-tags-worker.ts', import.meta.url),
): TagReader & { close(): Promise<void> } {
  declareTagSettings(state);
  const intake = createWorkerIntake('Tag worker');
  let session: WorkerSession | undefined;
  const start = (startupSeconds: number) => {
    const current = createWorkerSession(
      new Worker(workerUrl, { type: 'module' }),
      {
        startup: {
          milliseconds: startupSeconds * 1000,
          error: new Error(
            `Tag worker did not start within ${startupSeconds} seconds`,
          ),
        },
        invalidMessage: 'Invalid tag Worker message',
        onMessage(data, slot) {
          if (data?.call !== undefined && data.call !== slot.call?.id) return;
          if (data?.ready) return slot.markReady();
          if (!slot.call || data?.call !== slot.call.id) return;
          if (data?.error) return slot.retire(new Error(data.error));
          slot.call?.resolve(data?.metadata);
        },
      },
    );
    session = current;
    return current;
  };
  const close = () => {
    const closing = intake.close();
    session?.retire(new Error('Tag worker closed'));
    return closing;
  };
  return {
    read(path, outer) {
      return intake.run(async ({ signal: owned }) => {
        const signal = outer ? AbortSignal.any([owned, outer]) : owned;
        let current: WorkerSession | undefined;
        const abort = () => current?.retire(new Error('Tag worker closed'));
        signal.addEventListener('abort', abort, { once: true });
        try {
          if (signal.aborted) throw new Error('Tag worker closed');
          const seconds = await state.getTyped(
            'scan.tagParseTimeoutSeconds',
          ) as number;
          const maxBytes = await state.getTyped(
            'scan.tagParseMaxBytes',
          ) as number;
          const startupSeconds = await state.getTyped(
            'scan.tagWorkerStartupSeconds',
          ) as number;
          if (signal.aborted) throw new Error('Tag worker closed');
          current = session && !session.retired
            ? session
            : start(startupSeconds);
          await current.ready;
          if (signal.aborted) throw new Error('Tag worker closed');
          return await current.request<IAudioMetadata>(
            (call) =>
              current!.worker.postMessage({ path, maxBytes, call: call.id }),
            {
              milliseconds: seconds * 1000,
              error: new Error(`Tag parse exceeded ${seconds} seconds`),
            },
          );
        } catch (error) {
          current?.retire(new Error(String(error)));
          throw error;
        } finally {
          signal.removeEventListener('abort', abort);
        }
      });
    },
    close,
    [Symbol.dispose]() {
      void close();
    },
  };
}
