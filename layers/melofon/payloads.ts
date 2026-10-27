import type { HatContext, HatRequest, Session, User } from './types.ts';
import { core, fail } from './errors.ts';

export function me(user: User, session: Pick<Session, 'id' | 'deviceName'>) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    email: user.email,
    role: user.role,
    lastLoginAt: user.lastLoginAt,
    session: { id: session.id, deviceName: session.deviceName },
  };
}
export async function current(context: HatContext) {
  const sessions = await core(() =>
    context.app.sessions.list(context.state.user.id)
  );
  const session = sessions.find((item) => item.id === context.state.sessionId);
  if (!session) {
    // A concurrent revocation may happen after the authentication middleware.
    fail(401, 'unauthenticated', 'Sign in required');
  }
  return me(context.state.user, session);
}
export async function cookie(
  request: HatRequest,
  context: HatContext,
  key = '',
) {
  const maxAge = key
    ? Number(await context.app.state.getTyped('melofon.cookieMaxAgeSeconds'))
    : 0;
  const secure = await context.app.publicAddress.secure(request._raw)
    ? '; Secure'
    : '';
  const path = await context.app.publicAddress.prefix() || '/';
  return `melofon_session=${key}; HttpOnly; SameSite=Strict; Path=${path}; Max-Age=${maxAge}${secure}`;
}
export function sessionList(sessions: Session[], currentId: string) {
  return {
    sessions: sessions.map((
      { id, deviceName, userAgent, createdAt, lastUsedAt },
    ) => ({
      id,
      deviceName,
      userAgent,
      createdAt,
      lastUsedAt,
      current: id === currentId,
    })),
  };
}
