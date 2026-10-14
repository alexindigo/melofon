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
  sdp: string;
  parameters: { contentType: string; body: Uint8Array; atMs: number }[];
  audioPayloads: Uint8Array[];
  rtspPeer: { address: string; port: number };
  rtpSenders: { address: string; port: number; atMs: number }[];
  controlSenders: { address: string; port: number; atMs: number }[];
  timingSenders: { address: string; port: number; atMs: number }[];
  rtpSequences: number[];
}

export interface FakeRaop {
  port: number;
  sessions: FakeRaopSession[];
  close(): void;
  requestRetransmit(id: string): void;
}

let sessionSeq = 0;

export function startFakeRaop(
  opts: {
    recordDelayMs?: number;
    teardownDelayMs?: number;
    withholdTeardownReply?: boolean;
    setupDelayMs?: number;
    flushDelayMs?: number;
    captureAudio?: boolean;
    bindAddress?: string;
    probeChannels?: boolean;
  } = {},
): Promise<FakeRaop> {
  const sessions: FakeRaopSession[] = [];
  const sockets: { close(): void }[] = [];
  const conns: Deno.TcpConn[] = [];
  const timers: ReturnType<typeof setInterval>[] = [];
  const retransmits = new Map<string, () => void>();
  const bindAddress = opts.bindAddress ?? '127.0.0.1';
  const started = performance.now();
  const now = () => performance.now() - started;

  const tcp = Deno.listen({ hostname: bindAddress, port: 0 });
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
      sdp: '',
      parameters: [],
      audioPayloads: [],
      rtspPeer: {
        address: conn.remoteAddr.hostname,
        port: conn.remoteAddr.port,
      },
      rtpSenders: [],
      controlSenders: [],
      timingSenders: [],
      rtpSequences: [],
    };
    sessions.push(session);

    // All advertised endpoints are actually owned, independently bound sockets.
    const bindUdp = async () => {
      const socket = dgram.createSocket('udp4');
      sockets.push(socket);
      await new Promise<void>((resolve, reject) => {
        socket.once('error', reject);
        socket.bind(0, bindAddress, resolve);
      });
      return socket;
    };
    const udp = await bindUdp();
    const control = await bindUdp();
    const timing = await bindUdp();
    const recordPeer = (
      observations: FakeRaopSession['rtpSenders'],
      peer: dgram.RemoteInfo,
    ) => {
      const last = observations.at(-1);
      if (!last || last.address !== peer.address || last.port !== peer.port) {
        observations.push({
          address: peer.address,
          port: peer.port,
          atMs: now(),
        });
      }
    };
    control.on(
      'message',
      (_msg, peer) => recordPeer(session.controlSenders, peer),
    );
    timing.on(
      'message',
      (_msg, peer) => recordPeer(session.timingSenders, peer),
    );
    const audioPort = udp.address().port;
    udp.on('message', (msg, peer) => {
      if (msg.length < 12 || (msg[1] & 0x7f) !== 96) return;
      recordPeer(session.rtpSenders, peer);
      session.audioPackets++;
      if (session.firstRtpAtMs === null) session.firstRtpAtMs = now();
      session.lastRtpAtMs = now();
      if (opts.captureAudio && session.audioPayloads.length < 8192) {
        session.audioPayloads.push(Uint8Array.from(msg.subarray(12)));
        session.rtpSequences.push(msg.readUInt16BE(2));
      }
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
        const bodyBytes = Uint8Array.from(
          buf.subarray(headLen, headLen + clen),
        );
        const body = decoder.decode(bodyBytes);
        buf = buf.subarray(headLen + clen);

        const cseq = headers.get('cseq') ?? '0';
        session.requests.push({ method, cseq, atMs: now() });
        if (method === 'ANNOUNCE') session.sdp = body;
        if (method === 'SET_PARAMETER') {
          session.parameters.push({
            contentType: headers.get('content-type') ?? '',
            body: bodyBytes,
            atMs: now(),
          });
        }
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
          const transport = headers.get('transport') ?? '';
          const controlPort = Number(
            transport.match(/control_port=(\d+)/)?.[1],
          );
          const timingPort = Number(transport.match(/timing_port=(\d+)/)?.[1]);
          retransmits.set(session.id, () => {
            const sequence = session.rtpSequences.at(-1);
            if (!controlPort || sequence === undefined) return;
            const request = new Uint8Array([0x80, 0xd5, 0, 1, 0, 0, 0, 1]);
            new DataView(request.buffer).setUint16(4, sequence);
            control.send(request, controlPort, session.rtspPeer.address);
          });
          if (opts.probeChannels && timingPort) {
            const sample = () => {
              const request = new Uint8Array(32);
              request.set([0x80, 0xd2, 0, 1]);
              timing.send(request, timingPort, session.rtspPeer.address);
            };
            sample();
            timers.push(setInterval(sample, 500));
          }
          extra =
            `Session: ${session.id}\r\nTransport: RTP/AVP/UDP;unicast;mode=record;server_port=${audioPort};control_port=${control.address().port};timing_port=${timing.address().port}\r\n`;
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
    requestRetransmit(id) {
      retransmits.get(id)?.();
    },
    close() {
      for (const timer of timers.splice(0)) clearInterval(timer);
      retransmits.clear();
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
