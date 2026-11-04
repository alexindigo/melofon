// Independent wire clients characterize the opt-in fixture, not the future
// credential ABI. No product password/PIN support is implied by these tests.
import { assert, assertEquals } from '@std/assert';
import { createHash } from 'node:crypto';
import dgram from 'node:dgram';
import { startFakeRaop } from './helpers/fake-raop.ts';

const password = 'fixture-password';

async function client(port: number) {
  const conn = await Deno.connect({ hostname: '127.0.0.1', port });
  let cseq = 0;
  let buffered = '';
  const decoder = new TextDecoder();
  return {
    close: () => conn.close(),
    async request(
      method: string,
      uri: string,
      auth = '',
      extra = '',
      body = '',
    ) {
      const timer = setTimeout(() => conn.close(), 5000);
      try {
        const bytes = new TextEncoder().encode(
          `${method} ${uri} RTSP/1.0\r\nCSeq: ${++cseq}\r\n${
            auth ? `Authorization: ${auth}\r\n` : ''
          }${extra}Content-Length: ${
            new TextEncoder().encode(body).length
          }\r\n\r\n${body}`,
        );
        for (let sent = 0; sent < bytes.length;) {
          sent += await conn.write(bytes.subarray(sent));
        }
        while (!buffered.includes('\r\n\r\n')) {
          const chunk = new Uint8Array(4096);
          const n = await conn.read(chunk);
          assert(n !== null, 'RTSP response must arrive');
          buffered += decoder.decode(chunk.subarray(0, n));
        }
        const end = buffered.indexOf('\r\n\r\n');
        const [status, ...lines] = buffered.slice(0, end).split('\r\n');
        buffered = buffered.slice(end + 4);
        const headers = new Map(lines.map((line) => {
          const i = line.indexOf(': ');
          return [line.slice(0, i).toLowerCase(), line.slice(i + 2)];
        }));
        assertEquals(headers.get('cseq'), String(cseq));
        return { status: Number(status.split(' ')[1]), headers };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

async function challenge(c: Awaited<ReturnType<typeof client>>) {
  const reply = await c.request('OPTIONS', '*');
  assertEquals(reply.status, 401);
  const value = reply.headers.get('www-authenticate')!;
  assert(value.startsWith('Digest '));
  const realm = /realm="([^"]+)"/.exec(value)![1];
  const nonce = /nonce="([^"]+)"/.exec(value)![1];
  assert(/^[a-f0-9]{32}$/.test(nonce));
  return { realm, nonce };
}

// This client constructs the legacy digest independently from the fixture.
function authorization(
  facts: { realm: string; nonce: string },
  method: string,
  uri: string,
  secret = password,
  username = '',
  changes: Record<string, string> = {},
) {
  const hash = (text: string) => {
    const result = createHash('md5').update(text).digest('hex');
    return username === 'iTunes' ? result.toUpperCase() : result;
  };
  const a1 = hash([username, facts.realm, secret].join(':'));
  const a2 = hash([method, uri].join(':'));
  const fields = {
    username,
    ...facts,
    uri,
    response: hash([a1, facts.nonce, a2].join(':')),
    ...changes,
  };
  return 'Digest ' +
    Object.entries(fields).map(([k, v]) => `${k}="${v}"`).join(', ');
}

async function until(predicate: () => boolean) {
  const deadline = performance.now() + 3000;
  while (!predicate()) {
    assert(performance.now() < deadline, 'receiver observation timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

Deno.test('fake RAOP digest rejects absent, malformed and mismatched request credentials', async () => {
  const fake = await startFakeRaop({ digest: { password } });
  const c = await client(fake.port);
  try {
    const facts = await challenge(c);
    const uri = `rtsp://127.0.0.1:${fake.port}/fixture`;
    const good = authorization(facts, 'RECORD', uri);
    const bad = [
      '',
      'Basic nonsense',
      'Digest nonsense',
      authorization(facts, 'RECORD', uri, 'wrong'),
      authorization(facts, 'OPTIONS', uri),
      authorization(facts, 'RECORD', uri, password, '', { realm: 'wrong' }),
      authorization(facts, 'RECORD', uri, password, '', { nonce: 'stale' }),
      authorization(facts, 'RECORD', uri, password, '', {
        uri: 'rtsp://wrong',
      }),
      `${good}, nonce="duplicate"`,
      `${good}, qop="auth"`,
      `${good},`,
      good.replace(/response="[^"]+"/, 'response="junk"'),
    ];
    for (const auth of bad) {
      assertEquals((await c.request('RECORD', uri, auth)).status, 401);
    }
    assertEquals(
      (await c.request('ANNOUNCE', uri, '', '', 'untrusted SDP')).status,
      401,
    );
    assertEquals(
      (await c.request('SET_PARAMETER', uri, '', '', 'volume: -6')).status,
      401,
    );
    assertEquals((await c.request('FLUSH', uri)).status, 401);
    assertEquals((await c.request('TEARDOWN', uri)).status, 401);
    const s = fake.sessions[0];
    assertEquals(s.acceptedRequests, []);
    assertEquals(s.authChallenges, bad.length + 5);
    assertEquals(s.sdp, '');
    assertEquals(s.parameters, []);
    assertEquals(s.volumeParams, []);
    assertEquals(s.flushes, 0);
    assertEquals(s.teardowns, 0);
    assertEquals(s.audioPackets, 0);
  } finally {
    c.close();
    fake.close();
  }
});

Deno.test('fake RAOP digest admits genuine request hashes and gates RTP on authorized RECORD', async () => {
  for (const username of ['', 'iTunes']) {
    const fake = await startFakeRaop({
      digest: { password },
      captureAudio: true,
    });
    const c = await client(fake.port);
    const udp = dgram.createSocket('udp4');
    try {
      const facts = await challenge(c);
      const uri = `rtsp://127.0.0.1:${fake.port}/fixture`;
      const auth = (method: string, target = uri) =>
        authorization(facts, method, target, password, username);
      assertEquals(
        (await c.request('OPTIONS', '*', auth('OPTIONS', '*'))).status,
        200,
      );
      assertEquals(
        (await c.request('ANNOUNCE', uri, auth('ANNOUNCE'), '', 'fixture SDP'))
          .status,
        200,
      );
      const setup = await c.request(
        'SETUP',
        uri,
        auth('SETUP'),
        'Transport: RTP/AVP/UDP;control_port=9;timing_port=9\r\n',
      );
      assertEquals(setup.status, 200);
      const port = Number(
        /server_port=(\d+)/.exec(setup.headers.get('transport')!)![1],
      );
      const packet = new Uint8Array([
        0x80,
        96,
        0,
        1,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        1,
        7,
      ]);
      const send = () =>
        new Promise<void>((resolve, reject) =>
          udp.send(
            packet,
            port,
            '127.0.0.1',
            (err) => err ? reject(err) : resolve(),
          )
        );
      // SETUP/previous valid requests are not an authentication latch.
      assertEquals(
        (await c.request('RECORD', uri, auth('OPTIONS'))).status,
        401,
      );
      await send();
      await new Promise((resolve) => setTimeout(resolve, 40));
      assertEquals(fake.sessions[0].audioPackets, 0);
      assertEquals(
        (await c.request('RECORD', uri, auth('RECORD'))).status,
        200,
      );
      await send();
      await until(() => fake.sessions[0].audioPackets === 1);
      assertEquals(fake.sessions[0].audioPayloads, [new Uint8Array([7])]);
      assertEquals(
        (await c.request(
          'SET_PARAMETER',
          uri,
          auth('RECORD'),
          '',
          'volume: -6',
        )).status,
        401,
      );
      assertEquals(fake.sessions[0].volumeParams, []);
      assertEquals(
        (await c.request(
          'SET_PARAMETER',
          uri,
          auth('SET_PARAMETER'),
          '',
          'volume: -6',
        )).status,
        200,
      );
      assertEquals(
        (await c.request('TEARDOWN', uri, auth('TEARDOWN'))).status,
        200,
      );
      await send();
      await new Promise((resolve) => setTimeout(resolve, 40));
      const s = fake.sessions[0];
      assertEquals(s.audioPackets, 1);
      assertEquals(s.volumeParams, ['volume: -6']);
      assertEquals(s.acceptedRequests, [
        'OPTIONS',
        'ANNOUNCE',
        'SETUP',
        'RECORD',
        'SET_PARAMETER',
        'TEARDOWN',
      ]);
    } finally {
      udp.close();
      c.close();
      fake.close();
    }
  }
});

Deno.test('fake RAOP digest nonce belongs to its connection and receiver password', async () => {
  const a = await startFakeRaop({ digest: { password } });
  const b = await startFakeRaop({ digest: { password: 'different' } });
  const first = await client(a.port);
  const second = await client(a.port);
  const other = await client(b.port);
  try {
    const f1 = await challenge(first);
    const f2 = await challenge(second);
    const f3 = await challenge(other);
    assert(f1.nonce !== f2.nonce && f2.nonce !== f3.nonce);
    const replay = authorization(f1, 'OPTIONS', '*');
    assertEquals((await second.request('OPTIONS', '*', replay)).status, 401);
    assertEquals(
      (await other.request('OPTIONS', '*', authorization(f3, 'OPTIONS', '*')))
        .status,
      401,
    );
    assertEquals((await first.request('OPTIONS', '*', replay)).status, 200);
    assertEquals(
      (await second.request('OPTIONS', '*', authorization(f2, 'OPTIONS', '*')))
        .status,
      200,
    );
    assertEquals(
      (await other.request(
        'OPTIONS',
        '*',
        authorization(f3, 'OPTIONS', '*', 'different'),
      )).status,
      200,
    );
    assertEquals(a.sessions.map((s) => s.audioPackets), [0, 0]);
    assertEquals(b.sessions[0].audioPackets, 0);
  } finally {
    first.close();
    second.close();
    other.close();
    a.close();
    b.close();
  }
});
