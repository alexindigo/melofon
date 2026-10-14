# Vendored OwnTone sources

`vendor/` is copied from [owntone-server](https://github.com/owntone/owntone-server)
at commit `a038de21065bbbfec721c9c974e3bbd30b22fd59` (2026-09-16):

- `outputs/raop.c`, `outputs/rtp_common.{c,h}` — the AirPlay 1 (RAOP)
  sender: RTSP handshake, encrypted-RTP/ALAC packetization, timing/sync
- `evrtsp/` — RTSP client over libevent (forked from evrtsp; `log.h` is
  BSD-licensed by Niels Provos)
- `pair_ap/` — AirPlay device verification / PIN pairing (fruit + HomeKit)
- `transcode.{c,h}` — PCM → ALAC encode via FFmpeg libraries
- `misc.{c,h}`, `outputs.h`, `db.h` — shared OwnTone infrastructure

OwnTone is GPL-2.0-or-later; the vendored files keep their copyright and
license headers. Melofon uses `libmelofon_raop.so` in-process through Deno
FFI, with commands queued onto its native event thread and events polled
back. There is no subprocess/stdin player transport.

Not vendored (stubbed in `stub/` instead, because the helper has none of
them): the config file, syslog logger, database, player, artwork cache, DMAP
metadata, mDNS discovery, HTTP icy metadata. `stub/config.h` is the
hand-written autoconf `config.h` stand-in for Linux.

Do not "sync" these files wholesale from upstream without re-running
`make test`; `struct raop_extra` remains mirrored in `ffi.c`. Native session
layouts are not mirrored: `raop-bridge.h` exposes device-ID local release.

## Intentional local patches: connection strategies

| Path                                           | Local contract                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `outputs/raop.c`                               | Device-ID release quiesces all matching native sessions and cancels old queued callbacks before final TEARDOWN. Reuse `session_cleanup/session_free`; retain shared masters for surviving peers. Completion is signalled only after each local control/audio resource is destroyed. Interrupted pairing contexts are freed and cleared; previously freed verification pointers are nullified.                                                                                                                                                                                                                                                                   |
| `evrtsp/evrtsp.h`, `rtsp-internal.h`, `rtsp.c` | Narrow terminal cancel/write/local-close API, preserving a partially written request tail and using the original request serializer/cipher callback. Absolute five-second final-write budget; local close never waits for remote TEARDOWN response or reconnects. Unsent/write/deadline failure is logged separately from successful local destruction.                                                                                                                                                                                                                                                                                                         |
| `ffi.c`, `ffi.h`, `raop-bridge.h`              | Keep the `int raop_free(raop_t*)` ABI. Zero means device-local native sessions/sockets/callbacks were destroyed before handle free, not remote ACK/other-controller availability. Same-handle start/teardown/free are FIFO across the release barrier. Completion resumes a preallocated handle-owned event; registry/refcount stay owned until success. Startup publication and last-runtime shutdown serialize with acquire. Failed scheduling/allocation retains safe ownership and returns -1. Application bootstrap completes libgcrypt initialization before the playback thread; already-finished initialization and secure-memory policy are preserved. |

`transcode.c` also has a narrow sanitizer-driven guard: raw PCM may produce
`AV_NOPTS_VALUE`; unknown PTS bypasses numeric monotonic adjustment and remains
unknown, rather than overflowing on sentinel subtraction. Valid timestamp
adjustment, encoding and RTP clocks are unchanged.

These are targeted lifetime/release changes, not an upstream refresh, codec
rewrite or general network redesign. Verify the old eight native scenarios,
local TCP close with a persistent peer and withheld TEARDOWN reply, lifetime
faults and the Deno/native shared-feed integration before changing them.

## Intentional local patch: sender-source recovery

`outputs/raop.c` snapshots the actual RTSP source used by ANNOUNCE and the
connected RTP source. Before CONNECTED it compares both with the kernel's
fresh preferred source, normalized by family/address/link-local scope (ports
are ignored). Split-source startup fails through deferred terminal failure;
it never takes the native IPv6-to-IPv4 startup-redial path.

Each established session owns one two-second libevent observer. A fresh
nonblocking, close-on-exec UDP socket connects to the numeric receiver,
reads getsockname and closes without sending. Source mismatch, unavailable
route/source, and observation/system errors have distinct bounded diagnostics
and use the ordinary failed event once. The observer cannot reconnect or
change retry authority. This is source selection, not a receiver-liveness test.

Deferred failure fences PCM, retransmits and late FLUSH/CONNECTED publication.
The timer is disarmed before teardown, failure or device-ID release and freed
with its native session, including startup failure and shutdown. Existing
device-ID completion and failed-free ownership remain intact.

`dev/dual-home/run.ts` proves metric-only, loss, startup and cancellation cases
in isolated rootless namespaces on the identified Melofon VM. It observes
actual sender socket inodes, independent RTSP/SDP/RTP/control/timing sources,
and receiver-decoded position-identifiable PCM. Shared control/timing sockets
are not assumed to share RTSP/RTP source pinning.

The kernel peer regression also exposed an old partial-ALAC-input boundary:
when the effective player stops, `player.c` calls the loop-thread
`raop_discard_pending_input()` backend method through `raop-bridge.h`.
Pending raw master input/sample counts are cleared before a fresh feed can
append; surviving peer sockets, RTP clocks and encoded retransmit buffers
remain owned. A handle that never fed the backend does not clear peer input.
