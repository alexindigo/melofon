import { assertEquals } from '@std/assert';
import { connect } from 'node:net';
import { apiFixture } from './helpers/api.ts';

Deno.test('local-operator API uses a fresh password and rejects a different network peer before dispatch', async () => {
  const f = await apiFixture({ localOperator: true });
  try {
    const shared = await f.json('/api/v1/session', 'POST', {
      username: 'admin',
      password: 'password-admin',
      use: 'bearer',
    });
    assertEquals(shared.status, 401);
    await shared.body?.cancel();
    const { credential } = await f.login('bearer');
    const url = new URL(f.origin);
    const host = (await Deno.resolveDns(url.hostname, 'A'))[0];
    const response = await new Promise<string>((resolve, reject) => {
      const socket = connect({
        host,
        port: Number(url.port),
        localAddress: '127.0.0.1',
      });
      let output = '';
      socket.setEncoding('utf8');
      socket.setTimeout(
        5000,
        () => socket.destroy(new Error('peer gate stalled')),
      );
      socket.on('error', reject);
      socket.on('data', (chunk) => output += chunk);
      socket.on('end', () => resolve(output));
      socket.on('connect', () => {
        socket.write(
          `GET /api/v1/me HTTP/1.1\r\nHost: ${url.host}\r\nAuthorization: Bearer ${credential}\r\nX-Forwarded-For: ${host}\r\nConnection: close\r\n\r\n`,
        );
      });
    });
    assertEquals(response.split('\r\n')[0], 'HTTP/1.1 403 Forbidden');
    const me = await f.get('/api/v1/me', credential);
    assertEquals(me.status, 200);
    await me.body?.cancel();
  } finally {
    await f.close();
  }
});
