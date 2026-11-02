import type { Notify } from './notify.ts';
import { parseSetting } from './settings-schema.ts';
import type { State } from './state.ts';

const KEY = 'catalog.ignoredArticles';
// Preserve the established browse defaults; reference matching has its own policy.
const SCHEMA = {
  type: 'array' as const,
  items: { type: 'string' as const, minLength: 1, pattern: '^[^\\s,]+$' },
  default: ['The', 'El', 'La', 'Los', 'Las', 'Le', 'Les', 'Os', 'As', 'O', 'A'],
  title: 'Ignored browse articles',
  description:
    'Leading words ignored when sorting catalog names. Empty disables article stripping.',
};

export interface CatalogOrder {
  ignoredArticles: string[];
  revision: number;
}

export function createCatalogOrder(state: State, notify?: Notify) {
  state.declare(KEY, SCHEMA);
  if (notify) {
    state.onChange((key) => {
      // State notifies only after the setting transaction commits. No values leak.
      if (key === KEY) notify.emit(['library'], undefined, 'all');
    });
  }
  return async (): Promise<CatalogOrder> => {
    // One read binds the effective articles and their revision, including resets.
    const { value, revision } = await state.getWithRevision(KEY);
    return {
      ignoredArticles: value === null
        ? [...SCHEMA.default]
        : parseSetting(SCHEMA, value) as string[],
      revision,
    };
  };
}
