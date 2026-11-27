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
`make test`; `struct raop_extra` is shared through `raop-bridge.h`. Native session
layouts are not mirrored: `raop-bridge.h` exposes device-ID local release.

## Intentional local patch: receiver-local first-sync anchor

`outputs/raop.c` retains each receiver's exact RECORD/FLUSH RTP timestamp until
its first sync is sent. Another peer may keep the shared master advancing during
that handshake. `rtp_common` accepts an explicit sync position so this receiver's
first sync matches RTSP without rewinding the master or changing other peers.
Both sides of the live RTP/NTP correlation are translated by the same frame
interval; periodic sync and native scheduled progress retain the live clock.

On cold start, or when no cached packet meets the buffering cutoff, the
anchor is the master's next packet. This live-cursor fallback is normal and
is not a failed backfill.

For every joining receiver, RECORD selects the oldest contiguous committed
packet whose presentation deadline leaves the receiver's 250 ms buffering
interval for the RECORD/first-sync round trip. RECORD advertises the anchor's
timestamp and sequence number plus one for both cached and cold-start anchors.
The first sync is marked; initial
audio packets are not. The master keeps pacing ready peers without rewinding.

First sync admits the still-deliverable cached suffix. One bounded send cursor
per receiver drains both that suffix and timer-overrun audio in order from the
existing RTP ring. This avoids bursts overflowing a receiver's UDP queue now
that all packets are 1423 bytes. Ordinary writes do not reach the burst limit;
pending sends resume on the next player tick, even without new PCM. Only
on-time sends extend coverage, and neither backfill nor catch-up moves the
presentation clock.

This follows upstream `rtp_common.c`'s documented first-sync/RTSP compatibility
requirement (Eufy Genie) and the RECORD and sync definitions in sections 5.1-5.2
of <https://nto.github.io/AirPlay.html>. Deterministic delayed-RECORD proofs cover
master advancement shorter and longer than the transport buffer lead, through
the unchanged strict scheduled receiver and exact decoded PCM assertions.

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

## Explicit stream ownership (additive migration surface)

`ffi.h` exposes a stream-owned PCM/pacer/PTS lifetime and immutable device
attachments, with 64-bit stream and attachment incarnations. `output_device`,
native sessions, masters and `output_buffer` carry that stream identity.
Master sharing, writes, CONNECTED promotion and pending-input discard match
the addressed stream; removing one attachment never stops a healthy peer's
pacer or clears its partial ALAC input.

The compatibility device API retains device-local pacers and exclusive legacy
input in group 1; production playback uses one fixed-player stream producer.
Explicit contexts activate concurrently without sharing PCM or native masters.
Dormant streams retain a runtime reference; native free refuses while any
attachment is still owned, including during terminal release. The typed port
joins its C1 producers, attempts all C3 attachment releases, then frees the
stream on the loop. Failed native release retains its storage and runtime reference.

`tests/raop-stream.test.ts` exercises the shipping public FFI through real UDP,
ALAC decoding and the independent scheduled receiver model, including both
attachment-removal orders and concurrent compatibility/explicit contexts.
Core demand/resource ports independently retain each fixed player's stream.

## Stream-local metadata and crypto

`outputs/raop.c` lazily owns one backend context per stream incarnation. It
retains metadata, AES key/IV/cipher and matching RSA-OAEP/base64 SDP material
across attachment/master retirement. Stream free, after all device joins,
purges only that context and erases its key copies. Runtime crypto bootstrap,
the timing service and the 25-second keepalive scheduler remain shared.

Metadata sends filter by stream; startup and keepalive select the session's
context without mutating another receiver's startup projection. Content is
built independently of the first receiver's metadata wishes. The additive,
callback-free `raop_stream_metadata` port retains current transport metadata
even for a dormant stream and reserves storage through loop dispatch. It is
not a source-marker scheduling API; natural-boundary policy remains in core.

`tests/raop-stream-isolation.test.ts` exercises dormant/current replacement,
purge, retirement, receiver wishes and the real keepalive interval. The
test-only `test/crypto-observer.c` observes libgcrypt in memory, independently
unmasks RSA-OAEP input, matches it to the cipher key and SDP output, and decrypts
actual receiver ciphertext for exact ALAC/scheduled assertions. It never
exports or logs keys and is not linked into the shipping library. Encrypted
and unencrypted masters remain distinct within one stream. Sequential and
concurrent proofs retain independent keys through foreign retirement; neither
qualifies physical hardware.

## Stream control endpoints

Each backend context owns a dynamically bound control/sync service, advertised
by that stream's SETUP and retained until stream free. Timing replies remain
stateless on the shared timing service. Retransmit lookup matches the receiving
service, stream incarnation, normalized receiver address (including IPv4-mapped
IPv6 and link-local scope) and negotiated control source port. Unknown, retiring
or ambiguous endpoints cannot select a session/cache. IP-only lookup is removed.

The existing ordered-cancel fence and `rtp_session_flush` revoke old cache
authority before replacement input; receiver ACK/destruction still gates the
new epoch. Same-IP public-FFI tests force overlapping sequence numbers and wrap,
check exact retransmitted packet identity at each destination, reject spoofed
and old endpoints, and independently render the retained/replacement schedules.

## Concurrent native lifetime

One runtime reference belongs to every stream and device, including dormant and
probe-only owners. Removing A cannot deinitialize B's loop or timing service.
Every stream-affecting iteration selects a stream, exact master or unique device;
only final runtime shutdown visits all contexts. Native admission has no global
active-stream slot. A failed close retains its own reference and resources.
Partial master/session construction unwinds owned allocations without aborting
the shared process. Test-only dependency interposition checks rollback and failed
release while B's exact partial input and schedule survive; the encoder observer
confirms same-stream sharing and cross-stream separation without private ABI mirrors.

Native acceptance also holds a loop-dispatched completion read after its storage
reservation while typed close fences input and joins that read. Other streams
continue emitting; no callback or test hold enters the shipping library.
Stream-targeted dependency faults exercise encoder, cipher, packet allocation,
send, sync and timer failure without crediting a failed source as complete.
Long independently scheduled timelines force both RTP counters through wrap,
retain 24 source receipts beyond lossy state-ring overflow, and verify exact real
PCM plus zero-only declared transport silence. Delayed terminal writes and fresh
stream incarnations cannot stop a foreign timeline. Encrypted and plaintext
combinations use the real cipher observer and independent ALAC consumer.
HTTP admits concurrent players with disjoint speakers. Native concurrency does
not bypass core's exclusive speaker membership and receiver release barriers.

## Exact stream admission

`raop_stream_append` adds an epoch/segment-qualified, caller-owned receipt with
an exact accepted stereo-frame count and accepted/backpressure/canceled/error/
not-ready status. The fixed-width layout is declared in `ffi.h`; missing symbols
fail library loading rather than falling back to a byte-only ABI. The existing
two-second per-stream ingress bound remains. Allocation failure is
distinct from a full ingress. PCM is copied before return; only the unaccepted
suffix may be retried. Segment identity is opaque, not native queue policy.

The typed `AirplayExactStream` uses the existing C1/C3 stream owner and is adopted
through the lazy device boundary by production playback. The boot accounts each
accepted prefix and retries only its unaccepted suffix with the same segment and
captured epoch. Transitional local reset remains for compatibility callers; it
fences new exact admission until its callback applies, but does not
change epochs or prove receiver FLUSH readiness. Retained source markers and
scheduled completion remain separate work. Test-only
allocation/reset barriers in `test/faultinject.c` are never linked into the
shipping library. `tests/raop-stream-cancel.test.ts` exercises both the public
native receipt ABI and typed port through actual scheduled ALAC consumers.

## Ordered stream cancellation

`raop_stream_cancel` shares append admission, advances the captured epoch and
fences the pacer and old packet/cache authority before returning. A preallocated
stream event applies ingress/partial/encoded/cache reset on the native loop.
Replacement append reports not-ready until every affected session acknowledges
its ordered FLUSH or is locally destroyed. Old startup sessions are destroyed;
their delayed callbacks cannot publish CONNECTED. Device START/FLUSH commands
capture epochs, and a device FLUSH cannot compete with an ordered cancellation.
Repeated cancellation may share an in-flight session FLUSH only while no new
input was admissible. No old reset can clear an accepted replacement prefix.

The separate cancel poll/ack list retains every terminal receipt until explicit
acknowledgement or stream free, independent of the state ring. It records native
monotonic admission time, applied local reset and the slowest contiguous submitted
scheduled cutoff, using successful RTP/sync coverage and receiver offset/latency
once. This is not accepted PCM, natural completion, physical sound or a core
bookmark projection. Close cancels typed poll waiters, joins them through C1 and
then destroys attachments and stream storage through the existing C3 owner.
The production boot commits its source transition before acknowledging the cancel
receipt and retains older cancel/ack work in the stream release barrier. Decoder
acquisition never holds the native fence; shutdown revokes native polling before
joining source acquisition and cleanup.

`raop_stream_cancel_v2` additionally copies a set of retiring attachment identities
at the same admission boundary. Unknown, foreign or duplicate identities reject
without advancing epoch. Other attachments retain the original FLUSH default.
The loop snapshots the whole old cohort's scheduled cutoff before resetting any
schedule or queuing the selected device retirements through the existing owned
TEARDOWN/release queue. Those sessions never receive FLUSH, and only their local
destruction establishes readiness. A concurrently admitted FREE provides that
same destruction proof rather than becoming a failed redundant teardown.
Production strategies supply these dispositions privately through the adapter;
the core never constructs native attachment identities. Both unchanged native
40-seek recycle batteries and the HTTP/decoder scheduled-prefix consumers cover
the mixed-retire/retain path. Natural seal/end/tail completion and public native
media-position projection remain separate contracts.

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
queue with 2048-byte opaque-message bounds. Producers reserve slots atomically
and publish after copying; only a full queue counts as loss. Producers never
take the poller's lock or allocate diagnostic JSON on the pacing thread.
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
queue/copy/consumer ownership and publication during encoding without touching
control or pacing structures.

## Ordered timeline ingress

The additive `raop_stream_append_source` / `seal` / `end` port shares the exact
append/cancel admission lock. Source-local exclusive targets and epoch-wide real
input offsets are distinct from transport frames. A seal does not flush, pad or
end the stream. Final end permits packet-aligned zero padding, followed by paced
drain silence; absent input after the first real frame yields labeled underrun
silence. Neither silence nor handshake time advances real-source counters.

`timeline.h` holds value-only ABI records without importing public entry points
into vendor translation units. The pacer retains 256 source markers until terminal
acknowledgement. Its separate ingress queue contains only undispatched PCM and
reclaims slots as it dispatches. Contiguous queued input from the same source
coalesces irrespective of decoder chunk identity, so the two-second PCM cap, not
chunk count, controls ingress backpressure. Transport history coalesces adjacent
real coverage with matching source and offsets. A mixed-identity real range has
segment zero; append receipts still carry each exact opaque input identity.
Genuine discontinuities remain exact, with history storage reserved on admission
before copying bytes, never allocated by the pacer. Allocation failure is explicit.
Polling source/range records
observes admission and pacer dispatch only, not successful submission, scheduled
playout or completion. Timeline input refuses unlabelled writes in that epoch.
The production boot uses source-labelled append/seal/end and retained completion.
The legacy local reset is refused once timeline input starts: only ordered cancel
can retire those identities and admit replacement input in a new epoch.

## Scheduled timeline progress

`raop_stream_progress` dispatches one coherent observation onto the native loop:
successful contiguous per-attachment packet coverage, the monotonic presentation
boundary established by successful RTP/sync/NTP output, and projection through
the source/transport range ledger. Receiver latency is included once, along with
the existing device offset. Wide epoch frame counters do not wrap with RTP.
Attachment zero selects the group intersection and slowest boundary. A late join
covers only its explicit suffix; no participants means waiting, never success.
Source zero selects transport-only projection. Silence advances transport, not
source frames. Snapshot reads reserve storage and the typed operation owner joins
them before native release.

Packet allocation, encoding, cipher and timer failures retain an explicit epoch
failure and the last proven group prefix. Attachment startup, send and sync
failures settle that attachment and leave viable peers pacing; loss of every
viable attachment also freezes shared diagnostics. Packet fanout validates its
cohort and commits the shared RTP packet exactly once before dispatch. Each
receiver's coverage only advances on successful send, even when another fails.
An attachment-local send failure, including loss of a master's only receiver,
does not abort feeding other masters of the stream. Mixed encrypted/plain
master regressions verify exact healthy PCM with both input APIs.
Failed snapshots remain frozen until ordered cancel/reset. Pacer catch-up checks
each packet's established presentation deadline before emission, and again after
send. An overdue live write fails the epoch; an overdue queued send fails the
lagging receiver. Successful submission alone is not playout.
The compatibility local-reset path reanchors the pacer and orders a fresh wire
sync for its retained attachments together. It cannot reuse an old presentation
deadline after changing the input clock. Accounted epochs still refuse local
reset and require ordered cancel; this adds neither FLUSH nor receiver reopen.

`test/progress-faultinject.c` is compiled only by the timeline consumer tests.
It controls dependency failures and actual timer expirations, exercises the
existing backend offset field and forces wire counter wrap. Encoder faults and
per-master isolation observe the verbatim ALAC encoder call and its caller-owned
buffer. No test controls are linked into production. Scheduled progress is not
a retained source completion. Public scheduled position is a separate core
projection.

## Retained source completion

Seal reserves a retained receipt and captures the immutable stream/epoch/source,
exclusive target, input end and attached incarnation/session cohort. A native-loop
observation completes each required peer only after all real source frames were
packetized, contiguously submitted and scheduled through their final exclusive
boundary. Terminal values remain outside the lossy device ring until exact ack,
including across cancel. Shared native failures fail pending contributors;
device-specific loss retains that attachment's failure, not success. Empty sources
and empty cohorts fail explicitly. Late joins cover suffixes only and cannot
satisfy missing earlier source frames.

Voluntary teardown/FLUSH retires that captured session as withdrawn. An explicit
revision can exclude withdrawn/failed outcomes from the same immutable source
target. It creates a new retained barrier and keeps exclusions visible; it never
edits the original terminal receipt. Captured session facts keep receiving lifecycle
outcomes behind the frozen result, so a revision sees losses that happened after
an earlier peer failed. With an epoch failure the pacer cannot supply
a missing suffix: a revised healthy peer lacking full submission fails rather than
waiting forever. Already submitted healthy coverage can still reach its actual
presentation boundary. Broader source recovery remains the core's responsibility.

The retained receipt bound is 256, including old epochs and revisions. Source
admission reserves its seal slot; exhaustion applies backpressure without losing
terminal values. The last exact ack of a source's revisions reclaims its retained
source/range observations, including associated silence. Range indices are
view indices and compact at ack; offsets remain epoch-absolute. Acknowledged source
incarnations must not be reused. Source/progress range projections cover retained
observations only after ack. Queued failed input is not reclaimed ahead of cancel.

Only ended streams stop pacing after ingress and final packet padding are
exhausted and surviving healthy transports pass the actual final real-frame
boundary. A failed or acknowledged receipt cannot stop queued playback. Every
ordered epoch transition resets transport frame zero before recording ranges.
A natural source seal never ends the stream or releases its receivers. Typed poll,
wait, revision and ack use the existing C1 operation owner. Close first fences
native input and settles pending results as canceled, then joins all readers and
waiters before C3 attachment/stream release. Native reader reservations prevent
raw free from reclaiming queued poll readers. Failed-free quarantine is unchanged.

## Source-cutoff bridge

`raop_stream_cancel_source` adds an identified source projection to the ordered
cancel boundary. Before the old range ledger is cleared, its real-source frames
are projected at the captured admission timestamp, excluding underrun/padding/
drain silence. `raop_stream_cancel_source_poll` retains this immutable observation
with the existing cancel receipt until its exact epoch ack. Waiting/no-peer and
failed prefixes remain explicit; failure cannot credit a later presentation time.
Legacy exact cancel and its transport-cutoff receipt remain unchanged. The lazy
device owner now forwards timeline ports with the existing operation/release
lifetime; core public position adoption remains separate from the end gate.

Failed source receipts do not by themselves finish an ended transport. The pacer
retains its exclusive final real transport boundary independently of reclaimable
source markers, and continues healthy queued audio/padding until that scheduled
boundary passes. A later explicit cohort revision therefore cannot strand an
unsubmitted healthy tail behind a prematurely stopped pacer. Irreversible epoch
failure remains explicit and requires ordered cancellation/recovery.

## Production end-gate adoption

Core binds each opened reader to an immutable native source, retains sink
authority after reader cleanup and requires matching sealed EOF plus native
completion before natural advance/consume/stop. Exact ack follows the committed
core transition or cancellation, not EOF or receipt polling. Explicit commands
still cancel; source completion does not release speakers or public capacity.

Catalog logical eligibility stays separate from native source progress. The
additive `raop_stream_compatibility_silence` labels paced zeros after sealed
catalog EOF while core waits for that deadline. It shares epoch/source admission
fencing and never credits media frames. A delayed stream end retains the last
real transport boundary rather than moving it across those zeros. Native-loop
completion polling also applies ended-pacer retirement before returning the
terminal result; required real coverage and scheduled presentation remain the
retirement proof. Finite web EOF and live EOF failure keep their distinct policy.
