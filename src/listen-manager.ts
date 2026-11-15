// One owner for every HTTP socket, including ports activated after startup.
import type { PathfinderApp } from '@pathfinder/pathfinder';
import type { Layer } from './layers.ts';
import type { PortMapping } from './binds.ts';
import { facade } from './facade.ts';
import { type Log, scopedLog } from './logging.ts';
import type { PublicAddress } from './public-address.ts';
import { createReleaseSet, releaseOrThrow } from './releases.ts';

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
  const retiring = new Set<number>();
  const releases = createReleaseSet();
  const log = opts.log ?? scopedLog('server');
  let closed = false;
  let tail: Promise<unknown> = Promise.resolve();
  let closing: Promise<void> | undefined;
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
      if (closed) return Promise.reject(new Error('Listens are closed'));
      return serial(async () => {
        const opened: number[] = [];
        try {
          for (const port of new Set(ports)) {
            if (servers.has(port)) {
              if (retiring.has(port)) {
                throw new Error(`Listen ${port} still awaits release`);
              }
              continue;
            }
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
            releases.add(String(port), async () => {
              retiring.add(port);
              await server.shutdown();
              servers.delete(port);
              retiring.delete(port);
            });
            opened.push(port);
            void server.finished.then(
              () => log.event('server_finished', { port }),
              (error) => log.event('server_failed', { port, error }),
            );
          }
        } catch (error) {
          // Multi-port activation is all-or-nothing. Never close shared sockets.
          await releaseOrThrow(
            releases,
            'Listen activation rollback failed',
            { error },
            opened.map(String),
          );
        }
      });
    },
    shutdown() {
      closed = true;
      return closing ??= serial(async () => {
        await releaseOrThrow(releases, 'Listen shutdown failed');
      }).finally(() => {
        closing = undefined;
      });
    },
  };
}
