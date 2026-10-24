// Admin-only public projection; the declaration registry remains core-owned.
import type { Store } from './store/index.ts';
import type { SettingsState } from './state.ts';
import { UserError } from './user-errors.ts';
import { SettingsError } from './settings-errors.ts';

export function createSettings(store: Store, state: SettingsState) {
  return Object.freeze({
    async describe(caller: string, key?: string) {
      if ((await store.users.byId(caller))?.role !== 'admin') {
        throw new UserError('forbidden');
      }
      const settings = await state.describe();
      if (key === undefined) return settings;
      const item = settings.find((item) => item.key === key);
      if (!item) {
        throw new SettingsError('unknown_setting', 'Unknown setting', key);
      }
      return [item];
    },
    change: state.change,
  });
}
