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
