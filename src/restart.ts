import { appLogger, type Log, scopedLog } from './logging.ts';

/** One exit boundary for normal termination and service-manager restarts. */
export function createTermination(options: {
  close(): Promise<void>;
  exit?: (code: number) => void;
  log?: Log;
}) {
  let closing: Promise<void> | undefined;
  const log = options.log ?? scopedLog('server');
  function shutdown(code = 0): Promise<void> {
    return closing ??= (async () => {
      await options.close();
      await appLogger().flush();
      (options.exit ?? Deno.exit)(code);
    })();
  }
  function restartAfter(completed: Promise<void>) {
    const restart = async () => {
      log.event('restart_requested', {
        reason:
          'First admin created; start Melofon again if no service manager is running',
      });
      await shutdown(75);
    };
    // A disconnected client cannot keep the newly configured server running in
    // setup mode. Either completion outcome means the transport is finished.
    void completed.then(restart, restart).catch(async (error) => {
      log.event('server_error', { error });
      await appLogger().flush();
      (options.exit ?? Deno.exit)(1);
    });
  }
  return { shutdown, restartAfter };
}
