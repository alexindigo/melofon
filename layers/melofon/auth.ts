import type { HatContext, HatRequest } from './types.ts';
import { core, fail } from './errors.ts';

export function bearer(request: HatRequest): string | null {
  return request.headers.get('authorization')?.match(/^Bearer ([^\s]+)$/i)
    ?.[1] ?? null;
}

export default async function auth(request: HatRequest, context: HatContext) {
  // An explicit Authorization header takes precedence; never fall back to a
  // cookie when the caller supplied an invalid/unsupported credential.
  let key = bearer(request);
  if (!request.headers.has('authorization')) {
    key = (request.headers.get('cookie') ?? '').split(';')
      .map((part) => part.trim()).find((part) =>
        part.startsWith('melofon_session=')
      )
      ?.slice('melofon_session='.length) ?? null;
  }
  const authenticated = key
    ? await core(() => context.app.sessions.authenticate(key))
    : null;
  if (!authenticated) fail(401, 'unauthenticated', 'Sign in required');
  context.state.user = authenticated.user;
  context.state.sessionId = authenticated.sessionId;
  await core(() => context.app.users.noteAccess(authenticated.user.id));
}
