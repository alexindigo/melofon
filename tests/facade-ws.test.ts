import { assert, assertEquals } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { facade } from '../src/facade.ts';
import { type Layer, loadLayers } from '../src/layers.ts';
import { createNotify } from '../src/notify.ts';
import { apiFixture } from './helpers/api.ts';

async function waitFor(condition: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    assert(Date.now() < deadline, 'socket outcome timeout');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

Deno.test('mounted transport: client echo, query and peer survive every facade path', async () => {
  const app = await pathfinder({ roots: ['tests/fixtures/facade-ws'] });
  const layer = {
    name: 'probe',
    ports: [],
    headers: [],
    mounts: [{ prefix: '/api/v1', app }],
  } as unknown as Layer;
  const server = Deno.serve(
    { hostname: '0.0.0.0', port: 0, onListen() {} },
    facade(app, [layer]),
  );
  try {
    for (
      const path of [
        '/api/v1/events',
        '/_probe/api/v1/events',
        '/_probe/events',
      ]
    ) {
      const ws = new WebSocket(
        `ws://melofon.home:${server.addr.port}${path}?probe=kept`,
      );
      let frame: Record<string, string> | undefined;
      ws.onmessage = (ev) => {
        frame = JSON.parse(String(ev.data));
      };
      try {
        await waitFor(() => ws.readyState === WebSocket.OPEN);
        ws.send('from-client');
        await waitFor(() => frame !== undefined);
        assertEquals(frame!.echo, 'from-client');
        assertEquals(frame!.path, '/events');
        assertEquals(frame!.query, 'kept');
        assert(
          Deno.networkInterfaces().some((nic) => nic.address === frame!.peer),
        );
      } finally {
        ws.close();
        await waitFor(() => ws.readyState === WebSocket.CLOSED);
      }
    }
  } finally {
    await server.shutdown();
  }
});

Deno.test('OwnTone transport: native and forced paths on the 3688 facade carry subscriptions and changes', async () => {
  const f = await apiFixture();
  const notify = createNotify();
  const app = await pathfinder({ roots: ['core/'], app: {} });
  const layers = await loadLayers({
    app: { state: f.state, cfg: f.cfg, notify },
  });
  const server = Deno.serve(
    { hostname: '0.0.0.0', port: 0, onListen() {} },
    facade(app, layers, { listenPort: 3688, defaultPort: 8000 }),
  );
  try {
    for (const path of ['/', '/_owntone/']) {
      const ws = new WebSocket(`ws://melofon.home:${server.addr.port}${path}`, [
        'notify',
      ]);
      const frames: unknown[] = [];
      ws.onmessage = (ev) => frames.push(JSON.parse(String(ev.data)));
      try {
        await waitFor(() => ws.readyState === WebSocket.OPEN);
        assertEquals(ws.protocol, 'notify');
        ws.send(JSON.stringify({ notify: ['player'] }));
        // Emit repeatedly until the inbound subscription is consumed; no ack
        // exists in OwnTone's unchanged wire protocol.
        const deadline = Date.now() + 3000;
        while (!frames.length && Date.now() < deadline) {
          notify.emit(['player']);
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assertEquals(frames[0], { notify: ['player'] });
      } finally {
        ws.close();
        await waitFor(() => ws.readyState === WebSocket.CLOSED);
      }
    }
  } finally {
    await server.shutdown();
    await f.close();
  }
});
