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

    # Client identity: DACP-ID and Client-Instance must be a real non-zero
    # 64-bit hex id (OwnTone: murmur_hash64 of the library name). A literal
    # '0' (the stub's old libhash) is what arbat (AppleTV3,1) accepts at
    # RTSP level but silently refuses to render — the wire-capture suspect
    # from 2026-09-22.
    assert report['dacp_ids'], 'no DACP-ID header captured'
    for v in report['dacp_ids']:
        assert len(v) == 16 and v != '0' and v != '0000000000000000' \
            and all(c in '0123456789abcdefABCDEF' for c in v), \
            f'DACP-ID is not a non-zero 64-bit hex id: {v!r}'
    assert report['client_instances'] == report['dacp_ids'], \
        (report['client_instances'], report['dacp_ids'])

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

    # md absent → no DMAP, no progress (OwnTone with missing md is metadata 0).
    assert not report['progress_bodies'], report['progress_bodies']
    assert not report['dmap_bodies'], report['dmap_bodies']
    assert report['auth_setups'] == 0
    assert 'Adding AirPlay device' in driver.stderr
    assert 'metadata: 0' in driver.stderr
    assert 'authsetup: 0' in driver.stderr

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


def contract_scenario():
    """OwnTone calling-convention contract: progress only after audio, after
    88200 samples, on the stream timeline; DMAP minm when md=7; pcm_peak > 0;
    the Adding AirPlay device log line."""
    fake, port = start_fake()
    driver = subprocess.run([DRIVER, port, 'contract'],
                            capture_output=True, text=True, timeout=60)
    report = read_report(fake)
    fake.kill()

    assert driver.returncode == 0 and 'DRIVER-OK' in driver.stdout, \
        f'driver failed: {driver.returncode} {driver.stdout} {driver.stderr}'
    assert report is not None, 'fake device produced no report'

    m = re.search(r'pcm_peak=(\d+)', driver.stderr)
    assert m and int(m.group(1)) > 0, \
        f'first tick peak not > 0: {driver.stderr[-400:]}'
    assert 'Adding AirPlay device' in driver.stderr
    assert 'metadata: 7' in driver.stderr
    assert 'encrypt: 0' in driver.stderr
    assert 'authsetup: 0' in driver.stderr

    assert report['progress_bodies'], 'no progress: after 88200 samples'
    assert report['first_rtp_at'] is not None
    assert report['first_progress_at'] is not None
    assert report['first_progress_at'] >= report['first_rtp_at'] - 0.05, \
        'progress posted before audio'

    # Progress rtptimes live on the RECORD rtptime timeline, not a
    # pre-start CLOCK_MONOTONIC converted badly.
    rtp_m = re.search(r'rtptime=(\d+)', report['rtp_info'] or '')
    assert rtp_m, f'no RECORD RTP-Info: {report["rtp_info"]}'
    rec_rtp = int(rtp_m.group(1))
    prog = re.search(r'progress: (\d+)/(\d+)/(\d+)', report['progress_bodies'][0])
    assert prog, report['progress_bodies'][0]
    for val in (int(prog.group(1)), int(prog.group(2)), int(prog.group(3))):
        delta = abs((val - rec_rtp) & 0xFFFFFFFF)
        if delta > 0x80000000:
            delta = 0x100000000 - delta
        assert delta < 500000, \
            f'progress {val} not on RECORD rtptime timeline {rec_rtp}'

    assert report['dmap_bodies'], 'md=0,1,2 should send DMAP text'
    blob = b''.join(report['dmap_bodies'])
    assert b'minm' in blob and b'Cool Vibes' in blob, blob[:80]
    assert b'asar' in blob and b'Blue Tattoo' in blob, blob[:80]

    print('contract test: OK '
          f"(progress after audio, DMAP minm, pcm_peak={m.group(1)})")


def authsetup_scenario():
    """TXT et=4 → POST /auth-setup before ANNOUNCE. et absent → no POST
    (covered by standard_scenario)."""
    fake, port = start_fake()
    driver = subprocess.run([DRIVER, port, 'authsetup'],
                            capture_output=True, text=True, timeout=45)
    report = read_report(fake)
    fake.kill()

    assert driver.returncode == 0 and 'DRIVER-OK' in driver.stdout, \
        f'driver failed: {driver.returncode} {driver.stdout} {driver.stderr}'
    assert report is not None
    assert report['auth_setups'] >= 1, 'no POST /auth-setup'
    assert report['auth_setup_before_announce'] is True, \
        f'auth-setup not before ANNOUNCE: {report["requests"]}'
    assert 'authsetup: 1' in driver.stderr
    print('authsetup test: OK (POST /auth-setup before ANNOUNCE)')


# --- Failure-injection scenarios (plan atv3-session-recycle) -------------
# The queue/cleanup failure contract: cmd_push must roll back a failed
# event_base_once (else the queue wedges permanently and raop_free hangs),
# and raop_free must report whether the handle was provably released.
# faultinject.so interposes event_base_once/calloc via LD_PRELOAD.

FAULTINJECT = os.path.join(HERE, 'faultinject.so')
PROBE_SRC = os.path.join(HERE, 'probe_free_contract.c')
PROBE_BIN = os.path.join(HERE, 'probe_free_contract')
LIBDIR = os.path.dirname(HERE)


def injected_driver(args, env_extra, timeout=45):
    env = dict(os.environ)
    env['LD_PRELOAD'] = FAULTINJECT
    env.update(env_extra)
    return subprocess.run([DRIVER] + args, capture_output=True, text=True,
                          timeout=timeout, env=env)


def schedfail_scenario():
    """The queue wedge: the START push's event_base_once fails. The API
    must reject it, and the retry must recover the queue — the fake device
    seeing the full handshake is the wire-observable recovery proof. Red on
    the pre-repair base: the retry wedges (cmds_scheduled stuck at 1 with
    no drain pending) and connected never arrives (runner timeout)."""
    fake, port = start_fake()
    driver = injected_driver([port, 'schedfail'], {'RAOP_FI_EBO_FAIL_AT': '1'})
    report = read_report(fake)
    fake.kill()

    assert driver.returncode == 0 and 'DRIVER-OK' in driver.stdout, \
        f'schedfail driver failed: {driver.returncode} ' \
        f'{driver.stdout} {driver.stderr[-400:]}'
    assert report is not None, 'fake device produced no report'
    seq = report['requests']
    for expected in ['OPTIONS', 'ANNOUNCE', 'SETUP', 'RECORD']:
        assert expected in seq, f'retry did not reach the wire: {seq}'
    print('schedfail test: OK (failed enqueue rejected, retry recovered '
          'the queue)')


def teardownfail_scenario():
    """The cleanup wedge: the TEARDOWN push's event_base_once fails.
    raop_teardown must reject it, and raop_free must still fully release
    the handle — the loop-thread free tears the still-attached device
    down — and RETURN. Red on the pre-repair base: raop_free wedges the
    queue and blocks forever on its CMD_FREE wait (runner timeout)."""
    fake, port = start_fake()
    driver = injected_driver([port, 'teardownfail'], {'RAOP_FI_EBO_FAIL_AT': '2'})
    fake.kill()

    assert driver.returncode == 0 and 'DRIVER-OK' in driver.stdout, \
        f'teardownfail driver failed (hang?): {driver.returncode} ' \
        f'{driver.stdout} {driver.stderr[-400:]}'
    print('teardownfail test: OK (failed teardown enqueue, free still '
          'released and returned)')


def free_contract_scenario():
    """raop_free's result is observable: injected free-path failures — the
    scheduling branch and the allocation branch alike — surface as -1, and
    the process exits cleanly (the leaked handle is reported, not hidden).
    The probe does not compile against the pre-repair void header: that
    build failure is this scenario's red on the base."""
    build = subprocess.run(
        ['cc', '-O1', '-o', PROBE_BIN, PROBE_SRC,
         '-L', LIBDIR, '-lmelofon_raop', '-Wl,-rpath', LIBDIR],
        capture_output=True, text=True)
    assert build.returncode == 0, \
        f'probe build failed (pre-repair void raop_free?): {build.stderr}'

    try:
        # Scheduling branch: pushes are START(1), TEARDOWN(2), FREE(3).
        fake, port = start_fake()
        env = dict(os.environ)
        env['LD_PRELOAD'] = FAULTINJECT
        env['RAOP_FI_EBO_FAIL_AT'] = '3'
        probe = subprocess.run([PROBE_BIN, port], capture_output=True,
                               text=True, timeout=45, env=env)
        fake.kill()
        assert probe.returncode == 0 and 'FREE-RC=-1' in probe.stdout, \
            f'scheduling-branch free failure not observed: ' \
            f'{probe.returncode} {probe.stdout} {probe.stderr[-300:]}'

        # Allocation branch: the armed one-shot fails the CMD_FREE calloc.
        arm = os.path.join(HERE, '.fi-arm')
        if os.path.exists(arm):
            os.unlink(arm)
        fake, port = start_fake()
        env = dict(os.environ)
        env['LD_PRELOAD'] = FAULTINJECT
        env['RAOP_FI_CALLOC_ARM_FILE'] = arm
        probe = subprocess.run([PROBE_BIN, port], capture_output=True,
                               text=True, timeout=45, env=env)
        fake.kill()
        assert not os.path.exists(arm), 'the injected calloc never fired'
        assert probe.returncode == 0 and 'FREE-RC=-1' in probe.stdout, \
            f'allocation-branch free failure not observed: ' \
            f'{probe.returncode} {probe.stdout} {probe.stderr[-300:]}'
    finally:
        if os.path.exists(PROBE_BIN):
            os.unlink(PROBE_BIN)

    print('free-contract test: OK (free failures observable as -1, both '
          'branches)')


def main():
    standard_scenario()
    backlog_scenario()
    fail_scenario()
    contract_scenario()
    authsetup_scenario()
    schedfail_scenario()
    teardownfail_scenario()
    free_contract_scenario()
    return 0


if __name__ == '__main__':
    sys.exit(main())
