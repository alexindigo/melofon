import type { HatContext } from '#melofon/types.ts';
import { core } from '#melofon/errors.ts';
import { fields, text } from '#melofon/input.ts';
import { playerSummary } from '#melofon/players.ts';

export default async function (_request: unknown, context: HatContext) {
  const name = text(fields(context, ['name']), 'name');
  const player = await core(() => context.app.players.create(name));
  return Response.json({ player: playerSummary(player) }, {
    status: 201,
    headers: { 'Cache-Control': 'no-store' },
  });
}
