import type { HatContext, HatRequest, Source } from './types.ts';

export function source(request: HatRequest, context: HatContext): Source {
  return {
    kind: 'http',
    via: 'melofon',
    peer: request.remoteAddr?.hostname,
    userAgent: request.headers.get('user-agent') ?? undefined,
    user: context.state.user.username,
  };
}
