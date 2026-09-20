// tests/raop-ffi.test.ts — the FFI transport end-to-end, all in-process:
// Deno.dlopen loads libmelofon_raop, a fake RAOP device (Deno TCP/UDP, same
// wire shape as helper/raop/test/fake_raop.py) answers RTSP and counts RTP
// packets. start → connected → PCM streams → volume → teardown → stopped.
// Gated on the built library existing, so dev machines without
// `make -C helper/raop` still run the suite green. Sanitizers off: the
// dlopen'd library is process-lifetime by design.
import { assert, assertEquals } from '@std/assert';
import dgram from 'node:dgram';
import { createFfiSpawn } from '../src/boots/raop-ffi.ts';

const LIB_PATH = decodeURIComponent(
  new URL('../helper/raop/libmelofon_raop.so', import.meta.url).pathname,
);
const HAVE_LIB = await Deno.stat(LIB_PATH).then(() => true).catch(() => false);

/** Minimal fake AirPlay 1 device: enough RTSP to get the library streaming,
 * a UDP socket counting RTP audio packets. */
async function startFakeRaop() {
  const state = {
    requests: [] as string[],
    volumeParams: [] as string[],
    flushes: 0,
    teardowns: 0,
    audioPackets: 0,
  };

  const udp = dgram.createSocket('udp4');
  await new Promise<void>((resolve, reject) => {
    udp.once('error', reject);
    udp.bind(0, () => resolve());
  });
  const audioPort = udp.address().port;
  udp.on('message', (msg) => {
    if (msg.length >= 12) state.audioPackets++;
  });

  const tcp = Deno.listen({ port: 0 });
  const port = (tcp.addr as Deno.NetAddr).port;

  const respond = async (conn: Deno.TcpConn) => {
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buf = new Uint8Array(0);
    const readSome = async () => {
      const chunk = new Uint8Array(8192);
      const n = await conn.read(chunk);
      if (n === null) return false;
      const next = new Uint8Array(buf.length + n);
      next.set(buf);
      next.set(chunk.subarray(0, n), buf.length);
      buf = next;
      return true;
    };
    const headerEnd = () => {
      for (let i = 0; i + 3 < buf.length; i++) {
        if (
          buf[i] === 13 && buf[i + 1] === 10 && buf[i + 2] === 13 &&
          buf[i + 3] === 10
        ) return i + 4;
      }
      return -1;
    };
    try {
      for (;;) {
        while (headerEnd() === -1) {
          if (!(await readSome())) return;
        }
        const headLen = headerEnd();
        const head = decoder.decode(buf.subarray(0, headLen));
        const lines = head.split('\r\n');
        const method = lines[0].split(' ')[0];
        const headers = new Map<string, string>();
        for (const line of lines.slice(1)) {
          const idx = line.indexOf(': ');
          if (idx > 0) {
            headers.set(line.slice(0, idx).toLowerCase(), line.slice(idx + 2));
          }
        }
        const clen = Number(headers.get('content-length') ?? '0');
        while (buf.length < headLen + clen) {
          if (!(await readSome())) return;
        }
        const body = decoder.decode(buf.subarray(headLen, headLen + clen));
        buf = buf.subarray(headLen + clen);

        state.requests.push(method);
        if (method === 'SET_PARAMETER' && body.startsWith('volume')) {
          state.volumeParams.push(body.trim());
        }
        if (method === 'FLUSH') state.flushes++;
        if (method === 'TEARDOWN') state.teardowns++;

        const cseq = headers.get('cseq') ?? '0';
        let extra = '';
        if (method === 'OPTIONS') {
          extra =
            'Public: ANNOUNCE, SETUP, RECORD, PAUSE, FLUSH, TEARDOWN, SET_PARAMETER, POST, GET_PARAMETER\r\n';
        } else if (method === 'SETUP') {
          extra =
            `Session: DEADBEEF\r\nTransport: RTP/AVP/UDP;unicast;mode=record;server_port=${audioPort};control_port=${
              audioPort + 1
            };timing_port=${audioPort + 2}\r\n`;
        } else if (method === 'RECORD') {
          extra = 'Audio-Latency: 11025\r\n';
        }
        await conn.write(encoder.encode(
          `RTSP/1.0 200 OK\r\nCSeq: ${cseq}\r\n${extra}Server: fake-raop\r\nContent-Length: 0\r\n\r\n`,
        ));
      }
    } catch { /* client went away */ }
  };
  void (async () => {
    for await (const conn of tcp) void respond(conn);
  })();

  return {
    port,
    state,
    close() {
      try {
        tcp.close();
      } catch { /* already closed */ }
      try {
        udp.close();
      } catch { /* already closed */ }
    },
  };
}

async function until(what: string, fn: () => boolean, timeoutMs = 15000) {
  const deadline = performance.now() + timeoutMs;
  while (!fn()) {
    if (performance.now() > deadline) throw new Error(`timed out: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

Deno.test({
  name: 'FFI transport streams to a fake RAOP device in-process',
  ignore: !HAVE_LIB,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const fake = await startFakeRaop();
    const events: [string, string | undefined][] = [];
    const transport = createFfiSpawn()((event, value) =>
      events.push([event, value])
    );
    try {
      await transport.send({
        cmd: 'start',
        host: '127.0.0.1',
        port: fake.port,
        name: 'FFI smoke',
        volume: 80,
      });
      await until(
        'connected',
        () => events.some(([e, v]) => e === 'state' && v === 'connected'),
      );

      // One second of PCM (silence encodes fine through the ALAC path).
      // The wire — not a 'streaming' event (raop.c raises it only on a
      // timing-dependent status path) — is the honest streaming signal.
      await transport.pcm(new Uint8Array(176400));
      await until('RTP packets arrive', () => fake.state.audioPackets > 100);

      await transport.send({ cmd: 'volume', volume: 42 });
      await transport.send({ cmd: 'teardown' });
      await until(
        'stopped',
        () => events.some(([e, v]) => e === 'state' && v === 'stopped'),
      );

      for (
        const expected of [
          'OPTIONS',
          'ANNOUNCE',
          'SETUP',
          'RECORD',
          'SET_PARAMETER',
          'TEARDOWN',
        ]
      ) {
        assert(
          fake.state.requests.includes(expected),
          `missing RTSP ${expected}: ${fake.state.requests}`,
        );
      }
      assertEquals(fake.state.teardowns, 1);
      assert(
        fake.state.volumeParams.some((v) => v.startsWith('volume: -17.')),
        `volume command missing: ${fake.state.volumeParams}`,
      );
    } finally {
      await transport.close().catch(() => {});
      fake.close();
    }
  },
});
