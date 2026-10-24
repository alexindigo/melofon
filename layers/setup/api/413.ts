import { type Context, HttpError } from '@pathfinder/pathfinder';
export default function (_request: unknown, context: Context) {
  return Response.json(
    context.error instanceof HttpError && context.error.body !== undefined
      ? context.error.body
      : { code: 'too_large', message: 'Request body is too large' },
    { status: 413 },
  );
}
