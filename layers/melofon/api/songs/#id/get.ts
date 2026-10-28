import type { HatContext, HatRequest } from '#melofon/types.ts';
import { browseQuery, requireSong } from '#melofon/browse.ts';
import { songDetail } from '#melofon/browse-payloads.ts';

export default async function (request: HatRequest, context: HatContext) {
  browseQuery(request);
  return { song: songDetail(await requireSong(context, request.params.id)) };
}
