import type { HatContext, HatRequest } from './types.ts';
import { bearer } from './auth.ts';
import { fail } from './errors.ts';

export default async function origin(request: HatRequest, context: HatContext) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
  await checkOrigin(request, context);
}

export async function checkOrigin(request: HatRequest, context: HatContext) {
  const value = request.headers.get('origin');
  if (
    value === null
      ? bearer(request) !== null
      : await context.app.publicAddress.acceptsOrigin(request._raw, value)
  ) return;
  fail(403, 'origin', 'Origin not allowed');
}
