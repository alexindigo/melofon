import type { Config } from './config.ts';
import type { Store } from './store/index.ts';
import type { State } from './state.ts';
import { createPasswordVerifier } from './password-verifier.ts';
import { createSessions } from './sessions.ts';
import { createUsers, UserError } from './users.ts';
import { createUserService } from './user.ts';
import { createSignInLimiter } from './signin-limiter.ts';
import type { Notify } from './notify.ts';

export class SignInError extends Error {
  constructor(
    public readonly code: 'invalid_credentials' | 'too_many_attempts',
    public readonly retryAfterSeconds?: number,
  ) {
    super(
      code === 'invalid_credentials'
        ? 'Wrong username or password'
        : 'Too many sign-in attempts',
    );
    this.name = 'SignInError';
  }
}

/** Composition shared by native hats and the legacy protocol adapter. */
export function createAuthentication(
  store: Store,
  cfg: Config,
  state: State,
  now: () => number = Date.now,
  notify?: Notify,
) {
  const verifier = createPasswordVerifier(store, cfg);
  const sessions = createSessions(store, state, now, notify);
  const users = createUsers(store, {
    cfg,
    verifier,
    sessions,
    state,
    now,
    notify,
  });
  const limiter = createSignInLimiter(state, now);
  // Same-key attempts are serialized through verification and outcome, so a
  // concurrent batch cannot all pass the lockout check before failure #10.
  const pending = new Map<string, Promise<unknown>>();
  function signIn(
    input: {
      username: string;
      password: string;
      clientAddress: string;
      deviceName: string;
      userAgent: string;
    },
  ) {
    const key = JSON.stringify([
      input.username.toLowerCase(),
      input.clientAddress,
    ]);
    const operation = (pending.get(key) ?? Promise.resolve()).catch(() => {})
      .then(async () => {
        const wait = limiter.remaining(input.username, input.clientAddress);
        if (wait) throw new SignInError('too_many_attempts', wait);
        const proof = await verifier({ username: input.username }, {
          password: input.password,
        });
        if (!proof) {
          await limiter.failure(input.username, input.clientAddress);
          throw new SignInError('invalid_credentials');
        }
        try {
          const created = await sessions.create(
            proof.user.id,
            input,
            proof.passwordEnc,
          );
          limiter.success(input.username, input.clientAddress);
          return { session: created.session, key: created.key };
        } catch (error) {
          if (
            error instanceof UserError && error.code === 'invalid_credentials'
          ) throw new SignInError('invalid_credentials');
          throw error;
        }
      });
    pending.set(key, operation);
    void operation.finally(() => {
      if (pending.get(key) === operation) pending.delete(key);
    }).catch(() => {});
    return operation;
  }
  return {
    users,
    user: createUserService(store, cfg, {
      verifier,
      noteAccess: users.noteAccess,
    }),
    signIn,
    // Privileged primitives (create/revokeAll/ended) stay core-only. Public
    // operations accept the caller ID and enforce ownership themselves.
    sessions: {
      authenticate: sessions.authenticate,
      list(caller: string, target = caller) {
        return sessions.list(target, caller);
      },
      revoke: sessions.revoke,
      async revokeAll(caller: string, target = caller) {
        await sessions.revokeAll(target, caller);
      },
      onSessionsEnded: sessions.onSessionsEnded,
    },
  };
}
