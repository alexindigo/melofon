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

`tests/raop-source-probe.test.ts` covers the native source-address contracts;
the kernel route-change result is recorded in
`~/Documents/melofon/plans/airplay-dual-home-recovery/report.md`.

The kernel peer regression also exposed an old partial-ALAC-input boundary:
when the effective player stops, `player.c` calls the loop-thread
`raop_discard_pending_input()` backend method through `raop-bridge.h`.
Pending raw master input/sample counts are cleared before a fresh feed can
append; surviving peer sockets, RTP clocks and encoded retransmit buffers
remain owned. Feeding is scoped to the current streaming epoch: the loop-owned
`fed_in_epoch` marker is set only after an actual backend write, initialized
after the idempotent start guard and cleared after a genuine stop. Cumulative
`fed_samples` remains a lifetime diagnostic. Read-ahead acceptance is not
backend feeding; FLUSH and repeated CONNECTED/STREAMING notifications do not
clear the active marker. A non-feeding epoch leaves peer input intact even if
the same native handle fed in an earlier epoch.

`test/probe_player_epoch.c` and `tests/raop-player-epoch.test.ts` compile the
actual helper graph independently, observe shared-master bytes/sample counts
only on the native loop and compare the surviving receiver's complete decoded
352-frame ALAC block byte-for-byte. They cover same-handle non-feeding restart,
fresh never-fed release, successive feeding epochs, repeated stop, repeated
active state notifications, FLUSH and pre-connection read-ahead. This narrowly
covers the supported native C API: normal `FfiTransport` retains its sole feed
token until free and constructs fresh replacement handles. It does not elect
native feed producers or authorize competing PCM feeds.

## Device credential input

`raop_start_v2` adds length-delimited per-device password and restored fruit
key inputs while preserving `raop_start`. Commands copy and own the bytes until
loop-thread transfer to `output_device`; the stub erases/frees remaining strings
after native local release. Native discovery/config strings are not used. Invalid
lengths, NULs and non-hex fruit keys reject the entire command without truncation.
The local `outputs/raop.c` patch removes digest Authorization debug output;
`MELOFON_RAOP_DEBUG` must never expose credentials or digest responses. Pair-key
export and invalidation acknowledgement use a separate ABI, not this start input.
Existing native key invalidation/replacement paths also erase the old owned key
before freeing it.

## Pairing credential export

`db_speaker_save` copies into `raop_ffi_credential_changed`, not a pretend database
write. Success means the handle owns a copy, not that core has persisted it. The
dedicated `raop_credential_poll` / `raop_credential_ack` ABI transfers private state
with a monotonically increasing per-handle revision and explicit clear tombstones.
It never uses the state or diagnostic ring, foreign-thread JS callbacks or SQL.

Each mutex-protected mailbox holds the latest state plus one leased snapshot.
Poll retains the exact leased revision until its acknowledgement; newer updates
coalesce into the latest state and cannot overwrite that lease. An old ack never
erases a newer update or tombstone. An undersized buffer consumes nothing. Key
storage is fixed at 129 bytes (128 fruit hex bytes plus NUL), erased on replacement,
ack and explicit handle free. Teardown alone retains unacknowledged state. Callers
serialize polling/ack with free; close explicitly cancels that handle's mailbox.

All three native key-invalidation paths use one erase-and-export helper. Failed
verification responses (200 with invalid verification data, 401 or 403) and
locally malformed keys clear; missing network responses and server errors do not
revoke credentials. Successful setup checks allocation/export before stopped.
The TS drain has one asynchronous receipt in flight, acknowledges only after the
private consumer resolves, retries rejection without logging its error, and
fences late acknowledgements before native free. It registers output keys for
central redaction before consumer code. The device adapter now binds receipt
consumers to stable identity, endpoint, incarnation and credential revision.
Core encrypts adopted results before the store call; only successful acceptance
permits acknowledgement. FFI emits a safe saved/cleared completion after ack;
ordinary stopped events alone cannot report pairing success. Retired handles
cancel receipts and never acknowledge late work against freed pointers.

`raop_probe_v2` is additive and shares start_v2's copied/validated credential
input, but calls the vendor's `device_probe`, not `device_start`. Explicit
pair operations use it with no old pairing key, no PCM and a bounded owned
control lifetime. PINs are exactly four digits at both boundaries and erased
after enqueue. The vendor pin-start callback cleans its probe session before
`device_authorize` creates setup's session. Setup completion needs both the
acknowledged key receipt and stopped; normal playback is re-entered only under
the existing user intent, never from the credential cache itself.

`test/probe_pairing_export.c` is compiled only by the Deno native test. It includes
the actual bridge/backend to drive the real stub export and all three native
invalidation paths; it is not a product test backdoor. The test proves full-key
copy, exact ack, coalescing, tombstones, small-buffer retention, delayed/failing
private receipt, close/forget races and absence from debug diagnostics. This is
bridge plumbing, not a cryptographic PIN receiver or Apple TV acceptance.

## Shared logging ingress

`stub/stubs.c` owns diagnostics: typed `helper_log_event` facts for Melofon-owned
FFI/player events and a printf-compatible adapter for available vendored text.
The library-wide `raop_log_consumer`/`raop_log_poll` ABI is additive and separate
from each handle's `raop_poll` control queue. Install the exclusive consumer
before initialization; quiesce/free owned handles and drain before disabling it.
The Deno adapter owns a single library-wide drain, through last-handle release,
and performs final owned-shutdown draining. Failed free retains native ownership.

Diagnostics capture realtime milliseconds/sequence into a dedicated 256-record
queue with 2048-byte opaque-message bounds. Producers use a try-lock and never
wait on the JS consumer or allocate diagnostic JSON on the pacing thread.
Polling copies records into caller-owned buffers; JSON here is ingress transport,
not the application's final log format. Overflow/truncation counts remain visible,
including overflow with no later producer record. No foreign-thread JS callback
or private native handle mirror is introduced.

The native library installs supported system FFmpeg and libevent callbacks;
libevent's callback copies data without calling libevent. node-av's embedded
FFmpeg copy has its separate module-owned callback. Requalify linkage before a
shared-library/source-build variant; competing global callbacks are not assumed
safe. Source severities/domains remain available while central schemas assign
canonical owned-event severity and readable fields.

Standalone consumers without the Deno diagnostic consumer retain native output;
assertion/loader/allocator and unsupported library failures are not suppressed.
`DEBUG_PAIR` key-dump paths remain disabled. The compiled object inventory rejects
enabled raw writers/key-dump symbols outside the logger transport; its negative
fixture proves a raw writer is detected. `test/probe_logging.c` verifies bounded
queue/copy/consumer ownership without touching control or pacing structures.
