import type { HatRequest } from './types.ts';
import { fail } from './errors.ts';
import { browseInteger, browseQuery } from './browse.ts';

export function entryId(raw: string): number {
  const id = Number(raw);
  if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(id)) {
    fail(404, 'not_found', 'Queue entry not found');
  }
  return id;
}

export function expectedVersion(value: unknown): number | undefined {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    fail(400, 'invalid_field', 'expectedVersion must be a nonnegative integer');
  }
  return Number(value);
}

/** DELETE has no JSON body in the native API; condition travels in the query. */
export function deleteVersion(request: HatRequest): number | undefined {
  const params = browseQuery(request, ['expectedVersion']);
  return params.has('expectedVersion')
    ? browseInteger(params, 'expectedVersion', 0, 0)
    : undefined;
}
