import type { HatContext, HatRequest } from '#melofon/types.ts';
import { core } from '#melofon/errors.ts';

export default async function (_request: HatRequest, context: HatContext) {
  return {
    capabilities: await core(() =>
      context.app.sessions.playbackCapabilities(
        context.state.user.id,
        context.state.sessionId,
      )
    ),
  };
}
