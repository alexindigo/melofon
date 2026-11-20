import type { HatContext, HatRequest } from '#melofon/types.ts';
import { core, fail } from '#melofon/errors.ts';
import { fields, optionalText } from '#melofon/input.ts';
import { source } from '#melofon/libraries.ts';
import { playerId, playerPayload } from '#melofon/players.ts';

export default async function (request: HatRequest, context: HatContext) {
  const id = playerId(request.params.id);
  const body = fields(context, ['name', 'repeat', 'consume', 'crossfadeMs']);
  const name = optionalText(body, 'name');
  const repeat = body.repeat;
  const consume = body.consume;
  const crossfadeMs = body.crossfadeMs;
  if (
    name === undefined && repeat === undefined && consume === undefined &&
    crossfadeMs === undefined
  ) {
    fail(400, 'invalid_field', 'Provide name, repeat, consume or crossfadeMs');
  }
  if (
    repeat !== undefined && repeat !== 'off' && repeat !== 'all' &&
    repeat !== 'single'
  ) fail(400, 'invalid_field', 'repeat must be off, all or single');
  if (consume !== undefined && typeof consume !== 'boolean') {
    fail(400, 'invalid_field', 'consume must be a boolean');
  }
  if (
    crossfadeMs !== undefined &&
    (typeof crossfadeMs !== 'number' || !Number.isSafeInteger(crossfadeMs) ||
      crossfadeMs < 0 ||
      BigInt(crossfadeMs) * 44100n / 1000n >
        BigInt(Number.MAX_SAFE_INTEGER) / 4n)
  ) {
    fail(
      400,
      'invalid_field',
      'crossfadeMs must be representable nonnegative integer milliseconds',
    );
  }
  const player = await core(async () => {
    if (name !== undefined) await context.app.players.rename(id, name);
    const playback = context.app.players.get(id);
    const provenance = source(request, context);
    if (repeat !== undefined) await playback.setRepeat(repeat, provenance);
    if (consume !== undefined) await playback.setConsume(consume, provenance);
    if (crossfadeMs !== undefined) {
      await playback.setCrossfade(crossfadeMs, provenance);
    }
    return playerPayload(context, id);
  });
  return Response.json({ player }, {
    headers: { 'Cache-Control': 'no-store' },
  });
}
