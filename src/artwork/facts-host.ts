import type { State } from '../state.ts';
import type { ArtworkPreview } from '../store/artwork.ts';
import {
  createWorkerIntake,
  createWorkerSession,
  type WorkerSession,
} from '../worker-host.ts';

/** One reusable sequential Worker; overlapping calls reject as busy.
 * Both startup and computation are bounded; retirement rejects the current call
 * before terminating its Worker. */
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
  const intake = createWorkerIntake('Artwork Worker');
  let session: WorkerSession | undefined;
  function start(seconds: number) {
    const worker = new Worker(
      new URL('./facts-bootstrap.ts', import.meta.url),
      {
        type: 'module',
      },
    );
    let initialized = false;
    const current = createWorkerSession(worker, {
      startup: {
        milliseconds: seconds * 1000,
        error: new Error('Artwork Worker startup timed out'),
      },
      invalidMessage: 'Invalid artwork Worker message',
      onMessage(data, slot) {
        if (data?.call !== undefined && data.call !== slot.call?.id) return;
        if (data?.error) return slot.retire(new Error(data.error));
        if (!initialized) {
          if (data?.ready !== true) {
            return slot.retire(new Error('Invalid artwork Worker startup'));
          }
          initialized = true;
          return slot.markReady();
        }
        if (!slot.call || data?.call !== slot.call.id) return;
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
        ) return slot.retire(new Error('Invalid artwork Worker result'));
        slot.call.resolve(value);
      },
    });
    session = current;
    try {
      worker.postMessage({ module: workerUrl.href });
    } catch (error) {
      current.retire(new Error(String(error)));
    }
    return current;
  }
  return {
    compute(
      pixels: { width: number; height: number; rgba: Uint8Array },
    ): Promise<ArtworkPreview> {
      return intake.run(async ({ signal }) => {
        let current: WorkerSession | undefined;
        const abort = () => current?.retire(new Error('Artwork Worker closed'));
        signal.addEventListener('abort', abort, { once: true });
        try {
          const startup = Number(
            await state.getTyped('artwork.facts.startupSeconds'),
          );
          const seconds = Number(
            await state.getTyped('artwork.facts.computeSeconds'),
          );
          if (signal.aborted) throw new Error('Artwork Worker closed');
          current = session && !session.retired ? session : start(startup);
          await current.ready;
          if (signal.aborted) throw new Error('Artwork Worker closed');
          return await current.request<ArtworkPreview>(
            (call) => current!.worker.postMessage({ ...pixels, call: call.id }),
            {
              milliseconds: seconds * 1000,
              error: new Error('Artwork computation timed out'),
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
    close() {
      const closing = intake.close();
      session?.retire(new Error('Artwork Worker closed'));
      return closing;
    },
  };
}
