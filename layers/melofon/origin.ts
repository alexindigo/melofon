import type { HatRequest } from './types.ts';
import { bearer } from './auth.ts';
import { fail } from './errors.ts';

export default function origin(request: HatRequest) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
  checkOrigin(request);
}

export function checkOrigin(request: HatRequest) {
  const value = request.headers.get('origin');
  if (
    value === null
      ? bearer(request) !== null
      : value === new URL(request._raw.url).origin
  ) return;
  fail(403, 'origin', 'Origin not allowed');
}
