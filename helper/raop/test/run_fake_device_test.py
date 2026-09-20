#!/usr/bin/env python3
"""Functional test for melofon-raop against a fake RAOP device (no Apple
hardware): drives the stdin protocol, then asserts on both the helper's
stdout events and what the fake device observed (RTSP sequence, RTP pacing,
volume, flush, teardown)."""
import ast
import json
import os
import struct
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
HELPER = os.path.join(HERE, '..', 'melofon-raop')


def frame(cmd):
    payload = json.dumps(cmd).encode()
    return struct.pack('>I', len(payload)) + b'J' + payload


def pcm(data):
    return struct.pack('>I', len(data)) + b'P' + data


def read_event(proc, timeout=10.0):
    """Read one JSON event line from the helper's stdout."""
    import select
    fd = proc.stdout.fileno()
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        r, _, _ = select.select([fd], [], [], deadline - time.monotonic())
        if r:
            line = proc.stdout.readline()
            if line:
                return json.loads(line)
    raise AssertionError('timed out waiting for a helper event')


def main():
    fake = subprocess.Popen(
        [sys.executable, '-u', os.path.join(HERE, 'fake_raop.py')],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    port = int(fake.stdout.readline().split()[1])

    helper = subprocess.Popen([HELPER], stdin=subprocess.PIPE,
                              stdout=subprocess.PIPE)
    try:
        assert read_event(helper)['event'] == 'ready'

        helper.stdin.write(frame({
            'cmd': 'start', 'host': '127.0.0.1', 'port': port,
            'name': 'Fake ATV', 'volume': 80}))
        helper.stdin.flush()
        assert read_event(helper)['value'] == 'starting'
        assert read_event(helper, timeout=15)['value'] == 'connected'

        # One second of PCM (silence): 44100 * 2ch * 2B = 176400 bytes.
        helper.stdin.write(pcm(bytes(176400)))
        helper.stdin.flush()
        time.sleep(2.0)  # paced out in real time

        helper.stdin.write(frame({'cmd': 'volume', 'volume': 42}))
        helper.stdin.write(frame({'cmd': 'flush'}))
        helper.stdin.flush()
        time.sleep(0.5)

        helper.stdin.write(frame({'cmd': 'teardown'}))
        helper.stdin.flush()
        deadline = time.monotonic() + 10
        stopped = False
        while time.monotonic() < deadline and not stopped:
            ev = read_event(helper)
            stopped = ev.get('value') == 'stopped'
        assert stopped, 'teardown did not reach stopped state'

        helper.stdin.close()
        assert helper.wait(timeout=10) == 0, 'clean exit on stdin EOF'
    finally:
        if helper.poll() is None:
            helper.kill()
        fake.stdin.close()

    report = None
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        line = fake.stdout.readline()
        if line.startswith('REPORT '):
            report = ast.literal_eval(line[7:])
            break
    fake.kill()
    assert report is not None, 'fake device produced no report'

    # RTSP sequence: handshake, then volume, flush, teardown.
    seq = report['requests']
    for expected in ['OPTIONS', 'ANNOUNCE', 'SETUP', 'RECORD',
                     'SET_PARAMETER', 'FLUSH', 'TEARDOWN']:
        assert expected in seq, f'missing RTSP {expected}: {seq}'
    assert seq.index('OPTIONS') < seq.index('ANNOUNCE') < seq.index('SETUP') \
        < seq.index('RECORD'), f'RTSP out of order: {seq}'

    # SDP announces AppleLossless 44100.
    assert 'AppleLossless' in report['sdp'] and '44100' in report['sdp']

    # 1 s of audio = 125 packets of 352 samples (44.1 kHz), payload type 96,
    # paced in real time (span within [0.5 s, 1.9 s]).
    assert report['audio_packets'] in range(120, 132), report['audio_packets']
    assert report['payload_types'] == {96}
    span = report['last_rtp_at'] - report['first_rtp_at']
    assert 0.5 < span < 1.9, span
    seqs = report['seqs']
    assert all(b - a == 1 for a, b in zip(seqs, seqs[1:])), 'RTP seq gap'

    # Volume mapping: 80% -> -6.0 dB, 42% -> ~-17.4 dB (RAOP -30..0 range).
    assert 'volume: -6.000000' in report['volume_params'], report['volume_params']
    assert any(v.startswith(('volume: -17.4', 'volume: -17.3'))
               for v in report['volume_params']), report['volume_params']

    assert report['flushes'] == 1 and report['teardowns'] == 1

    print('fake-device test: OK '
          f"({report['audio_packets']} RTP packets in {span:.2f}s, "
          f'{len(seq)} RTSP requests)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
