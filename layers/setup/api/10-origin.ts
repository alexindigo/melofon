import type { SetupContext, SetupRequest } from '../types.ts';
import { fail } from '../errors.ts';

export default async function (request: SetupRequest, context: SetupContext) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
  const value = request.headers.get('origin');
  if (
    value === null ||
    !await context.app.publicAddress.acceptsOrigin(request._raw, value)
  ) {
    fail(403, 'origin', 'Origin not allowed');
  }
}
