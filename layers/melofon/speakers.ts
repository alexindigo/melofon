import type { HatRequest } from './types.ts';
import { fail } from './errors.ts';

export function speakerOptions(request: HatRequest) {
  const raw = new URL(request._raw.url).searchParams.get('includeIgnored');
  if (raw !== null && raw !== 'true' && raw !== 'false') {
    fail(400, 'invalid_field', 'Invalid includeIgnored');
  }
  return { includeIgnored: raw === 'true' };
}
