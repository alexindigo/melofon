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
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

// RAOP no-qop MD5, including OwnTone's iTunes uppercase intermediate hashes.
// Validate every field against the actual request before any session effects.
function validDigest(
  value: string,
  password: string,
  realm: string,
  nonce: string,
  method: string,
  uri: string,
): boolean {
  if (!value.startsWith('Digest ')) return false;
  const fields = new Map<string, string>();
  let rest = value.slice(7);
  while (rest) {
    const match = /^\s*(\w+)="([^"\\\r\n]*)"\s*(,\s*|$)/.exec(rest);
    if (!match || fields.has(match[1])) return false;
    fields.set(match[1], match[2]);
    rest = rest.slice(match[0].length);
    if (match[3] && !rest) return false;
  }
  const username = fields.get('username');
  if (
    fields.size !== 5 || (username !== '' && username !== 'iTunes') ||
    fields.get('realm') !== realm || fields.get('nonce') !== nonce ||
    fields.get('uri') !== uri ||
    !/^[a-fA-F0-9]{32}$/.test(fields.get('response') ?? '')
  ) return false;
  const md5 = (text: string) => {
    const hash = createHash('md5').update(text).digest('hex');
    return username === 'iTunes' ? hash.toUpperCase() : hash;
  };
  const expected = md5(
    `${md5(`${username}:${realm}:${password}`)}:${nonce}:${
      md5(`${method}:${uri}`)
    }`,
  );
  return timingSafeEqual(
    new TextEncoder().encode(fields.get('response')!),
    new TextEncoder().encode(expected),
  );
}

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
  /** Methods that passed the optional digest barrier; never stores headers. */
  acceptedRequests: string[];
  authChallenges: number;
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
    flushDelayMs?: number;
    captureAudio?: boolean;
    refuseRecord?: () => boolean;
    digest?: { password: string; realm?: string };
  } = {},
): Promise<FakeRaop> {
  const sessions: FakeRaopSession[] = [];
  const sockets: { close(): void }[] = [];
  const conns: Deno.TcpConn[] = [];
  const retransmits = new Map<string, () => void>();
  const bindAddress = '127.0.0.1';
  const started = performance.now();
  const now = () => performance.now() - started;
  const realm = opts.digest?.realm ?? 'Fake RAOP';
  if (/[\r\n"\\]/.test(realm)) throw new Error('invalid fake digest realm');

  const tcp = Deno.listen({ hostname: bindAddress, port: 0 });
  const port = (tcp.addr as Deno.NetAddr).port;

  const respond = async (conn: Deno.TcpConn) => {
    const nonce = randomBytes(16).toString('hex');
    let recording = false;
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
      acceptedRequests: [],
      authChallenges: 0,
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
      if (opts.digest && !recording) return;
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
        const [method, uri] = lines[0].split(' ');
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
        if (
          opts.digest && !validDigest(
            headers.get('authorization') ?? '',
            opts.digest.password,
            realm,
            nonce,
            method,
            uri,
          )
        ) {
          session.authChallenges++;
          await conn.write(encoder.encode(
            `RTSP/1.0 401 Unauthorized\r\nCSeq: ${cseq}\r\nWWW-Authenticate: Digest realm="${realm}", nonce="${nonce}"\r\nContent-Length: 0\r\n\r\n`,
          ));
          continue;
        }
        session.acceptedRequests.push(method);
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
        if (method === 'TEARDOWN') {
          session.teardowns++;
          recording = false;
        }
        if (method === 'TEARDOWN' && opts.withholdTeardownReply) continue;
        const delay = method === 'FLUSH' ? opts.flushDelayMs : undefined;
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
          retransmits.set(session.id, () => {
            const sequence = session.rtpSequences.at(-1);
            if (!controlPort || sequence === undefined) return;
            const request = new Uint8Array([0x80, 0xd5, 0, 1, 0, 0, 0, 1]);
            new DataView(request.buffer).setUint16(4, sequence);
            control.send(request, controlPort, session.rtspPeer.address);
          });
          extra =
            `Session: ${session.id}\r\nTransport: RTP/AVP/UDP;unicast;mode=record;server_port=${audioPort};control_port=${control.address().port};timing_port=${timing.address().port}\r\n`;
        } else if (method === 'RECORD') {
          recording = !opts.refuseRecord?.();
          extra = 'Audio-Latency: 11025\r\n';
        }
        await conn.write(
          encoder.encode(
            `RTSP/1.0 ${
              method === 'RECORD' && !recording ? '500 Refused' : '200 OK'
            }\r\nCSeq: ${cseq}\r\n${extra}Server: fake-raop\r\nContent-Length: 0\r\n\r\n`,
          ),
        );
      }
    } catch {
      /* client went away */
    } finally {
      recording = false;
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
