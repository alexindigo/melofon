import type { HatContext, HatRequest } from '#melofon/types.ts';
import { playerCommand } from '#melofon/players.ts';

export default function (request: HatRequest, context: HatContext) {
  return playerCommand(request, context, 'previous');
}
