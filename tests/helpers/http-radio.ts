/** Guest-local raw HTTP radio fixture. Raw sockets allow deliberately invalid
 * status lines, fragmented framing and close-delimited live/truncated bodies. */
export interface RadioReply {
  headers?: Record<string, string>;
  body?: Iterable<Uint8Array> | AsyncIterable<Uint8Array>;
  statusLine?: string;
}

export const radioRequestHeaders = {
  'Icy-MetaData': '1',
  'Accept-Encoding': 'identity',
};

export function icyBlock(payload: string | Uint8Array): Uint8Array {
  const bytes = typeof payload === 'string'
    ? new TextEncoder().encode(payload)
    : payload;
  const size = Math.ceil(bytes.length / 16) * 16;
  if (size > 4080) throw new Error('Fixture ICY metadata exceeds wire limit');
  const result = new Uint8Array(1 + size);
  result[0] = size / 16;
  result.set(bytes, 1);
  return result;
}

export function httpRadio(
  handler: (
    request: Request,
    signal: AbortSignal,
  ) => RadioReply | Promise<RadioReply>,
  options: { requireMetadata?: boolean } = {},
) {
  const listener = Deno.listen({ hostname: '0.0.0.0', port: 0 });
  const origin = `http://melofon.home:${(listener.addr as Deno.NetAddr).port}`;
  const requests: Request[] = [];
  const connections = new Set<Deno.TcpConn>();
  const tasks: Promise<void>[] = [];
  const stop = new AbortController();
  const encoder = new TextEncoder();
  let closed = 0;
  async function write(conn: Deno.TcpConn, bytes: Uint8Array) {
    for (let offset = 0; offset < bytes.length;) {
      offset += await conn.write(bytes.subarray(offset));
    }
  }
  const accept = (async () => {
    try {
      for await (const conn of listener) {
        connections.add(conn);
        const task = (async () => {
          const disconnected = new AbortController();
          const abort = () => disconnected.abort();
          stop.signal.addEventListener('abort', abort, { once: true });
          let peer: Promise<void> | undefined;
          try {
            let head = '';
            const buffer = new Uint8Array(4096);
            while (!head.includes('\r\n\r\n')) {
              const size = await conn.read(buffer);
              if (size === null) return;
              head += new TextDecoder().decode(buffer.subarray(0, size));
              if (head.length > 16384) {
                throw new Error('Fixture request header too large');
              }
            }
            const [start, ...lines] = head.split('\r\n\r\n')[0].split('\r\n');
            const [method, path] = start.split(' ');
            const headers = new Headers();
            for (const line of lines) {
              const colon = line.indexOf(':');
              headers.append(
                line.slice(0, colon),
                line.slice(colon + 1).trim(),
              );
            }
            const request = new Request(new URL(path, origin), {
              method,
              headers,
            });
            requests.push(request);
            peer = conn.read(new Uint8Array(1)).then(abort, abort);
            const reply: RadioReply = options.requireMetadata !== false &&
                headers.get('icy-metadata') !== '1'
              ? { statusLine: 'HTTP/1.1 400 Metadata required' }
              : await handler(request, disconnected.signal);
            const responseHeaders = new Headers({
              'content-type': 'audio/mpeg',
              connection: 'close',
              ...reply.headers,
            });
            await write(
              conn,
              encoder.encode(
                `${reply.statusLine ?? 'HTTP/1.1 200 OK'}\r\n${
                  Array.from(responseHeaders, ([key, value]) =>
                    `${key}: ${value}\r\n`).join('')
                }\r\n`,
              ),
            );
            for await (const bytes of reply.body ?? []) {
              await write(conn, bytes);
            }
          } catch (error) {
            if (
              !stop.signal.aborted &&
              !(error instanceof Deno.errors.BrokenPipe) &&
              !(error instanceof Deno.errors.ConnectionReset)
            ) {
              throw error;
            }
          } finally {
            stop.signal.removeEventListener('abort', abort);
            closed++;
            connections.delete(conn);
            try {
              conn.close();
            } catch { /* Peer or fixture already closed. */ }
            await peer;
          }
        })();
        // Keep the original rejection for close(), without an unhandled promise.
        void task.catch(() => {});
        tasks.push(task);
      }
    } catch (error) {
      if (!stop.signal.aborted) throw error;
    }
  })();
  return {
    origin,
    requests,
    get closed() {
      return closed;
    },
    async close() {
      stop.abort();
      listener.close();
      for (const conn of connections) conn.close();
      await accept;
      await Promise.all(tasks);
    },
  };
}
