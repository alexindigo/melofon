#!/usr/bin/env python3
"""Fake AirPlay 1 (RAOP) device for the helper's functional test: answers
enough RTSP to get melofon-raop streaming, then counts RTP audio packets on
the UDP server port. Prints one REPORT line on stdin EOF."""
import os
import queue
import select
import socket
import socketserver
import struct
import sys
import threading
import time

# The wedge: hold the RECORD reply this long (a stuck-then-late session).
RECORD_DELAY_MS = int(os.environ.get('FAKE_RECORD_DELAY_MS', '0'))
# The JBL: refuse the ANNOUNCE (403) — the session fails and teardown+free
# must stay clean (the evbuffer UAF crash).
ANNOUNCE_403 = os.environ.get('FAKE_ANNOUNCE_403') == '1'
WITHHOLD_TEARDOWN = os.environ.get('FAKE_WITHHOLD_TEARDOWN') == '1'
DELAY_METHOD = os.environ.get('FAKE_DELAY_METHOD', '')

state = {
    'requests': [],
    'audio_packets': 0,
    'first_rtp_at': None,
    'last_rtp_at': None,
    'seqs': [],
    'payload_types': set(),
    'volume_params': [],
    'flushes': 0,
    'teardowns': 0,
    'sdp': None,
    'sync_ntp_secs': [],
    'sync_first': None,
    'timing_answered': None,
    'progress_bodies': [],
    'dmap_bodies': [],
    'first_progress_at': None,
    'auth_setups': 0,
    'auth_setup_before_announce': None,
    'rtp_info': None,
    'dacp_ids': set(),
    'client_instances': set(),
    'active_remotes': set(),
    'connections': [],
    'audio_by_source': {},
}

NTP_EPOCH_DELTA = 2208988800


def udp_socket():
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(('127.0.0.1', 0))
    return sock, sock.getsockname()[1]


class UDPCollector(threading.Thread):
    def __init__(self, sock):
        super().__init__(daemon=True)
        self.sock = sock

    def run(self):
        while True:
            data, source = self.sock.recvfrom(4096)
            if len(data) < 12:
                continue
            state['audio_packets'] += 1
            source_port = source[1]
            state['audio_by_source'][source_port] = state['audio_by_source'].get(source_port, 0) + 1
            state['payload_types'].add(data[1] & 0x7F)
            state['seqs'].append(struct.unpack('>H', data[2:4])[0])
            now = time.monotonic()
            if state['first_rtp_at'] is None:
                state['first_rtp_at'] = now
                print('AUDIO', flush=True)
                print(f'RTP_SEQ {struct.unpack(">H", data[2:4])[0]}', flush=True)
            state['last_rtp_at'] = now


audio_sock, audio_port = udp_socket()
control_sock, control_port = udp_socket()
_, timing_port = udp_socket()
UDPCollector(audio_sock).start()


class ControlCollector(threading.Thread):
    """RTCP sync packets: 0x80 0xd4 + cur_pos(4) + NTP(sec,frac) + rtptime.
    The NTP seconds must be on the sender's CLOCK_MONOTONIC timeline — a
    zero-based stream clock breaks the device's playout schedule. The first
    packet's rtptime - cur_pos is the sender's start buffer in samples
    (OwnTone: 2250 ms - 250 ms device latency = 88200)."""

    def __init__(self, sock):
        super().__init__(daemon=True)
        self.sock = sock

    def run(self):
        while True:
            data, _ = self.sock.recvfrom(4096)
            # 0x90 = init sync at session start, 0x80 = periodic.
            if len(data) >= 20 and data[0] in (0x80, 0x90) and data[1] == 0xD4:
                sec = struct.unpack('>I', data[8:12])[0]
                state['sync_ntp_secs'].append(sec)
                if state['sync_first'] is None:
                    state['sync_first'] = {
                        'type': data[0],
                        'cur_pos': struct.unpack('>I', data[4:8])[0],
                        'rtptime': struct.unpack('>I', data[16:20])[0],
                    }


ControlCollector(control_sock).start()


class RTSPHandler(socketserver.BaseRequestHandler):
    timing_port = None

    def setup(self):
        self.chunks = queue.Queue()
        self.connection = {'generation': len(state['connections']) + 1,
                           'closed_at': None, 'requests': []}
        state['connections'].append(self.connection)
        # Observe EOF even while the response handler is deliberately delayed.
        def reader():
            try:
                while True:
                    data = self.request.recv(65536)
                    if not data:
                        break
                    self.chunks.put(data)
            except OSError:
                pass
            finally:
                self.connection['closed_at'] = time.monotonic()
                self.chunks.put(b'')
        threading.Thread(target=reader, daemon=True).start()

    def handle(self):
        buf = b''
        while True:
            try:
                data = self.chunks.get()
            except OSError:
                return
            if not data:
                return
            buf += data
            while b'\r\n\r\n' in buf:
                head, buf = buf.split(b'\r\n\r\n', 1)
                lines = head.decode(errors='replace').split('\r\n')
                parts = lines[0].split(' ', 2)
                method = parts[0]
                url = parts[1] if len(parts) > 1 else ''
                headers = {}
                for line in lines[1:]:
                    if ': ' in line:
                        k, v = line.split(': ', 1)
                        headers[k.lower()] = v
                clen = int(headers.get('content-length', '0'))
                while len(buf) < clen:
                    chunk = self.chunks.get()
                    if not chunk:
                        return
                    buf += chunk
                body, buf = buf[:clen], buf[clen:]

                state['requests'].append(method)
                self.connection['requests'].append(method)
                print(f'SEEN {self.connection["generation"]} {method} {headers.get("active-remote", "0")}', flush=True)
                if method == DELAY_METHOD and headers.get('active-remote') == '2':
                    time.sleep(0.6)
                if method == 'RECORD' and RECORD_DELAY_MS > 0:
                    time.sleep(RECORD_DELAY_MS / 1000)
                if headers.get('dacp-id'):
                    state['dacp_ids'].add(headers['dacp-id'])
                if headers.get('client-instance'):
                    state['client_instances'].add(headers['client-instance'])
                if headers.get('active-remote'):
                    state['active_remotes'].add(headers['active-remote'])
                cseq = headers.get('cseq', '0')
                if method == 'SETUP':
                    print(f'SETUP headers: {headers!r}', file=sys.stderr, flush=True)
                    print(f'CONTROL {headers.get("active-remote", "0")} {headers["transport"].split("control_port=")[1].split(";")[0]}', flush=True)
                if method == 'ANNOUNCE':
                    state['sdp'] = body.decode(errors='replace')
                if method == 'RECORD':
                    state['rtp_info'] = headers.get('rtp-info', '')
                if method == 'POST' and 'auth-setup' in url:
                    state['auth_setups'] += 1
                    if state['auth_setup_before_announce'] is None:
                        state['auth_setup_before_announce'] = (
                            'ANNOUNCE' not in state['requests'])
                ctype = headers.get('content-type', '')
                if method == 'SET_PARAMETER' and body.startswith(b'volume'):
                    state['volume_params'].append(body.decode().strip())
                elif method == 'SET_PARAMETER' and body.startswith(b'progress:'):
                    state['progress_bodies'].append(body.decode().strip())
                    if state['first_progress_at'] is None:
                        state['first_progress_at'] = time.monotonic()
                elif method == 'SET_PARAMETER' and 'dmap' in ctype:
                    state['dmap_bodies'].append(body)
                if method == 'FLUSH':
                    state['flushes'] += 1
                if method == 'TEARDOWN':
                    state['teardowns'] += 1
                    if WITHHOLD_TEARDOWN:
                        # Keep reading the socket independently, never ack it.
                        continue

                extra = ''
                if method == 'OPTIONS':
                    extra = ('Public: ANNOUNCE, SETUP, RECORD, PAUSE, FLUSH, '
                             'TEARDOWN, SET_PARAMETER, POST, GET_PARAMETER\r\n')
                if method == 'SETUP':
                    RTSPHandler.timing_port = int(
                        headers['transport'].split('timing_port=')[1].split(';')[0])
                    extra = (f'Session: DEADBEEF\r\n'
                             f'Transport: RTP/AVP/UDP;unicast;mode=record;'
                             f'server_port={audio_port};'
                             f'control_port={control_port};'
                             f'timing_port={timing_port}\r\n')
                if method == 'RECORD':
                    extra = 'Audio-Latency: 11025\r\n'
                    # Probe the sender's timing service (device -> sender
                    # clock sync): 0xd2 request to the SETUP-advertised port.
                    try:
                        tport = RTSPHandler.timing_port
                        tq = bytearray(32)
                        tq[0], tq[1] = 0x80, 0xD2
                        tq[4:8] = struct.pack('>I', 7)
                        tq[24:32] = struct.pack('>Q', 0x1234567890ABCDEF)
                        ts = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
                        ts.settimeout(3)
                        ts.sendto(bytes(tq), (self.client_address[0], tport))
                        data, _ = ts.recvfrom(64)
                        state['timing_answered'] = (len(data) >= 32 and data[1] == 0xD3)
                        ts.close()
                    except Exception as e:
                        print(f'timing-probe: failed: {e!r}', file=sys.stderr, flush=True)
                        state['timing_answered'] = False
                if method == 'ANNOUNCE' and ANNOUNCE_403:
                    res = (f'RTSP/1.0 403 Forbidden\r\nCSeq: {cseq}\r\n'
                           f'Content-Length: 0\r\n\r\n')
                else:
                    res = (f'RTSP/1.0 200 OK\r\nCSeq: {cseq}\r\n{extra}'
                           f'Server: fake-raop\r\nContent-Length: 0\r\n\r\n')
                try:
                    self.request.sendall(res.encode())
                except OSError:
                    return


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


server = Server(('127.0.0.1', 0), RTSPHandler)
threading.Thread(target=server.serve_forever, daemon=True).start()
print(f'listening {server.server_address[1]}', flush=True)

while True:
    r, _, _ = select.select([sys.stdin], [], [], 1)
    if r:
        line = sys.stdin.readline()
        if line == '': break
        if line.strip() == 'SNAPSHOT':
            print('SNAPSHOT ' + repr(state['audio_by_source']), flush=True)

report = dict(state)
report['seqs'] = state['seqs']
print('REPORT ' + repr(report), flush=True)
