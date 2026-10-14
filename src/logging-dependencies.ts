// Supported dependency ingress only. This module owns the console adapter, never descriptors.
import { createRequire } from 'node:module';
import type { Logger } from './logging.ts';

export function installDependencyLogging(logger: Logger): () => void {
  const original = new Map<string, unknown>();
  const target = console as unknown as Record<string, unknown>;
  for (
    const method of [
      'log',
      'info',
      'warn',
      'error',
      'debug',
      'trace',
      'dir',
      'dirxml',
      'table',
      'group',
      'groupCollapsed',
      'groupEnd',
      'count',
      'countReset',
      'time',
      'timeLog',
      'timeEnd',
      'assert',
      'clear',
    ]
  ) {
    original.set(method, target[method]);
    target[method] = (...args: unknown[]) => {
      if (method === 'assert' && args.shift()) return;
      logger.event('dependency_console', { method, args });
    };
  }
  const require = createRequire(import.meta.url);
  const metadataRequire = createRequire(require.resolve('music-metadata'));
  const debug = metadataRequire('debug') as {
    log: (this: { namespace: string }, ...args: unknown[]) => void;
  };
  const priorDebug = debug.log;
  debug.log = function (...args: unknown[]) {
    logger.event('dependency_debug', { namespace: this.namespace, args });
  };
  return () => {
    for (const [method, value] of original) target[method] = value;
    debug.log = priorDebug;
  };
}
