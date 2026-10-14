// tests/helpers/fake-raop.ts — a fake AirPlay 1 (RAOP) receiver for tests:
// enough RTSP to get libmelofon_raop streaming, with PER-SESSION accounting
// (plan atv3-session-recycle). Every accepted RTSP connection is its own
// session: its own Session ID (handed out at SETUP), its own UDP endpoints,
// its own request log (method + CSeq + wall-clock ms), its own RTP packet
// counters and first/last timestamps, its own FLUSH/TEARDOWN tallies.
//
// Reply delays (recordDelayMs / teardownDelayMs) expose cleanup overlap: a
// slow old session must not disturb its replacement. All accepted sockets
// are tracked and closed by close(). Nothing here treats the wrapper's
// 'stopped' event as wire proof of a remote teardown — observations are
// packet/request counts on this receiver only.
import dgram from 'node:dgram';

export interface FakeRaopRequest {
  method: string;
  cseq: string;
  atMs: number;
}

export interface FakeRaopSession {
  /** The Session ID this receiver handed the connection at SETUP. */
  id: string;
  requests: FakeRaopRequest[];
  flushes: number;
  teardowns: number;
  volumeParams: string[];
  audioPackets: number;
  firstRtpAtMs: number | null;
  lastRtpAtMs: number | null;
  /** Wall-clock ms when the RTSP connection ended (either side), if yet. */
  closedAtMs: number | null;
}

export interface FakeRaop {
  port: number;
  sessions: FakeRaopSession[];
  close(): void;
}

let sessionSeq = 0;

export function startFakeRaop(
  opts: {
    recordDelayMs?: number;
    teardownDelayMs?: number;
    withholdTeardownReply?: boolean;
    setupDelayMs?: number;
    flushDelayMs?: number;
  } = {},
): Promise<FakeRaop> {
  const sessions: FakeRaopSession[] = [];
  const sockets: { close(): void }[] = [];
  const conns: Deno.TcpConn[] = [];
  const started = performance.now();
  const now = () => performance.now() - started;

  const tcp = Deno.listen({ hostname: '127.0.0.1', port: 0 });
  const port = (tcp.addr as Deno.NetAddr).port;

  const respond = async (conn: Deno.TcpConn) => {
    sessionSeq++;
    const session: FakeRaopSession = {
      id: `FAKE${sessionSeq.toString(16).toUpperCase().padStart(8, '0')}`,
      requests: [],
      flushes: 0,
      teardowns: 0,
      volumeParams: [],
      audioPackets: 0,
      firstRtpAtMs: null,
      lastRtpAtMs: null,
      closedAtMs: null,
    };
    sessions.push(session);

    // This session's own UDP endpoint (control/timing ride the next ports,
    // as on the wire; only the audio socket is actually served).
    const udp = dgram.createSocket('udp4');
    sockets.push(udp);
    await new Promise<void>((resolve, reject) => {
      udp.once('error', reject);
      udp.bind(0, '127.0.0.1', () => resolve());
    });
    const audioPort = udp.address().port;
    udp.on('message', (msg) => {
      if (msg.length < 12) return; // not RTP audio
      session.audioPackets++;
      if (session.firstRtpAtMs === null) session.firstRtpAtMs = now();
      session.lastRtpAtMs = now();
    });

    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buf = new Uint8Array(0);
    const inbox: Uint8Array[] = [];
    let ended = false;
    let wake: (() => void) | undefined;
    // Observe connection closure even while request response handling waits.
    // One socket reader owns all bytes; the RTSP parser consumes its queue.
    void (async () => {
      try {
        for (;;) {
          const chunk = new Uint8Array(8192);
          const n = await conn.read(chunk);
          if (n === null) break;
          inbox.push(chunk.subarray(0, n));
          wake?.();
          wake = undefined;
        }
      } catch {
        /* owned socket closed */
      } finally {
        ended = true;
        session.closedAtMs ??= now();
        wake?.();
        wake = undefined;
      }
    })();
    const readSome = async () => {
      while (!inbox.length && !ended) {
        await new Promise<void>((resolve) => wake = resolve);
      }
      const chunk = inbox.shift();
      if (!chunk) return false;
      const next = new Uint8Array(buf.length + chunk.length);
      next.set(buf);
      next.set(chunk, buf.length);
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

        const cseq = headers.get('cseq') ?? '0';
        session.requests.push({ method, cseq, atMs: now() });
        if (method === 'SET_PARAMETER' && body.startsWith('volume')) {
          session.volumeParams.push(body.trim());
        }
        if (method === 'FLUSH') session.flushes++;
        if (method === 'TEARDOWN') session.teardowns++;
        if (method === 'TEARDOWN' && opts.withholdTeardownReply) continue;
        const delay = method === 'SETUP'
          ? opts.setupDelayMs
          : method === 'FLUSH'
          ? opts.flushDelayMs
          : undefined;
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));

        if (method === 'RECORD' && opts.recordDelayMs !== undefined) {
          await new Promise((resolve) =>
            setTimeout(resolve, opts.recordDelayMs)
          );
        }
        if (method === 'TEARDOWN' && opts.teardownDelayMs !== undefined) {
          await new Promise((resolve) =>
            setTimeout(resolve, opts.teardownDelayMs)
          );
        }

        let extra = '';
        if (method === 'OPTIONS') {
          extra =
            'Public: ANNOUNCE, SETUP, RECORD, PAUSE, FLUSH, TEARDOWN, SET_PARAMETER, POST, GET_PARAMETER\r\n';
        } else if (method === 'SETUP') {
          extra =
            `Session: ${session.id}\r\nTransport: RTP/AVP/UDP;unicast;mode=record;server_port=${audioPort};control_port=${
              audioPort + 1
            };timing_port=${audioPort + 2}\r\n`;
        } else if (method === 'RECORD') {
          extra = 'Audio-Latency: 11025\r\n';
        }
        await conn.write(
          encoder.encode(
            `RTSP/1.0 200 OK\r\nCSeq: ${cseq}\r\n${extra}Server: fake-raop\r\nContent-Length: 0\r\n\r\n`,
          ),
        );
      }
    } catch {
      /* client went away */
    } finally {
      session.closedAtMs ??= now();
      try {
        conn.close();
      } catch { /* already closed */ }
    }
  };

  void (async () => {
    for await (const conn of tcp) {
      conns.push(conn);
      void respond(conn);
    }
  })();

  return Promise.resolve({
    port,
    sessions,
    close() {
      try {
        tcp.close();
      } catch { /* already closed */ }
      for (const conn of conns.splice(0)) {
        try {
          conn.close();
        } catch { /* already closed */ }
      }
      for (const socket of sockets.splice(0)) {
        try {
          socket.close();
        } catch { /* already closed */ }
      }
    },
  });
}
