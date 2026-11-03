import { type Context, HttpError } from '@pathfinder/pathfinder';
import internalError from '#melofon/api/500.ts';

export default function (_request: unknown, context: Context) {
  const body = context.error instanceof HttpError ? context.error.body : null;
  if (
    body && typeof body === 'object' && 'code' in body &&
    body.code === 'persistence_failed'
  ) {
    return Response.json({
      code: 'persistence_failed',
      message: 'Speaker configuration could not be saved',
    }, { status: 500 });
  }
  return internalError();
}
