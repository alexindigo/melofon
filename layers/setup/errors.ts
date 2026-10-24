import { HttpError } from '@pathfinder/pathfinder';

export function fail(status: number, code: string, message: string): never {
  throw new HttpError(status, { code, message });
}
export async function core<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error)) throw error;
    if (error.name === 'SetupError') {
      if (error.code === 'too_many_attempts') {
        throw new HttpError(429, { code: error.code, message: error.message }, {
          'Retry-After': String(
            'retryAfterSeconds' in error ? error.retryAfterSeconds : 1,
          ),
        });
      }
      fail(401, 'invalid_code', 'Invalid setup code');
    }
    if (error.name === 'UserError') {
      if (error.code === 'password_too_short') {
        fail(400, 'password_too_short', 'Password is too short');
      }
      if (error.code === 'name_taken') {
        fail(400, 'invalid_field', 'Username is already taken');
      }
      if (error.code === 'forbidden') {
        fail(401, 'invalid_code', 'Setup has finished');
      }
    }
    throw error;
  }
}
