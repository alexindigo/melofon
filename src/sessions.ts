import { createHash } from 'node:crypto';
import { encodeBase64Url } from '@std/encoding/base64url';
import type { Store } from './store/index.ts';
import type { State } from './state.ts';
import { scopedLog } from './logging.ts';
import type { Notify } from './notify.ts';

export interface SessionsEnded {
  userId: string;
  sessionIds: string[];
}

export function createSessions(
  store: Store,
  state: State,
  now: () => number = Date.now,
  notify?: Notify,
) {
  state.declare('auth.sessionIdleDays', {
    type: 'number',
    minimum: 0,
    default: 0,
  });
  state.declare('auth.sessionUpdateSeconds', {
    type: 'integer',
    minimum: 60,
    default: 60,
  });
  const listeners = new Set<(event: SessionsEnded) => void>();
  const log = scopedLog('sessions');
  const hash = (key: string) => createHash('sha256').update(key).digest('hex');
  function ended(event: SessionsEnded) {
    if (!event.sessionIds.length) return;
    for (const fn of [...listeners]) {
      try {
        fn(structuredClone(event));
      } catch (error) {
        log.event('session_listener_failed', { error });
      }
    }
    notify?.emit(['sessions'], { sessions: event.sessionIds }, {
      userId: event.userId,
    });
  }
  async function create(
    userId: string,
    meta: { deviceName: string; userAgent: string },
    passwordEnc?: string,
  ) {
    const key = `mfs_${
      encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)))
    }`;
    const id = crypto.randomUUID();
    const session = await store.sessions.create({
      id,
      userId,
      keyHash: hash(key),
      deviceName: meta.deviceName,
      userAgent: meta.userAgent,
      now: now(),
    }, passwordEnc);
    notify?.emit(['sessions'], { sessions: [id] }, { userId });
    return { id, key, session };
  }
  return {
    create,
    async authenticate(key: string, options: { touch?: boolean } = {}) {
      const idleMs = Number(await state.getTyped('auth.sessionIdleDays')) *
        86400000;
      const intervalMs =
        Number(await state.getTyped('auth.sessionUpdateSeconds')) * 1000;
      const result = await store.sessions.authenticate(
        hash(key),
        now(),
        idleMs,
        intervalMs,
        options.touch !== false,
      );
      if (result.ended) ended(result.ended);
      return result.auth;
    },
    list: store.sessions.list,
    async revoke(caller: string, sessionId: string) {
      ended(await store.sessions.revoke(caller, sessionId));
    },
    async revokeAll(userId: string, caller?: string) {
      ended({
        userId,
        sessionIds: await store.sessions.revokeAll(userId, caller),
      });
    },
    onSessionsEnded(fn: (event: SessionsEnded) => void) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    // Used only by core after a password transaction has committed. Hats get
    // the public port from authentication.ts, never this notification writer.
    ended,
  };
}
export type Sessions = ReturnType<typeof createSessions>;
