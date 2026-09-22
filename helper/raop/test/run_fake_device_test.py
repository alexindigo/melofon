#!/usr/bin/env python3
"""Functional test for libmelofon_raop against a fake RAOP device (no Apple
hardware): test/driver (linked against the .so) drives start → PCM → volume
→ flush → teardown; this script asserts what the fake device observed (RTSP
sequence, RTP pacing, volume, flush, teardown)."""
import ast
import os
import re
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
DRIVER = os.path.join(HERE, 'driver')


def start_fake(env_extra=None):
    env = dict(os.environ)
    if env_extra:
        env.update(env_extra)
    fake = subprocess.Popen(
        [sys.executable, '-u', os.path.join(HERE, 'fake_raop.py')],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, env=env)
    return fake, fake.stdout.readline().split()[1]


def read_report(fake):
    fake.stdin.close()
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        line = fake.stdout.readline()
        if line.startswith('REPORT '):
            return ast.literal_eval(line[7:])
    return None


def standard_scenario():
    fake, port = start_fake()
    driver = subprocess.run([DRIVER, port], capture_output=True, text=True,
                            timeout=45)
    report = read_report(fake)
    fake.kill()

    assert driver.returncode == 0 and 'DRIVER-OK' in driver.stdout, \
        f'driver failed: {driver.returncode} {driver.stdout} {driver.stderr}'
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

    # The device syncs its clock to the sender via timing requests — the
    # sender's timing service must answer 0xd3.
    assert report['timing_answered'] is True, \
        f'timing service did not answer: {report["timing_answered"]}'

    # Sync packets schedule playout on the CLOCK_MONOTONIC timeline (a
    # zero-based pts puts them ~boot-uptime in the past — the device holds
    # audio forever: the "silent while receiving" bug).
    assert report['sync_ntp_secs'], 'no RTCP sync packets seen'
    expected = 2208988800 + time.monotonic()
    for sec in report['sync_ntp_secs']:
        assert abs(sec - expected) < 120, \
            f'sync NTP timestamp off the monotonic timeline: {sec} vs {expected:.0f}'

    # The start buffer on the wire: the first sync packet's
    # rtptime - cur_pos is output_buffer_samples = (start_buffer_ms - 250) *
    # 44.1 — OwnTone's default 2250 ms -> 88200 (raop.c:1925, outputs.c:1326).
    # 33075 here would mean the buffer is still 1000 ms.
    first = report['sync_first']
    assert first is not None, 'no sync packet captured'
    offset = (first['rtptime'] - first['cur_pos']) & 0xFFFFFFFF
    assert abs(offset - 88200) <= 352, \
        f'sync rtptime-cur_pos is {offset}, not 88200 (start buffer is not 2250 ms)'

    print('fake-device test: OK '
          f"({report['audio_packets']} RTP packets in {span:.2f}s, "
          f'{len(seq)} RTSP requests)')


def backlog_scenario():
    """The wedge: fake's RECORD reply is delayed 3.5 s while the pump feeds
    6 s of PCM. The ~2 s read-ahead cap must hold pre-connect, and the
    pacing that starts at connect must reopen the flow — the buffered audio
    plays out in real time, no stale-backlog burst."""
    fake, port = start_fake({'FAKE_RECORD_DELAY_MS': '3500'})
    driver = subprocess.run([DRIVER, port, 'backlog', '6'],
                            capture_output=True, text=True, timeout=60)
    report = read_report(fake)
    fake.kill()

    assert driver.returncode == 0 and 'DRIVER-OK' in driver.stdout, \
        f'driver failed: {driver.returncode} {driver.stdout} {driver.stderr}'
    m = re.search(r'PRE=(\d+) TOTAL=(\d+)', driver.stdout)
    assert m, f'no PRE/TOTAL in driver output: {driver.stdout}'
    pre, total = int(m.group(1)), int(m.group(2))

    cap = 2 * 44100 * 4
    assert pre <= cap + 8192, \
        f'cap did not hold: accepted {pre} by connect, cap is {cap}'
    assert total == 6 * 176400, \
        f'flow did not reopen when pacing started at connect: TOTAL={total}'

    assert report is not None and report['audio_packets'] > 0
    span = report['last_rtp_at'] - report['first_rtp_at']
    rate = report['audio_packets'] / max(span, 0.001)
    assert 30 < rate < 400, \
        f'not realtime pacing (backlog burst?): {rate:.0f} pkt/s'
    print(f'backlog test: OK (PRE={pre} <= {cap}, '
          f'{report["audio_packets"]} packets at {rate:.0f}/s)')


def fail_scenario():
    """The JBL: ANNOUNCE refused (403) -> session fails -> teardown+free
    must exit cleanly (the evbuffer UAF crash regression)."""
    fake, port = start_fake({'FAKE_ANNOUNCE_403': '1'})
    driver = subprocess.run([DRIVER, port, 'fail'],
                            capture_output=True, text=True, timeout=45)
    fake.kill()
    assert driver.returncode == 0 and 'DRIVER-OK' in driver.stdout, \
        f'crash on failing session: rc={driver.returncode} ' \
        f'stderr={driver.stderr[-400:]}'
    print('fail scenario: OK (session failure -> free is clean)')


def main():
    standard_scenario()
    backlog_scenario()
    fail_scenario()
    return 0


if __name__ == '__main__':
    sys.exit(main())
