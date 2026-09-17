// layers/opensubsonic/rest/startScan/get.ts — GET /rest/startScan.
// fullScan is accepted and ignored: every scan is a full rebuild.
import { ok } from '#opensubsonic/envelope.ts';
import { scanStatusOf } from '#opensubsonic/id3.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (_request: HatRequest, context: HatContext) => {
  void context.app.scan.start(); // answers while the scan runs
  return ok(context, { scanStatus: await scanStatusOf(context) });
};
