// Owned bounded legacy-unicast DNS-SD requests, independent of browsing.
import dgram from 'node:dgram';
import { lookup } from 'node:dns/promises';
import { isIPv4 } from 'node:net';
import {
  createServiceRecords,
  dnsQuestions,
  encodeQuery,
  type MdnsService,
} from './mdns.ts';
import { PreparationError } from './output-admission.ts';

export interface ResolverSocket {
  bind(port: number, callback: () => void): void;
  send(message: Uint8Array, port: number, address: string): void;
  on(
    event: 'message',
    fn: (message: Uint8Array, peer: { address: string; port: number }) => void,
  ): void;
  on(event: 'error', fn: (error: Error) => void): void;
  close(): void;
}

export function createMdnsResolver(deps: {
  socket?(): ResolverSocket;
  lookup?(host: string): Promise<string>;
  timeoutMs?: number;
  port?: number;
} = {}) {
  const active = new Set<AbortController>();
  let closed = false;
  return {
    close() {
      closed = true;
      for (const request of active) request.abort();
    },
    resolve(
      host: string,
      expectedPort?: number,
      signal = new AbortController().signal,
    ): Promise<MdnsService> {
      return new Promise((resolve, reject) => {
        const controller = new AbortController();
        active.add(controller);
        let socket: ResolverSocket | undefined;
        let done = false;
        let target = '';
        const table = createServiceRecords('_raop._tcp');
        const questions = new Map<number, { name: string; types: number[] }>();
        const sent = new Set<string>();
        const cancel = () => controller.abort();
        const finish = (error?: PreparationError, service?: MdnsService) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          signal.removeEventListener('abort', cancel);
          active.delete(controller);
          try {
            socket?.close();
          } catch { /* already closed */ }
          if (error) reject(error);
          else resolve(service!);
        };
        const timer = setTimeout(
          () =>
            finish(
              new PreparationError(
                'timeout',
                'receiver capabilities timed out',
              ),
            ),
          deps.timeoutMs ?? 2000,
        );
        signal.addEventListener('abort', cancel, { once: true });
        controller.signal.addEventListener(
          'abort',
          () =>
            finish(
              new PreparationError('cancelled', 'receiver lookup cancelled'),
            ),
          { once: true },
        );
        if (closed || signal.aborted) {
          controller.abort();
          return;
        }
        const query = (name: string, types: number[]) => {
          if (done) return;
          const key = `${name.toLowerCase()}|${types}`;
          if (sent.has(key)) return;
          sent.add(key);
          let id: number;
          do {
            id = crypto.getRandomValues(new Uint16Array(1))[0] || 1;
          } while (questions.has(id));
          questions.set(id, { name: name.toLowerCase(), types });
          socket!.send(encodeQuery(name, types, id), deps.port ?? 5353, target);
        };
        void (async () => {
          try {
            target = isIPv4(host) ? host : await (deps.lookup?.(host) ??
              lookup(host, { family: 4 }).then((r) => r.address));
            if (done) return;
            if (!isIPv4(target)) {
              throw new PreparationError(
                'unsupported',
                'receiver requires a usable IPv4 address',
              );
            }
            socket = deps.socket?.() ?? dgram.createSocket('udp4');
            socket.on(
              'error',
              () =>
                finish(
                  new PreparationError(
                    'unavailable',
                    'receiver lookup socket failed',
                  ),
                ),
            );
            socket.on('message', (message, peer) => {
              if (
                done || peer.address !== target ||
                peer.port !== (deps.port ?? 5353) || message.length < 12
              ) return;
              const header = new DataView(
                message.buffer,
                message.byteOffset,
                message.byteLength,
              );
              const asked = questions.get(header.getUint16(0));
              const echoed = dnsQuestions(message);
              if (
                !asked || !echoed || !echoed.some((q) =>
                  q.name.toLowerCase() === asked.name &&
                  asked.types.includes(q.type)
                ) || (message[3] & 0x0f) !== 0
              ) {
                return;
              }
              if (!table.ingest(message)) {
                finish(
                  new PreparationError('invalid', 'malformed receiver records'),
                );
                return;
              }
              const services = table.services().filter((s) =>
                s.address === target &&
                (expectedPort === undefined || s.port === expectedPort)
              );
              if (services.length > 1) {
                finish(
                  new PreparationError('invalid', 'ambiguous receiver service'),
                );
                return;
              }
              if (
                services.length === 1 &&
                [...table.instances.values()].every((i) =>
                  i.host && i.port && i.gotTxt && i.address
                )
              ) {
                finish(undefined, services[0]);
                return;
              }
              try {
                for (const instance of table.instances.values()) {
                  if (!instance.host || !instance.gotTxt) {
                    query(instance.name, [33, 16]);
                  }
                  if (instance.host && !instance.address) {
                    query(instance.host, [1, 28]);
                  }
                }
              } catch {
                finish(
                  new PreparationError(
                    'unavailable',
                    'receiver query send failed',
                  ),
                );
              }
            });
            socket.bind(0, () => {
              try {
                query('_raop._tcp.local', [12]);
              } catch {
                finish(
                  new PreparationError(
                    'unavailable',
                    'receiver query send failed',
                  ),
                );
              }
            });
          } catch (error) {
            finish(
              error instanceof PreparationError ? error : new PreparationError(
                'unavailable',
                'receiver hostname/socket unavailable',
              ),
            );
          }
        })();
      });
    },
  };
}

export type MdnsResolver = ReturnType<typeof createMdnsResolver>;
