// Standalone bootstrap, loaded as a data URL so plugin read authority stays
// confined to its folder. No core module or function enters the plugin isolate.
let generation = '';
let plugin: Record<string, (...args: never[]) => unknown>;
let heartbeat: ReturnType<typeof setInterval>;
let sequence = 0;
const requests = new Map<
  number,
  { resolve: (value: Response) => void; reject: (error: Error) => void }
>();
const calls = new Map<string, AbortController>();
const disposers: (() => unknown)[] = [];
const send = (value: Record<string, unknown>) =>
  postMessage({ ...value, generation });
function context(settings: unknown, signal: AbortSignal, call: string) {
  return {
    settings,
    signal,
    onDispose(fn: () => unknown) {
      disposers.push(fn);
    },
    log(...args: unknown[]) {
      send({ type: 'log', args });
    },
    fetch(
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> {
      signal.throwIfAborted();
      const request = new Request(input, init);
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const abort = () => {
          requests.delete(id);
          reject(signal.reason);
        };
        signal.addEventListener('abort', abort, { once: true });
        requests.set(id, {
          resolve(value) {
            signal.removeEventListener('abort', abort);
            resolve(value);
          },
          reject(error) {
            signal.removeEventListener('abort', abort);
            reject(error);
          },
        });
        void request.arrayBuffer().then(
          (body) =>
            send({
              type: 'fetch',
              id,
              call,
              url: request.url,
              init: {
                method: request.method,
                headers: [...request.headers],
                body: body.byteLength ? body : undefined,
              },
            }),
          reject,
        );
      });
    },
  };
}
addEventListener('message', async ({ data }) => {
  if (data.type === 'init') {
    generation = data.generation;
    try {
      plugin = (await import(data.entry)).default;
      if (
        !plugin ||
        data.capabilities.some((id: string) => typeof plugin[id] !== 'function')
      ) throw new Error('Missing capability export');
      heartbeat = setInterval(
        () => send({ type: 'heartbeat' }),
        data.heartbeatMs,
      );
      send({ type: 'ready' });
      send({ type: 'heartbeat' });
    } catch (error) {
      send({ type: 'failed', error: String(error) });
    }
    return;
  }
  if (data.generation !== generation) return;
  if (data.type === 'fetchResult') {
    const pending = requests.get(data.id);
    requests.delete(data.id);
    if (data.error) pending?.reject(new Error(data.error));
    else pending?.resolve(new Response(data.body, data.init));
  } else if (data.type === 'abort') {
    calls.get(data.call)?.abort(new Error(data.reason));
  } else if (data.type === 'call') {
    const controller = new AbortController();
    calls.set(data.call, controller);
    try {
      const result = await Reflect.apply(plugin[data.capability], plugin, [
        data.item,
        context(data.settings, controller.signal, data.call),
      ]);
      send({ type: 'result', call: data.call, result });
    } catch (error) {
      send({ type: 'result', call: data.call, error: String(error) });
    } finally {
      controller.abort(new Error('Lookup call finished'));
      calls.delete(data.call);
    }
  } else if (data.type === 'stop') {
    clearInterval(heartbeat);
    for (const controller of calls.values()) {
      controller.abort(new Error('Plugin disabled'));
    }
    for (const dispose of disposers.reverse()) {
      try {
        await dispose();
      } catch (error) {
        send({ type: 'log', args: [String(error)] });
      }
    }
    send({ type: 'stopped' });
  }
});
export {};
