// layers/opensubsonic/rest/getScanStatus/get.ts — GET /rest/getScanStatus.
// Navidrome extras ride along: folderCount, lastScan.
import { ok } from '#opensubsonic/envelope.ts';
import { scanStatusOf } from '#opensubsonic/id3.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (_request: HatRequest, context: HatContext) => {
  return ok(context, { scanStatus: await scanStatusOf(context) });
};
