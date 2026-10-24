import type { HatContext, HatRequest } from '#melofon/types.ts';
export default async function (_request: HatRequest, context: HatContext) {
  return { libraries: await context.app.libraries.list() };
}
