// One owner for every HTTP socket, including ports activated after startup.
import type { PathfinderApp } from '@pathfinder/pathfinder';
import type { Layer } from './layers.ts';
import type { PortMapping } from './binds.ts';
import { facade } from './facade.ts';
import { type Log, scopedLog } from './logging.ts';
import type { PublicAddress } from './public-address.ts';

export interface ListenManager {
  list(): ListenView[];
  ensure(ports: number[]): Promise<void>;
  shutdown(): Promise<void>;
}
export interface ListenView {
  hostname: string;
  port: number;
  kind: 'default' | 'extra';
  hats: string[];
}

export function createListenManager(opts: {
  core: PathfinderApp;
  layers: () => Layer[];
  mapping: PortMapping;
  defaultPort: number;
  hostname?: string;
  debugLogRequests?: boolean;
  debugLogHeaders?: boolean;
  log?: Log;
  setupMode?: boolean;
  publicAddress?: PublicAddress;
}): ListenManager {
  const servers = new Map<number, Deno.HttpServer<Deno.NetAddr>>();
  const log = opts.log ?? scopedLog('server');
  let closed = false;
  let tail: Promise<unknown> = Promise.resolve();
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = tail.then(fn);
    tail = result.catch(() => {});
    return result;
  }
  return {
    list: () =>
      [...servers.entries()].map(([port, server]) => ({
        hostname: server.addr.hostname,
        port: server.addr.port,
        kind: port === opts.defaultPort ? 'default' : 'extra',
        hats: opts.layers().filter((layer) =>
          port === opts.defaultPort
            ? layer.ports.length === 0
            : opts.mapping.actual(layer).includes(port)
        ).map((layer) => layer.name),
      })),
    ensure(ports) {
      return serial(async () => {
        if (closed) throw new Error('Listens are closed');
        const opened: number[] = [];
        try {
          for (const port of new Set(ports)) {
            if (servers.has(port)) continue;
            const kind = port === opts.defaultPort ? 'default' : 'extra';
            const server = Deno.serve(
              {
                hostname: opts.hostname,
                port,
                onListen: ({ hostname, port }) =>
                  log.event('listening', { hostname, port, kind }),
                onError(error) {
                  log.event('server_error', { error });
                  return new Response('Internal Server Error', { status: 500 });
                },
              },
              facade(opts.core, opts.layers, {
                listenPort: port,
                defaultPort: opts.defaultPort,
                mapping: opts.mapping,
                debugLogRequests: opts.debugLogRequests,
                debugLogHeaders: opts.debugLogHeaders,
                setupMode: opts.setupMode,
                publicAddress: opts.publicAddress,
              }),
            );
            servers.set(port, server);
            opened.push(port);
            void server.finished.then(
              () => log.event('server_finished', { port }),
              (error) => log.event('server_failed', { port, error }),
            );
          }
        } catch (error) {
          // Multi-port activation is all-or-nothing. Never close shared sockets.
          await Promise.all(opened.map(async (port) => {
            const server = servers.get(port)!;
            servers.delete(port);
            await server.shutdown();
          }));
          throw error;
        }
      });
    },
    shutdown() {
      return serial(async () => {
        closed = true;
        await Promise.all(
          [...servers.values()].map((server) => server.shutdown()),
        );
        servers.clear();
      });
    },
  };
}
