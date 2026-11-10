import type { HatContext } from '#melofon/types.ts';
import { playerSummary } from '#melofon/players.ts';

export default function (_request: unknown, context: HatContext) {
  return Response.json({
    players: context.app.players.list().map(playerSummary),
  }, {
    headers: { 'Cache-Control': 'no-store' },
  });
}
