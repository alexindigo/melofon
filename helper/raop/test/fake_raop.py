#!/usr/bin/env python3
"""Fake AirPlay 1 (RAOP) device for the helper's functional test: answers
enough RTSP to get melofon-raop streaming, then counts RTP audio packets on
the UDP server port. Prints one REPORT line on stdin EOF."""
import os
import select
import socket
import socketserver
import struct
import sys
import threading
import time

# The wedge: hold the RECORD reply this long (a stuck-then-late session).
RECORD_DELAY_MS = int(os.environ.get('FAKE_RECORD_DELAY_MS', '0'))

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
            data, _ = self.sock.recvfrom(4096)
            if len(data) < 12:
                continue
            state['audio_packets'] += 1
            state['payload_types'].add(data[1] & 0x7F)
            state['seqs'].append(struct.unpack('>H', data[2:4])[0])
            now = time.monotonic()
            if state['first_rtp_at'] is None:
                state['first_rtp_at'] = now
            state['last_rtp_at'] = now


audio_sock, audio_port = udp_socket()
control_sock, control_port = udp_socket()
_, timing_port = udp_socket()
UDPCollector(audio_sock).start()


class ControlCollector(threading.Thread):
    """RTCP sync packets: 0x80 0xd4 + rtptime(4) + NTP(sec,frac) + rtptime.
    The NTP seconds must be on the sender's CLOCK_MONOTONIC timeline — a
    zero-based stream clock breaks the device's playout schedule."""

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


ControlCollector(control_sock).start()


class RTSPHandler(socketserver.BaseRequestHandler):
    def handle(self):
        buf = b''
        while True:
            try:
                data = self.request.recv(65536)
            except OSError:
                return
            if not data:
                return
            buf += data
            while b'\r\n\r\n' in buf:
                head, buf = buf.split(b'\r\n\r\n', 1)
                lines = head.decode(errors='replace').split('\r\n')
                method, _, _ = lines[0].split(' ', 2)
                headers = {}
                for line in lines[1:]:
                    if ': ' in line:
                        k, v = line.split(': ', 1)
                        headers[k.lower()] = v
                clen = int(headers.get('content-length', '0'))
                while len(buf) < clen:
                    chunk = self.request.recv(65536)
                    if not chunk:
                        return
                    buf += chunk
                body, buf = buf[:clen], buf[clen:]

                if method == 'RECORD' and RECORD_DELAY_MS > 0:
                    time.sleep(RECORD_DELAY_MS / 1000)
                state['requests'].append(method)
                cseq = headers.get('cseq', '0')
                if method == 'ANNOUNCE':
                    state['sdp'] = body.decode(errors='replace')
                if method == 'SET_PARAMETER' and body.startswith(b'volume'):
                    state['volume_params'].append(body.decode().strip())
                if method == 'FLUSH':
                    state['flushes'] += 1
                if method == 'TEARDOWN':
                    state['teardowns'] += 1

                extra = ''
                if method == 'OPTIONS':
                    extra = ('Public: ANNOUNCE, SETUP, RECORD, PAUSE, FLUSH, '
                             'TEARDOWN, SET_PARAMETER, POST, GET_PARAMETER\r\n')
                if method == 'SETUP':
                    extra = (f'Session: DEADBEEF\r\n'
                             f'Transport: RTP/AVP/UDP;unicast;mode=record;'
                             f'server_port={audio_port};'
                             f'control_port={control_port};'
                             f'timing_port={timing_port}\r\n')
                if method == 'RECORD':
                    extra = 'Audio-Latency: 11025\r\n'
                res = (f'RTSP/1.0 200 OK\r\nCSeq: {cseq}\r\n{extra}'
                       f'Server: fake-raop\r\nContent-Length: 0\r\n\r\n')
                self.request.sendall(res.encode())


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


server = Server(('127.0.0.1', 0), RTSPHandler)
threading.Thread(target=server.serve_forever, daemon=True).start()
print(f'listening {server.server_address[1]}', flush=True)

while True:
    r, _, _ = select.select([sys.stdin], [], [], 1)
    if r and sys.stdin.readline() == '':
        break

report = dict(state)
report['seqs'] = state['seqs']
print('REPORT ' + repr(report), flush=True)
