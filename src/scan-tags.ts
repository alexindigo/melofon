import type { IAudioMetadata } from 'music-metadata';
import type { State } from './state.ts';

export interface TagReader extends Disposable {
  read(path: string): Promise<IAudioMetadata>;
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
): TagReader {
  declareTagSettings(state);
  let worker: Worker | undefined;
  let ready: Promise<void> | undefined;
  const stop = () => {
    worker?.terminate();
    worker = undefined;
    ready = undefined;
  };
  const start = (startupSeconds: number) => {
    const created = new Worker(workerUrl, { type: 'module' });
    worker = created;
    ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        created.onmessage = null;
        created.onerror = null;
        reject(
          new Error(
            `Tag worker did not start within ${startupSeconds} seconds`,
          ),
        );
      }, startupSeconds * 1000);
      created.onmessage = (event: MessageEvent<{ ready?: boolean }>) => {
        if (!event.data?.ready) return;
        clearTimeout(timer);
        created.onmessage = null;
        created.onerror = null;
        resolve();
      };
      created.onerror = (event) => {
        event.preventDefault();
        clearTimeout(timer);
        created.onmessage = null;
        created.onerror = null;
        reject(new Error(event.message));
      };
    });
    return ready;
  };
  return {
    async read(path) {
      const seconds = await state.getTyped(
        'scan.tagParseTimeoutSeconds',
      ) as number;
      const maxBytes = await state.getTyped('scan.tagParseMaxBytes') as number;
      const startupSeconds = await state.getTyped(
        'scan.tagWorkerStartupSeconds',
      ) as number;
      try {
        await (ready ?? start(startupSeconds));
      } catch (error) {
        stop();
        throw error;
      }
      const current = worker!;
      return await new Promise<IAudioMetadata>((resolve, reject) => {
        const finish = (error?: Error, metadata?: IAudioMetadata) => {
          clearTimeout(timer);
          current.onmessage = null;
          current.onerror = null;
          if (error) {
            stop();
            reject(error);
          } else resolve(metadata!);
        };
        const timer = setTimeout(
          () => finish(new Error(`Tag parse exceeded ${seconds} seconds`)),
          seconds * 1000,
        );
        current.onmessage = (
          event: MessageEvent<
            { ready?: boolean; error?: string; metadata?: IAudioMetadata }
          >,
        ) => {
          if (event.data.ready) return;
          if (event.data.error) finish(new Error(event.data.error));
          else finish(undefined, event.data.metadata);
        };
        current.onerror = (event) => {
          event.preventDefault();
          finish(new Error(event.message));
        };
        current.postMessage({ path, maxBytes });
      });
    },
    [Symbol.dispose]: stop,
  };
}
