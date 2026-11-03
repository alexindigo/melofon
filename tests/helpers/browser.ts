import { assert } from '@std/assert';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Raw CDP, like the existing Kosmozoo driver; no browser package dependency. */
export async function chromium() {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-chromium-' });
  const process = new Deno.Command('chromium', {
    args: [
      '--headless',
      '--no-sandbox',
      '--disable-gpu',
      '--mute-audio',
      '--no-first-run',
      '--no-proxy-server',
      '--disable-background-networking',
      '--autoplay-policy=no-user-gesture-required',
      '--window-size=800,600',
      '--remote-debugging-port=0',
      `--user-data-dir=${dir}/profile`,
      `--disk-cache-dir=${dir}/cache`,
      'about:blank',
    ],
    stdout: 'null',
    stderr: 'null',
  }).spawn();
  let ws: WebSocket | undefined;
  const pending = new Map<number, {
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
  }>();
  let id = 0;
  const exceptions: unknown[] = [];
  async function send<T>(method: string, params = {}): Promise<T> {
    assert(ws?.readyState === WebSocket.OPEN, 'CDP is connected');
    const requestId = ++id;
    const result = new Promise<unknown>((resolve, reject) => {
      pending.set(requestId, { resolve, reject });
      ws!.send(JSON.stringify({ id: requestId, method, params }));
    });
    const timer = setTimeout(() => {
      pending.get(requestId)?.reject(new Error(`CDP timeout: ${method}`));
      pending.delete(requestId);
    }, 20000);
    try {
      return await result as T;
    } finally {
      clearTimeout(timer);
    }
  }
  async function evaluate<T>(expression: string): Promise<T> {
    const result = await send<{
      result: { value: T };
      exceptionDetails?: unknown;
    }>('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  async function poll(expression: string, ms = 20000) {
    const deadline = Date.now() + ms;
    while (!await evaluate(expression)) {
      assert(Date.now() < deadline, `Browser timeout: ${expression}`);
      await sleep(50);
    }
  }
  async function close() {
    if (ws?.readyState === WebSocket.OPEN) {
      await send('Browser.close').catch(() => {});
    } else {
      process.kill('SIGTERM');
    }
    await process.status;
    if (ws && ws.readyState < WebSocket.CLOSING) ws.close();
    await Deno.remove(dir, { recursive: true });
  }
  try {
    const deadline = Date.now() + 15000;
    let port = '';
    while (!port) {
      try {
        port = (await Deno.readTextFile(`${dir}/profile/DevToolsActivePort`))
          .split('\n')[0];
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
      assert(Date.now() < deadline, 'Chromium debugging endpoint started');
      if (!port) await sleep(50);
    }
    const targets = await (await fetch(
      `http://127.0.0.1:${port}/json/list`,
      { signal: AbortSignal.timeout(5000) },
    )).json();
    ws = new WebSocket(
      targets.find((t: { type: string }) => t.type === 'page')
        .webSocketDebuggerUrl,
    );
    ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.method === 'Runtime.exceptionThrown') {
        exceptions.push(message.params);
      }
      if (!message.id) return;
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) request?.reject(new Error(message.error.message));
      else request?.resolve(message.result);
    };
    ws.onclose = () => {
      for (const request of pending.values()) {
        request.reject(new Error('CDP closed'));
      }
      pending.clear();
    };
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('CDP open timeout')),
        5000,
      );
      ws!.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      ws!.onerror = () => {
        clearTimeout(timer);
        reject(new Error('CDP error'));
      };
    });
    await send('Runtime.enable');
    await send('Page.enable');
    return { send, evaluate, poll, exceptions, close };
  } catch (error) {
    await close();
    throw error;
  }
}
