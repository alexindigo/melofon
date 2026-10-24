import type { SetupRequest } from '../types.ts';
import { fail } from '../errors.ts';

export default function (request: SetupRequest) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
  if (request.headers.get('origin') !== new URL(request._raw.url).origin) {
    fail(403, 'origin', 'Origin not allowed');
  }
}
