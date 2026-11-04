import { type Context, HttpError } from '@pathfinder/pathfinder';
import internalError from '#melofon/api/500.ts';

const secretErrors: Record<string, string> = {
  secret_missing: 'MELOFON_SECRET is required for saved speaker credentials',
  secret_unavailable: 'Speaker credential encryption is unavailable',
  invalid_ciphertext: 'Saved speaker credential is malformed',
  unsupported_ciphertext: 'Saved speaker credential version is unsupported',
  authentication_failed:
    'Saved speaker credential could not be authenticated; restore MELOFON_SECRET or re-enter the password/pair again',
};

export default function (_request: unknown, context: Context) {
  const body = context.error instanceof HttpError ? context.error.body : null;
  if (
    body && typeof body === 'object' && 'code' in body &&
    typeof body.code === 'string' && Object.hasOwn(secretErrors, body.code)
  ) {
    return Response.json(
      { code: body.code, message: secretErrors[body.code] },
      {
        status: 500,
        headers: { 'Cache-Control': 'no-store' },
      },
    );
  }
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
