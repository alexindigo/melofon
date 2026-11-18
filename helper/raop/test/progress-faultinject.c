/* Test-only controls over the shipping library's real dependency boundaries.
 * Never built/linked into production. No configuration or secret export. */
#define _GNU_SOURCE
#include <config.h>
#include <dlfcn.h>
#include <errno.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/socket.h>
#include <sys/timerfd.h>
#include <gcrypt.h>
#include <netdb.h>
#include "outputs.h"
#include "transcode.h"

static void *symbol(const char *name, const char *library)
{
  void *p = dlsym(RTLD_NEXT, name);
  if (!p) p = dlsym(dlopen(library, RTLD_NOW | RTLD_LOCAL), name);
  if (!p) abort();
  return p;
}
static int arm(const char *kind)
{
  const char *mode = getenv("RAOP_PROGRESS_FAULT");
  const char *path = getenv("RAOP_PROGRESS_ARM");
  return mode && path && !strcmp(mode, kind) && unlink(path) == 0;
}
static int player_timer = -1;
int getaddrinfo(const char *host, const char *service,
                const struct addrinfo *hints, struct addrinfo **result)
{
  if (host && !strcmp(host, "invalid host")) return EAI_NONAME;
  int (*real)(const char *, const char *, const struct addrinfo *, struct addrinfo **) =
    symbol("getaddrinfo", "libc.so.6");
  return real(host, service, hints, result);
}
int timerfd_create(int clock, int flags)
{
  int (*real)(int, int) = symbol("timerfd_create", "libc.so.6");
  int fd = real(clock, flags);
  Dl_info info;
  if (dladdr(__builtin_return_address(0), &info) && info.dli_sname &&
      !strcmp(info.dli_sname, "raop_player_new")) player_timer = fd;
  return fd;
}
ssize_t read(int fd, void *buffer, size_t size)
{
  if (fd == player_timer && size == 8 && arm("timer")) {
    errno = EIO; return -1;
  }
  const char *path = getenv("RAOP_PROGRESS_HOLD");
  if (fd == player_timer && size == 8 && path && access(path, F_OK) == 0) {
    /* Keep timer expirations intact; libevent still services progress queries.
     * Release gives the real pacer the full overrun, not an invented clock. */
    usleep(1000); errno = EAGAIN; return -1;
  }
  ssize_t (*real)(int, void *, size_t) = symbol("read", "libc.so.6");
  return real(fd, buffer, size);
}
ssize_t send(int fd, const void *buffer, size_t size, int flags)
{
  const uint8_t *bytes = buffer;
  static int countdown;
  if (size >= 12 && (bytes[1] & 0x7f) == 0x60) {
    if (arm("send")) {
      const char *skip = getenv("RAOP_PROGRESS_SEND_SKIP");
      countdown = 1 + (skip ? atoi(skip) : 0);
    }
    if (countdown > 0 && --countdown == 0) { errno = EIO; return -1; }
  }
  ssize_t (*real)(int, const void *, size_t, int) = symbol("send", "libc.so.6");
  return real(fd, buffer, size, flags);
}
ssize_t sendto(int fd, const void *buffer, size_t size, int flags,
               const struct sockaddr *address, socklen_t length)
{
  const uint8_t *bytes = buffer;
  if (size == 20 && (bytes[1] & 0x7f) == 0x54 && arm("sync")) {
    errno = EIO; return -1;
  }
  ssize_t (*real)(int, const void *, size_t, int, const struct sockaddr *, socklen_t) =
    symbol("sendto", "libc.so.6");
  return real(fd, buffer, size, flags, address, length);
}
int transcode_encode(struct evbuffer *buffer, struct encode_ctx *ctx, transcode_frame *frame, int eof)
{
  if (arm("encoder")) return -1;
  int (*real)(struct evbuffer *, struct encode_ctx *, transcode_frame *, int) =
    symbol("transcode_encode", getenv("MELOFON_RAOP_LIB"));
  return real(buffer, ctx, frame, eof);
}
gcry_error_t gcry_cipher_encrypt(gcry_cipher_hd_t ctx, void *out, size_t size,
                                const void *in, size_t insize)
{
  if (arm("cipher")) return gpg_error(GPG_ERR_GENERAL);
  gcry_error_t (*real)(gcry_cipher_hd_t, void *, size_t, const void *, size_t) =
    symbol("gcry_cipher_encrypt", "libgcrypt.so.20");
  return real(ctx, out, size, in, insize);
}
void *realloc(void *p, size_t size)
{
  Dl_info info;
  if (dladdr(__builtin_return_address(0), &info) && info.dli_sname &&
      !strcmp(info.dli_sname, "rtp_packet_next") && arm("allocation")) return NULL;
  void *(*real)(void *, size_t) = dlsym(RTLD_NEXT, "realloc");
  return real(p, size);
}

/* A test seam at the existing output backend boundary, with its real public
 * struct type. Apply the existing per-device offset before session allocation. */
static int (*start_original)(struct output_device *, int);
static uint64_t offset_attachment;
static int offset_ms;
static int start_offset(struct output_device *device, int callback)
{
  if (device->id == offset_attachment) device->offset_ms = offset_ms;
  return start_original(device, callback);
}
void raop_fi_offset(uint64_t attachment, int ms)
{
  struct output_definition *backend = dlsym(dlopen(getenv("MELOFON_RAOP_LIB"), RTLD_NOW | RTLD_LOCAL), "output_raop");
  offset_attachment = attachment;
  offset_ms = ms;
  start_original = backend->device_start;
  backend->device_start = start_offset;
}

void gcry_randomize(void *buffer, size_t size, enum gcry_random_level level)
{
  void (*real)(void *, size_t, enum gcry_random_level) = symbol("gcry_randomize", "libgcrypt.so.20");
  real(buffer, size, level);
  if (getenv("RAOP_PROGRESS_WRAP")) {
    if (size == 4) *(uint32_t *)buffer = UINT32_MAX - 400;
    if (size == 2) *(uint16_t *)buffer = UINT16_MAX - 1;
  }
}
