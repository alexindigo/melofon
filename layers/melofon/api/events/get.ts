import type { HatContext, HatRequest } from '#melofon/types.ts';
import { sessionKey } from '#melofon/auth.ts';
import { checkOrigin } from '#melofon/origin.ts';
import { fail } from '#melofon/errors.ts';

type Ids = string[] | '*';

export default async function (request: HatRequest, context: HatContext) {
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    fail(400, 'upgrade_required', 'WebSocket upgrade required');
  }
  await checkOrigin(request, context);
  const { sessions, notify, state } = context.app;
  const key = sessionKey(request)!;
  const { sessionId, user } = context.state;
  const heartbeatMs = Number(await state.getTyped('melofon.eventsHeartbeatMs'));
  const maxIds = Number(await state.getTyped('melofon.eventsMaxIds'));
  const drainMs = Number(await state.getTyped('melofon.eventsDrainMs'));
  let socket: WebSocket | undefined;
  let closed = false;
  let ready = false;
  let scheduled = false;
  let sending = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const pending = new Map<string, Ids>();
  // Keep restricted ids separate until the fresh send-time role check. A
  // public and admin emit of the same name must not change each other's access.
  const adminPending = new Map<string, Ids>();
  const hasPending = () => pending.size > 0 || adminPending.size > 0;
  let unsubscribe = () => {};
  let unend = () => {};
  function cleanup() {
    closed = true;
    pending.clear();
    adminPending.clear();
    clearInterval(heartbeat);
    clearTimeout(retry);
    unsubscribe();
    unend();
  }
  function signedOut() {
    cleanup();
    if (socket?.readyState === WebSocket.OPEN) {
      socket.close(4401, 'signed_out');
    }
  }
  async function current() {
    const auth = await sessions.authenticate(key, { touch: false });
    if (!auth || auth.sessionId !== sessionId) {
      signedOut();
      return null;
    }
    return closed ? null : auth;
  }
  function schedule() {
    if (!ready || closed || scheduled || sending || retry !== undefined) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      void flush();
    });
  }
  function waitForDrain() {
    if (retry !== undefined || closed) return;
    retry = setTimeout(() => {
      retry = undefined;
      schedule();
    }, drainMs);
  }
  function merge(target: Map<string, Ids>, name: string, incoming: Ids) {
    const previous = target.get(name);
    // [] invalidates the entire collection and dominates narrower changes.
    if (previous === '*' || previous?.length === 0) return;
    if (incoming === '*' || !incoming.length) target.set(name, incoming);
    else {
      const merged = [...new Set([...(previous ?? []), ...incoming])];
      target.set(name, merged.length > maxIds ? '*' : merged);
    }
  }
  async function flush() {
    if (closed || !socket || !hasPending()) return;
    // One bounded accumulator, not a queue of frames/promises. Keep merging
    // while output drains or the single fresh-auth read is in flight.
    if (socket.bufferedAmount > 0) {
      waitForDrain();
      return;
    }
    sending = true;
    try {
      const auth = await current();
      if (!auth || socket.readyState !== WebSocket.OPEN) return;
      if (auth.user.role === 'admin') {
        for (const [name, ids] of adminPending) merge(pending, name, ids);
      }
      const events = Object.fromEntries(pending);
      pending.clear();
      adminPending.clear();
      if (Object.keys(events).length) {
        socket.send(JSON.stringify({ type: 'changed', events }));
      }
    } catch {
      signedOut();
    } finally {
      sending = false;
      if (hasPending()) schedule();
    }
  }
  unsubscribe = notify.subscribe((names, ids, audience) => {
    if (closed) return;
    if (
      audience !== 'all' && audience !== 'admins' &&
      audience?.userId !== user.id
    ) return;
    const target = audience === 'admins' ? adminPending : pending;
    for (const name of names) {
      merge(target, name === 'outputs' ? 'speakers' : name, ids?.[name] ?? []);
    }
    if (hasPending()) schedule();
  });
  unend = sessions.onSessionsEnded((event) => {
    if (event.sessionIds.includes(sessionId)) signedOut();
  });
  try {
    const upgrade = request.upgrade({}); // Keep Deno's default idleTimeout on.
    void upgrade.socket.then((ws) => {
      socket = ws;
      ws.onclose = cleanup;
      ws.onerror = cleanup;
      ws.onopen = () => {
        void (async () => {
          if (closed) {
            ws.close(4401, 'signed_out');
            return;
          }
          if (!await current()) return;
          ws.send(JSON.stringify({
            type: 'hello',
            version: 1,
            heartbeatMs,
            bootId: notify.bootId,
          }));
          ready = true;
          schedule();
          let checking = false;
          heartbeat = setInterval(() => {
            if (closed || checking) return;
            checking = true;
            void current().then((auth) => {
              if (
                auth && ws.readyState === WebSocket.OPEN &&
                ws.bufferedAmount === 0
              ) {
                ws.send(JSON.stringify({ type: 'ping' }));
              }
            }).catch(signedOut).finally(() => {
              checking = false;
            });
          }, heartbeatMs);
        })().catch(signedOut);
      };
    }).catch(cleanup);
    return upgrade.response;
  } catch (error) {
    cleanup();
    throw error;
  }
}
