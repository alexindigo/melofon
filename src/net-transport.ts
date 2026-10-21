// Native Node compatibility APIs preserve TLS identity while the supplied
// lookup returns only the address already validated by the network owner.
import { Agent as HttpAgent, request as httpRequest } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { abortable } from './net-address.ts';

export async function pinnedRequest(
  url: URL,
  address: string,
  init: RequestInit,
  signal: AbortSignal,
  ca?: string,
): Promise<{ response: Response; close(): Promise<void> }> {
  const input = new Request(url, { ...init, signal });
  const body = input.body
    ? new Uint8Array(await abortable(input.arrayBuffer(), signal))
    : undefined;
  signal.throwIfAborted();
  const headers = Object.fromEntries(input.headers);
  headers['accept-encoding'] ??= 'gzip, deflate, br';
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  // A default agent can honor environment proxies and bypass the checked
  // destination. An explicitly empty per-agent proxy policy takes precedence.
  const agent = url.protocol === 'https:'
    ? new HttpsAgent({ keepAlive: false, proxyEnv: {} })
    : new HttpAgent({ keepAlive: false, proxyEnv: {} });
  return await new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      url,
      {
        method: input.method,
        headers,
        signal,
        agent,
        family: isIP(address),
        // No second resolver call, agent reuse or environment proxy can select a
        // different address. Numeric URL hosts are already checked directly.
        lookup: (_host, _options, callback) =>
          callback(null, address, isIP(address)),
        servername: isIP(hostname) ? undefined : hostname,
        ...(ca ? { ca } : {}),
      },
    );
    const closed = new Promise<void>((done) => request.once('close', done));
    request.on('error', (error) => {
      agent.destroy();
      void closed.then(() => reject(error));
    });
    request.once('response', (message) => {
      const responseHeaders = new Headers();
      for (let i = 0; i < message.rawHeaders.length; i += 2) {
        responseHeaders.append(
          message.rawHeaders[i],
          message.rawHeaders[i + 1],
        );
      }
      let stream: Readable = message;
      const encoding = responseHeaders.get('content-encoding')?.toLowerCase();
      const decompress = encoding === 'gzip'
        ? createGunzip()
        : encoding === 'deflate'
        ? createInflate()
        : encoding === 'br'
        ? createBrotliDecompress()
        : undefined;
      if (decompress) {
        message.on('error', (error) => decompress.destroy(error));
        stream = message.pipe(decompress);
      }
      const status = message.statusCode!;
      const noBody = input.method === 'HEAD' ||
        [204, 205, 304].includes(status);
      const response = new Response(
        noBody ? null : Readable.toWeb(stream) as ReadableStream<Uint8Array>,
        {
          status,
          statusText: message.statusMessage,
          headers: responseHeaders,
        },
      );
      resolve({
        response,
        async close() {
          stream.destroy();
          message.destroy();
          request.destroy();
          agent.destroy();
          await closed;
        },
      });
    });
    request.end(body);
  });
}
