/* ffi.h — libmelofon_raop public API: this is the dlopen surface (see ffi.c
 * for the design notes). The OwnTone player.c stand-in — the pacing tick,
 * the pts clock, the start buffer — is player.c, not part of the API. */
#ifndef MELOFON_RAOP_FFI_H
#define MELOFON_RAOP_FFI_H

#include <stddef.h>
#include <stdint.h>
#include "timeline.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct raop_handle raop_t;
typedef struct raop_stream raop_stream_t;

/* Additive explicit-stream API. A stream owns one PCM ingress/pacer/PTS clock;
 * attachments own device control and release only. Identities are nonzero,
 * monotonically allocated 64-bit incarnations, never RTP or reusable player ids.
 * Dormant streams are allowed; start/probe/write reserves the one active stream
 * BEFORE session allocation. A different stream (including the legacy group)
 * is refused with -2 until the owner's resources are proven released.
 * Metadata/crypto/control-service isolation is not yet multi-stream capable. */
raop_stream_t *raop_stream_new(void);
uint64_t raop_stream_id(raop_stream_t *stream);
raop_t *raop_stream_attach(raop_stream_t *stream);
uint64_t raop_attachment_id(raop_t *attachment);
/* Whole-frame bytes accepted, 0 = bounded ingress full, -1 = invalid/closing,
 * -2 = another stream owns the runtime. Device-oriented raop_write refuses
 * explicit attachments: there is exactly one input port per stream. */
int raop_stream_write(raop_stream_t *stream, const uint8_t *pcm, size_t len);
/* Exact admission, additive to the transitional whole-chunk write port. The
 * caller supplies its captured epoch and opaque nonzero segment identity. A
 * receipt attributes ONLY the copied prefix, in stereo frames, to that input;
 * retry only the unaccepted suffix. It is not packetization or playout proof.
 * Segment markers/seals are a separate ordered contract. No id is truncated.
 *
 * All fields are uint64_t (40 bytes, native byte order) for callback-free FFI.
 * Return 0 means a receipt was written, including error/canceled/not-ready;
 * -1 means no result storage was supplied. No result enters the state ring.
 * Empty valid input is accepted with zero frames. Partial or zero nonempty
 * acceptance is backpressure. Error/canceled/not-ready never accept frames.
 * Admission shares rt.lock with stream lifecycle/control admission. The initial
 * epoch is nonzero; ordered epoch cancellation/receiver readiness is separate
 * from the transitional local reset below. Serialize readers with free. */
struct raop_append_result {
  uint64_t epoch;
  uint64_t segment;
  uint64_t accepted_frames;
  uint64_t status;
  uint64_t error;
};
uint64_t raop_stream_epoch(raop_stream_t *stream);
int raop_stream_append(raop_stream_t *stream, uint64_t epoch, uint64_t segment,
                       const uint8_t *pcm, size_t len,
                       struct raop_append_result *result);
/* Ordered timeline input, additive to append. source is an incarnation, segment
 * an opaque core range identity. A source must be sealed before the next source
 * starts. target is its exclusive SOURCE-LOCAL accepted-frame count; end target
 * is the epoch's exclusive accepted real-frame count. Both are immutable and
 * retries of the same marker are idempotent. Seal never pads/ends a stream.
 * Once timeline input starts, unlabelled write/append and the legacy local reset
 * are refused; only ordered cancel can open a fresh accounted epoch.
 * Fixed marker storage applies backpressure, never drops a range. This stage
 * retains records until cancel/free; completion/ack is a separate contract.
 * Status/error use raop_append_status/error. All fields u64, native byte order.
 */
int raop_stream_append_source(raop_stream_t *, uint64_t epoch, uint64_t source,
                              uint64_t segment, const uint8_t *, size_t,
                              struct raop_source_append_result *);
int raop_stream_seal(raop_stream_t *, uint64_t epoch, uint64_t source,
                     uint64_t target, struct raop_marker_result *);
int raop_stream_end(raop_stream_t *, uint64_t epoch, uint64_t target,
                    struct raop_marker_result *);
/* Coherent pacer facts only, NOT scheduled/successful submission/completion.
 * source/range: 1 found, 0 absent/stale, -1 invalid. index starts at 0. Silence
 * has source/segment/offset zero and never advances source fed_frames. */
int raop_stream_source(raop_stream_t *, uint64_t epoch, uint64_t source,
                       struct raop_source_snapshot *);
int raop_stream_range(raop_stream_t *, uint64_t epoch, uint64_t index,
                      struct raop_range_snapshot *);
/* Cancel is admitted synchronously under the append lock. It advances epoch
 * before return; replacement append is not-ready until local reset and every
 * affected session's FLUSH ACK or destruction. No natural drain wait.
 * Poll retains the result until ack, outside the state ring. All fields u64.
 * status: 0 pending, 1 ready, 2 superseded/canceled, 3 failed. cutoff_frames is
 * scheduled contiguous old-epoch transport coverage at admitted_ns, NOT accepted
 * input or a physical-render acknowledgement. Zero if no healthy coverage.
 * Poll returns 1 found / 0 absent. Ack refuses pending results. Serialize free
 * with callers; free cancels and destroys retained storage after attachments. */
struct raop_cancel_result {
  uint64_t epoch, next_epoch, status, cutoff_frames, admitted_ns;
  uint64_t local_reset;
};
int raop_stream_cancel(raop_stream_t *stream, uint64_t epoch);
/* Same atomic boundary; these immutable attachment identities retire instead of
 * FLUSH. Others retain the default FLUSH disposition. Reject foreign/duplicate
 * identities before advancing epoch; capture cutoff before any retirement. */
int raop_stream_cancel_v2(raop_stream_t *stream, uint64_t epoch,
                           const uint64_t *retire_ids, size_t retire_count);
int raop_stream_cancel_poll(raop_stream_t *stream, uint64_t epoch,
                            struct raop_cancel_result *result);
int raop_stream_cancel_ack(raop_stream_t *stream, uint64_t epoch);
/* Wait for loop-owned local ingress/partial reset. Serialize with write/reset/
 * free: caller fences and joins admitted writers before calling and holds new
 * input until return. This is not a receiver FLUSH acknowledgement. */
int raop_stream_reset(raop_stream_t *stream);
/* Free after every attachment has completed raop_free. Returns -2 while any
 * attachment still owns storage (including retirement); caller may retry.
 * 0 proves loop-thread pacer destruction; -1 retains the stream on failure.
 * Serialize free with readers/writers; no calls after successful free. */
int raop_stream_free(raop_stream_t *stream);

/* Exclusive library-wide diagnostic consumer. Install before native init.
 * This queue is independent of raop_poll's control events and device handles.
 * enable=1 returns -1 if another consumer owns it; enable=0 requires callers
 * to quiesce/free their handles and drain first. Standalone consumers retain
 * their native diagnostic transport when no consumer is installed. */
int raop_log_consumer(int enable);
/* Copies one owned JSON transport record (capture UTC milliseconds, sequence,
 * source severity/domain, typed facts or opaque payload). 0=empty; -1=buffer
 * too small/invalid. Records are retained on -1. Overflow counts are observable
 * even without a subsequent producer record. No pointer crosses this API. */
int raop_log_poll(char *buf, size_t cap);

/* One handle per AirPlay device. The first handle starts the library's
 * background loop thread (libevent; player.c's 10 ms pacing tick arms when
 * the session reports CONNECTED); the last raop_free stops and joins it. */
raop_t *raop_new(void);

/* Queue a session start: RTSP OPTIONS/ANNOUNCE/SETUP/RECORD to host:port
 * (RAOP default 7000), name for logs, volume 0-100. devtype is the raop.c
 * device enum (0=apex1 1=apex2 2=apex3 3=appletv 4=appletv4 5=homepod
 * 6=other; out of range defaults to appletv); encrypt != 0 encrypts the
 * RTP stream. Events arrive via raop_poll:
 * starting|connected|streaming|stopped|failed|password. */
/* pos_ms/len_ms/title/artist are the current item; the player sends them
 * on the stream clock after output_buffer_samples (not as a pre-start
 * seed). wanted_metadata is the TXT md bitmask (1=text 2=artwork 4=progress);
 * authsetup/requires_auth are the TXT et=4 / sf-bit-9 flags. */
int raop_start(raop_t *h, const char *host, int port,
               const char *name, int volume, int devtype, int encrypt,
               uint32_t pos_ms, uint32_t len_ms,
               uint16_t wanted_metadata, int authsetup, int requires_auth,
               const char *title, const char *artist);

/* Additive credential input. Old raop_start remains credential-free.
 * Password is UTF-8 bytes, 0..4096 bytes; NULL/0 means absent (a non-NULL
 * pointer with length zero is an empty password). Pairing key is NULL/0 or
 * exactly 128 ASCII hex bytes. Embedded NULs and invalid lengths reject the
 * whole command with -1. No truncation. Inputs are copied before return,
 * transferred to device ownership on the loop. Password survives until native
 * local release; keys are erased before native invalidation/replacement or
 * local release. Neither input is diagnostic data. */
int raop_start_v2(raop_t *h, const char *host, int port,
                  const char *name, int volume, int devtype, int encrypt,
                  uint32_t pos_ms, uint32_t len_ms,
                  uint16_t wanted_metadata, int authsetup, int requires_auth,
                  const char *title, const char *artist, int has_password,
                  const uint8_t *password, size_t password_len,
                  const uint8_t *auth_key, size_t auth_key_len);

/* Same validated/copied input as start_v2, but vendor device_probe only.
 * No ANNOUNCE/SETUP/RECORD or audio. Caller owns the bounded control lifetime. */
int raop_probe_v2(raop_t *h, const char *host, int port,
                  const char *name, int volume, int devtype, int encrypt,
                  uint32_t pos_ms, uint32_t len_ms,
                  uint16_t wanted_metadata, int authsetup, int requires_auth,
                  const char *title, const char *artist, int has_password,
                  const uint8_t *password, size_t password_len,
                  const uint8_t *auth_key, size_t auth_key_len);

/* Append s16le/44100/stereo PCM to the pacing buffer. Returns bytes
 * accepted; < len means the buffer is at the high-water mark (caller
 * retries — that is the backpressure). */
int raop_write(raop_t *h, const uint8_t *pcm, size_t len);

int raop_volume(raop_t *h, int pct);

/* Compatibility handle: drop its buffered PCM and FLUSH the device. Explicit
 * attachment: FLUSH this device only, never the shared PCM/PTS owner. Ordered
 * stream cancellation/reset is a separate contract, not attachment removal. */
int raop_flush(raop_t *h);

int raop_teardown(raop_t *h);

/* Deliver the PIN the device is showing (verification flow). */
int raop_pin(raop_t *h, const char *pin);

/* Drain one pending event as a JSON line. Returns bytes written (0 = no
 * events), -1 on error. */
int raop_poll(raop_t *h, char *buf, size_t cap);

/* Private pairing state, independent of the lossy state/diagnostic rings.
 * 0=empty, 1=128-byte hex key (+ NUL), 2=clear tombstone, -1=invalid,
 * -2=key buffer too small (nothing consumed). revision is nonzero and strictly
 * increasing per handle. Poll leases a snapshot; repeated polls return that
 * exact snapshot until ack. Updates while leased retain the latest newer state
 * for the next poll. This is a state mailbox, not an event history.
 * Never log its bytes. NULL key is used only with a clear tombstone.
 * Caller must serialize poll/ack with free; no calls after free begins. */
int raop_credential_poll(raop_t *h, uint64_t *revision, char *key, size_t cap);
/* 1=exact leased revision acknowledged, 0=stale/unknown revision, -1=invalid.
 * Ack only after the private consumer accepts the state (durably for adopted
 * speakers). Teardown retains unacked state; explicit free erases/cancels it. */
int raop_credential_ack(raop_t *h, uint64_t revision);

/* Teardown (if needed), destroy all device-local native sessions/control
 * sockets/queued callbacks, free, and release the shared runtime. Returns 0
 * only after local connection destruction (not remote ACK/peer availability),
 * -1 when the free could not be queued — the handle is then leaked BY
 * DESIGN (never a use-after-free) and the caller must treat cleanup as
 * failed, not report retirement success. May block for the native five-second
 * final-write budget: Deno declares this function nonblocking and awaits it. */
int raop_free(raop_t *h);

#ifdef __cplusplus
}
#endif

#endif /* MELOFON_RAOP_FFI_H */
