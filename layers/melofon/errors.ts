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
    if (error.name === 'PlayerError') {
      fail(
        code === 'not_found'
          ? 404
          : code === 'invalid_name' || code === 'same_player'
          ? 400
          : code === 'closed'
          ? 503
          : 409,
        String(code),
        error.message,
      );
    }
    if (error.name === 'PlaybackError') {
      throw new HttpError(
        code === 'airplay_busy'
          ? 409
          : code === 'missing_reference' || code === 'missing_entry'
          ? 404
          : code === 'invalid_reference'
          ? 400
          : 409,
        {
          code,
          message: error.message,
          ...(code === 'airplay_busy' && 'owner' in error
            ? { owner: error.owner }
            : {}),
          ...(code === 'queue_limit' && 'limit' in error
            ? { limit: error.limit }
            : {}),
          ...(code === 'queue_conflict' && 'version' in error
            ? { version: error.version }
            : {}),
        },
      );
    }
    if (error.name === 'HlsError') {
      fail(400, String(code), error.message);
    }
    if (error.name === 'SecretError') {
      fail(500, String(code), error.message);
    }
    if (error.name === 'SpeakerError') {
      fail(
        code === 'not_found'
          ? 404
          : code === 'not_adopted' || code === 'already_adopted' ||
              code === 'speaker_in_use' || code === 'speaker_busy' ||
              code === 'pairing_required'
          ? 409
          : code === 'persistence_failed'
          ? 500
          : 400,
        String(code),
        error.message,
      );
    }
    if (error.name === 'StreamError') {
      fail(
        code === 'incompatible_media' ? 422 : 500,
        String(code),
        error.message,
      );
    }
    if (error.name === 'CapabilityError') {
      fail(code === 'too_large' ? 413 : 400, String(code), error.message);
    }
    if (error.name === 'PluginError') {
      fail(code === 'not_found' ? 404 : 400, String(code), error.message);
    }
    if (error.name === 'LibraryError') {
      fail(code === 'not_found' ? 404 : 400, String(code), error.message);
    }
    if (error.name === 'SettingsError' || error.name === 'PreferenceError') {
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
