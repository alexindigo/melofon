import type { HatContext, HatRequest } from '#melofon/types.ts';
import { fields } from '#melofon/input.ts';
export default async function (_request: HatRequest, context: HatContext) {
  fields(context, []);
  void context.app.scan.start();
  return Response.json({ scan: await context.app.scan.status() }, {
    status: 202,
  });
}
