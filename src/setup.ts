import { equalCredentials } from './password-crypto.ts';
import { createSignInLimiter } from './signin-limiter.ts';
import type { State } from './state.ts';
import { type Log, scopedLog } from './logging.ts';
import type { createUsers } from './users.ts';

export class SetupError extends Error {
  constructor(
    public readonly code: 'invalid_code' | 'too_many_attempts',
    public readonly retryAfterSeconds?: number,
  ) {
    super(
      code === 'invalid_code'
        ? 'Invalid setup code'
        : 'Too many setup attempts',
    );
    this.name = 'SetupError';
  }
}

/** Startup-scoped capability, injected only into setup-marked hats. */
export function createSetup(options: {
  users: Pick<ReturnType<typeof createUsers>, 'createFirstAdmin'>;
  state: State;
  restartAfter(completed: Promise<void>): void;
  log?: Log;
  now?: () => number;
}) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const random = crypto.getRandomValues(new Uint8Array(12));
  let code: string | undefined = Array.from(
    random,
    (byte) => alphabet[byte % alphabet.length],
  ).join('').match(/.{4}/g)!.join('-');
  const limiter = createSignInLimiter(options.state, options.now);
  let tail: Promise<unknown> = Promise.resolve();
  (options.log ?? scopedLog('setup')).event('setup_code', { code });
  return Object.freeze({
    create(
      input: {
        code: string;
        username: string;
        password: string;
        displayName?: string;
      },
      address: string,
      completed: Promise<void>,
    ) {
      const operation = tail.then(async () => {
        const wait = limiter.remaining('setup', address);
        if (wait) throw new SetupError('too_many_attempts', wait);
        const matches = equalCredentials(input.code, code ?? '');
        if (!matches || code === undefined) {
          await limiter.failure('setup', address);
          throw new SetupError('invalid_code');
        }
        const { code: _code, ...details } = input;
        const user = await options.users.createFirstAdmin(details);
        code = undefined;
        limiter.success('setup', address);
        options.restartAfter(completed);
        return user;
      });
      tail = operation.catch(() => {});
      return operation;
    },
  });
}
