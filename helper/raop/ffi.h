/* ffi.h — libmelofon_raop public API: this is the dlopen surface (see ffi.c
 * for the design notes). The OwnTone player.c stand-in — the pacing tick,
 * the pts clock, the start buffer — is player.c, not part of the API. */
#ifndef MELOFON_RAOP_FFI_H
#define MELOFON_RAOP_FFI_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct raop_handle raop_t;

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

/* Append s16le/44100/stereo PCM to the pacing buffer. Returns bytes
 * accepted; < len means the buffer is at the high-water mark (caller
 * retries — that is the backpressure). */
int raop_write(raop_t *h, const uint8_t *pcm, size_t len);

int raop_volume(raop_t *h, int pct);

/* Drop buffered PCM and FLUSH the device (pause semantics; the stream clock
 * continues for resume). */
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
