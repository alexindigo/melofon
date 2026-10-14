#!/usr/bin/env python3
"""VM-only native address/error gate; no production fault-injection switch."""
import os
from pathlib import Path
import shlex
import subprocess
import sys

BASE = Path('/home/tester/melofon-output-preparation-01/dual-home-01')
ROOT = BASE / 'source/helper/raop'
suffix = sys.argv[1] if len(sys.argv) == 2 else ''
assert not suffix or suffix.isalnum()
OUT = BASE / 'evidence' / ('source-contracts' + ('-' + suffix if suffix else ''))
assert subprocess.check_output(['sudo', '-n', 'cat', '/sys/class/dmi/id/product_uuid'],
                               text=True).strip().lower() == '1af2f55f-5461-48c1-bb2d-b2d9d6c3d1c3'
assert not os.environ.get('LD_PRELOAD')
OUT.mkdir(mode=0o700)
packages = ['libevent', 'libavcodec', 'libavformat', 'libavfilter', 'libavutil',
            'json-c', 'libsodium', 'libplist-2.0', 'libgcrypt', 'uuid', 'libcurl']
pc = shlex.split(subprocess.check_output(['pkg-config', '--cflags', '--libs'] + packages,
                                       text=True))
objects = ['ffi.o', 'player.o', 'stub/stubs.o', 'vendor/outputs/rtp_common.o',
           'vendor/evrtsp/rtsp.o', 'vendor/pair_ap/pair.o', 'vendor/pair_ap/pair_fruit.o',
           'vendor/pair_ap/pair_homekit.o', 'vendor/pair_ap/pair-tlv.o',
           'vendor/transcode.o', 'vendor/misc.o']
command = ['cc', '-O1', '-g', '-DHAVE_CONFIG_H', '-D_GNU_SOURCE', '-DCONFIG_GCRYPT=1',
           '-Wall', '-Wno-unused', '-I', 'stub', '-I', 'vendor', '-I', 'vendor/outputs',
           '-I', 'vendor/evrtsp', '-o', str(OUT / 'probe-sources'),
           '../../dev/dual-home/probe-sources.c'] + objects + pc + [
           '-levent_pthreads', '-lgpg-error', '-lunistring', '-lpthread', '-lm']


def run(name, args):
    (OUT / (name + '.command')).write_text(shlex.join(args) + '\n')
    result = subprocess.run(args, cwd=ROOT, capture_output=True, timeout=40)
    (OUT / (name + '.stdout')).write_bytes(result.stdout)
    (OUT / (name + '.stderr')).write_bytes(result.stderr)
    (OUT / (name + '.exit')).write_text(str(result.returncode) + '\n')
    print(result.stdout.decode(), end='')
    print(result.stderr.decode(), end='')
    result.check_returncode()
    return result


run('build', command)
numeric = run('numeric', ['unshare', '--user', '--map-root-user', '--net', str(OUT / 'probe-sources')])
assert b'SOURCE-CONTRACTS-OK' in numeric.stdout
sys.path.insert(0, str(ROOT / 'test'))
import run_fake_device_test as receiver
fake, port = receiver.start_fake({})
try:
    failure = run('session-error', [str(OUT / 'probe-sources'), str(port)])
    assert b'SOURCE-ERROR-SESSION-OK' in failure.stdout
    assert b'Local source observation error' in failure.stderr
    assert b'errno=24' in failure.stderr
finally:
    fake.kill()
    fake.wait()
print('SOURCE-VERIFICATION-OK numeric-errors=classified native-error-events=once cleanup=proven')
