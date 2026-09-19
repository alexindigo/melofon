// layers/owntone/notify/get.ts — GET / on this hat: the OwnTone notify
// websocket (the manifest mounts this folder at '', so the file answers the
// hook's root). No upgrade headers → 404 (the hat serves no Vue). Upgrade
// without an offered `notify` subprotocol → 404 too: nothing else lives
// here, and upgrading would fail RFC overlap at materialize anyway.
//
// Session: the client sends `{ "notify": ["player", …] }` to set its filter
// (invalid JSON is ignored, like OwnTone's process_notify_request returning
// -1 — logged there, dropped here, socket stays); each app.notify event
// whose types intersect the filter goes out as `{ "notify": […] }`.
import type { HatContext, HatRequest } from '#owntone/types.ts';

export default (request: HatRequest, context: HatContext) => {
  const offered = request.headers.get('sec-websocket-protocol') ?? '';
  if (
    request.headers.get('upgrade')?.toLowerCase() !== 'websocket' ||
    !offered.split(',').map((p) => p.trim()).includes('notify')
  ) {
    return new Response(null, { status: 404 });
  }

  const upgrade = request.upgrade({ protocol: 'notify' });
  let filter: string[] = [];
  void upgrade.socket.then((ws) => {
    const unsubscribe = context.app.notify.subscribe((types) => {
      const overlap = types.filter((t) => filter.includes(t));
      if (overlap.length > 0 && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ notify: overlap }));
      }
    });
    ws.onmessage = (ev) => {
      try {
        const data: unknown = JSON.parse(String(ev.data));
        if (
          typeof data === 'object' && data !== null && 'notify' in data &&
          Array.isArray((data as { notify: unknown }).notify)
        ) {
          filter = (data as { notify: unknown[] }).notify.filter(
            (t): t is string => typeof t === 'string',
          );
        }
      } catch {
        // Invalid JSON: dropped, socket stays (OwnTone does the same).
      }
    };
    ws.onclose = () => unsubscribe();
    ws.onerror = () => unsubscribe();
  });
  return upgrade.response;
};
