/* ffi.h — libmelofon_raop public API (see ffi.c for the design notes). */
#ifndef MELOFON_RAOP_FFI_H
#define MELOFON_RAOP_FFI_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct raop_handle raop_t;

/* One handle per AirPlay device. The first handle starts the library's
 * background loop thread (libevent + 10 ms pacing tick); the last raop_free
 * stops and joins it. */
raop_t *raop_new(void);

/* Queue a session start: RTSP OPTIONS/ANNOUNCE/SETUP/RECORD to host:port
 * (RAOP default 7000), name for logs, volume 0-100. devtype is the raop.c
 * device enum (0=apex1 1=apex2 2=apex3 3=appletv 4=appletv4 5=homepod
 * 6=other; out of range defaults to appletv); encrypt != 0 encrypts the
 * RTP stream. Events arrive via raop_poll:
 * starting|connected|streaming|stopped|failed|password. */
int raop_start(raop_t *h, const char *host, int port,
               const char *name, int volume, int devtype, int encrypt);

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

/* Teardown (if needed), free, and release the shared runtime. */
void raop_free(raop_t *h);

#ifdef __cplusplus
}
#endif

#endif /* MELOFON_RAOP_FFI_H */
