import { HttpError } from '@pathfinder/pathfinder';

export function fail(status: number, code: string, message: string): never {
  throw new HttpError(status, { code, message });
}

/** Translate only the public core failures; unexpected failures stay generic 500s. */
export async function core<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error)) throw error;
    const code = error.code;
    if (error.name === 'SettingsError') {
      const status = code === 'revision_conflict' ? 409 : 400;
      throw new HttpError(status, {
        code,
        message: error.message,
        ...('key' in error && error.key !== undefined
          ? { key: error.key }
          : {}),
        ...('revisions' in error && error.revisions !== undefined
          ? { revisions: error.revisions }
          : {}),
      });
    }
    if (error.name === 'SignInError' && code === 'too_many_attempts') {
      const seconds = 'retryAfterSeconds' in error
        ? error.retryAfterSeconds
        : undefined;
      throw new HttpError(429, { code, message: 'Too many sign-in attempts' }, {
        'Retry-After': String(seconds),
      });
    }
    if (
      error.name !== 'UserError' && error.name !== 'SignInError' &&
      error.name !== 'HatServiceError'
    ) throw error;
    switch (code) {
      case 'invalid_credentials':
        fail(401, code, 'Wrong username or password');
        break;
      case 'forbidden':
        fail(403, code, 'Forbidden');
        break;
      case 'not_found':
        fail(404, code, 'Not found');
        break;
      case 'name_taken':
        fail(409, code, 'Username is already taken');
        break;
      case 'hat_failed':
      case 'hat_reserved':
      case 'hat_self':
      case 'activation_failed':
        fail(409, code, error.message);
        break;
      case 'last_admin':
        fail(409, code, 'The last admin cannot be demoted');
        break;
      case 'password_too_short':
        fail(400, code, 'Password is too short');
        break;
      default:
        throw error;
    }
  }
}
