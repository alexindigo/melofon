// Core projects live facts; hats encode them without access to the registry/logger.
import type { Store } from './store/index.ts';
import type { Hats } from './hats.ts';
import type { ListenView } from './listen-manager.ts';
import type { ScanService } from './scan.ts';
import type { Logger, LogQuery } from './logging.ts';
import { UserError } from './user-errors.ts';

export function createServerStatus(opts: {
  store: Pick<Store, 'users'>;
  version: string;
  startedAt: string;
  hats: () => Hats;
  listens: () => ListenView[];
  scan: Pick<ScanService, 'status'>;
  logger: Logger;
}) {
  async function caller(id: string, admin = false) {
    const user = await opts.store.users.byId(id);
    if (!user || (admin && user.role !== 'admin')) {
      throw new UserError('forbidden');
    }
    return user;
  }
  return Object.freeze({
    async get(id: string) {
      const user = await caller(id);
      const basic = {
        version: opts.version,
        startedAt: opts.startedAt,
        uptimeMs: Math.max(0, Date.now() - Date.parse(opts.startedAt)),
      };
      if (user.role !== 'admin') return basic;
      const views = opts.hats().list();
      const active = views.filter((h) => h.state === 'active').map((h) =>
        h.name
      );
      const failed = views.filter((h) =>
        h.state === 'failed' ||
        h.errors.some((e) => e.phase === 'activate')
      ).map((h) => h.name);
      const restartRequired = opts.hats().restartRequired;
      const scan = await opts.scan.status();
      const stats = opts.logger.stats();
      const warnings: { code: string; message: string }[] = [];
      const warn = (code: string, message: string) =>
        warnings.push({ code, message });
      if (!scan.folderCount) {
        warn('no_library', 'No music libraries are configured.');
      }
      if (scan.scanning) {
        warn('scanning', 'The music library is being scanned.');
      }
      if (scan.lastError) warn('scan_failed', 'The last library scan failed.');
      for (const name of failed) warn('hat_failed', `Hat ${name} failed.`);
      if (restartRequired) {
        warn(
          'restart_required',
          'Restart Melofon to apply pending hat changes.',
        );
      }
      if (stats.failures || stats.dropped) {
        warn(
          'log_dropped',
          'Some log records could not be normalized or written.',
        );
      }
      return {
        ...basic,
        listens: opts.listens(),
        hats: { active, failed, restartRequired },
        warnings,
      };
    },
    async log(id: string, query: LogQuery) {
      await caller(id, true);
      return opts.logger.records(query);
    },
    async logText(id: string) {
      await caller(id, true);
      return opts.logger.text();
    },
    async clearLog(id: string) {
      await caller(id, true);
      opts.logger.clear();
    },
  });
}
