// Shared station data validation. Protocol-specific write limits belong to hats.
import type { Store } from './store/index.ts';
import type { StationInput, StationRow } from './store/radio.ts';

export type StationResult = StationRow | { invalid: string };

function validate(input: StationInput): StationInput | { invalid: string } {
  const name = input.name.trim();
  if (!name) return { invalid: 'Station name must not be empty' };
  for (const key of ['streamUrl', 'homePageUrl'] as const) {
    const value = input[key];
    if (value === null && key === 'homePageUrl') continue;
    try {
      const url = new URL(value!);
      if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) {
        throw new Error();
      }
    } catch {
      return { invalid: `${key} must be an absolute http or https URL` };
    }
  }
  return { ...input, name };
}

export function createRadio(store: Store) {
  return {
    list: () => store.radio.list(),
    async create(
      input: StationInput,
    ): Promise<StationResult> {
      const checked = validate(input);
      if ('invalid' in checked) return checked;
      return await store.radio.create(checked);
    },
    async update(
      id: string,
      input: StationInput,
    ): Promise<StationResult | null> {
      const checked = validate(input);
      if ('invalid' in checked) return checked;
      return await store.radio.update(id, checked);
    },
    async delete(id: string): Promise<boolean> {
      return await store.radio.delete(id);
    },
  };
}
