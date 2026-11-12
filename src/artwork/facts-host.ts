import type { State } from '../state.ts';
import type { ArtworkPreview } from '../store/artwork.ts';

/** One reusable sequential Worker. Both startup and computation are bounded;
 * retirement rejects the current call before terminating its Worker. */
export function createArtworkFactsHost(
  state: Pick<State, 'declare' | 'getTyped'>,
  workerUrl = new URL('./facts-worker.ts', import.meta.url),
  onComputing?: () => void,
) {
  for (
    const [key, value] of Object.entries({
      startupSeconds: 120,
      computeSeconds: 30,
    })
  ) {
    state.declare(`artwork.facts.${key}`, {
      type: 'number',
      minimum: 0.001,
      maximum: 3600,
      default: value,
    });
  }
  let worker: Worker | undefined;
  let ready: Promise<void> | undefined;
  let rejectPending: ((error: Error) => void) | undefined;
  let closed = false;
  function retire(error: Error) {
    const reject = rejectPending;
    rejectPending = undefined;
    worker?.terminate();
    worker = undefined;
    ready = undefined;
    reject?.(error);
  }
  function start(seconds: number) {
    const current = new Worker(
      new URL('./facts-bootstrap.ts', import.meta.url),
      {
        type: 'module',
      },
    );
    worker = current;
    // Failure ownership outlives each startup/computation message handler,
    // including asynchronous failures while the reusable Worker is idle.
    current.addEventListener('message', (event) => {
      if (event.data?.error) {
        event.stopImmediatePropagation();
        retire(new Error(event.data.error));
      }
    });
    ready = new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        rejectPending = undefined;
        current.onmessage = null;
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(
        () => retire(new Error('Artwork Worker startup timed out')),
        seconds * 1000,
      );
      rejectPending = finish;
      current.onerror = (event) => {
        event.preventDefault();
        retire(new Error(event.message));
      };
      current.onmessageerror = () =>
        retire(new Error('Invalid artwork Worker message'));
      current.onmessage = ({ data }) => {
        if (data?.ready === true) finish();
        else retire(new Error('Invalid artwork Worker startup'));
      };
      current.postMessage({ module: workerUrl.href });
    });
    return ready;
  }
  return {
    async compute(
      pixels: { width: number; height: number; rgba: Uint8Array },
    ): Promise<ArtworkPreview> {
      if (closed) throw new Error('Artwork Worker closed');
      const startup = Number(
        await state.getTyped('artwork.facts.startupSeconds'),
      );
      const seconds = Number(
        await state.getTyped('artwork.facts.computeSeconds'),
      );
      if (closed) throw new Error('Artwork Worker closed');
      try {
        await (ready ?? start(startup));
        if (closed || !worker) throw new Error('Artwork Worker closed');
        const current = worker;
        return await new Promise<ArtworkPreview>((resolve, reject) => {
          const finish = (error?: Error, value?: ArtworkPreview) => {
            clearTimeout(timer);
            current.onmessage = null;
            rejectPending = undefined;
            if (error) reject(error);
            else resolve(value!);
          };
          const timer = setTimeout(
            () => retire(new Error('Artwork computation timed out')),
            seconds * 1000,
          );
          rejectPending = finish;
          current.onmessage = ({ data }) => {
            if (data?.started === true) {
              onComputing?.();
              return;
            }
            const value = data?.value;
            if (
              typeof value?.thumbHash !== 'string' ||
              !/^[A-Za-z0-9+/]+={0,2}$/.test(value.thumbHash) ||
              !(value.dominantColor === null ||
                typeof value.dominantColor === 'string' &&
                  /^#[a-f0-9]{6}$/.test(value.dominantColor))
            ) {
              return retire(new Error('Invalid artwork Worker result'));
            }
            finish(undefined, value);
          };
          try {
            current.postMessage(pixels);
          } catch (error) {
            retire(new Error(String(error)));
          }
        });
      } catch (error) {
        retire(new Error(String(error)));
        throw error;
      }
    },
    close() {
      closed = true;
      retire(new Error('Artwork Worker closed'));
    },
  };
}
