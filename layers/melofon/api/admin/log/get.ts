import type { HatContext, HatRequest, LogQuery } from '#melofon/types.ts';
import { core, fail } from '#melofon/errors.ts';
export default async function (request: HatRequest, context: HatContext) {
  const params = new URL(request._raw.url).searchParams;
  for (const key of params.keys()) {
    if (
      !['after', 'level', 'component', 'limit'].includes(key) ||
      params.getAll(key).length !== 1
    ) {
      fail(400, 'invalid_field', 'Unknown or repeated log parameter');
    }
  }
  const integer = (key: string, fallback: number, max: number) => {
    const raw = params.get(key);
    if (raw === null) return fallback;
    const n = Number(raw);
    if (
      !/^\d+$/.test(raw) || !Number.isSafeInteger(n) ||
      n < (key === 'after' ? 0 : 1) || n > max
    ) {
      fail(400, 'invalid_field', `Invalid ${key}`);
    }
    return n;
  };
  const level = params.get('level');
  if (
    level !== null &&
    !['debug', 'info', 'notice', 'warn', 'error', 'fatal'].includes(level)
  ) {
    fail(400, 'invalid_field', 'Invalid level');
  }
  const component = params.get('component');
  if (component !== null && !/^[a-zA-Z0-9_.:-]+$/.test(component)) {
    fail(400, 'invalid_field', 'Invalid component');
  }
  const query: LogQuery = {
    after: integer('after', 0, 9007199254740991),
    limit: integer(
      'limit',
      Number(await context.app.state.getTyped('melofon.logPageRecords')),
      1000,
    ),
    ...(level === null ? {} : { level: level as LogQuery['level'] }),
    ...(component === null ? {} : { component }),
  };
  return core(() => context.app.server.log(context.state.user.id, query));
}
