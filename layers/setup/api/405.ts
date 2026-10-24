import { type Context, HttpError } from '@pathfinder/pathfinder';
export default function (_request: unknown, context: Context) {
  if (context.error instanceof HttpError && context.error.body !== undefined) {
    return Response.json(context.error.body, { status: 405 });
  }
  const allowed = context.miss?.kind === 'method-miss'
    ? context.miss.allowed
    : [];
  return Response.json({
    code: 'method_not_allowed',
    message: 'Method not allowed',
  }, { status: 405, headers: { Allow: allowed.join(', ') } });
}
