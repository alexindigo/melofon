/* faultinject.c — test-only LD_PRELOAD interposer for the queue/cleanup
 * failure-injection scenarios (plan atv3-session-recycle). Never linked
 * into the library or the driver; loaded only by run_fake_device_test.py
 * scenarios via LD_PRELOAD.
 *
 * Knobs (env):
 *   RAOP_FI_EBO_FAIL_AT=N      — the Nth event_base_once() call returns -1.
 *   RAOP_FI_CALLOC_ARM_FILE=P  — once P exists, the first calloc of
 *                                >= 1024 bytes unlinks P and returns NULL
 *                                (one-shot; arm it right before the call
 *                                under test).
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stddef.h>
#include <stdlib.h>
#include <unistd.h>
#include <errno.h>
#include <pthread.h>
#include <sys/socket.h>
#include <time.h>
#include <string.h>
#include <stdio.h>
#include <sys/timerfd.h>
#include <stdatomic.h>

#include <event2/event.h>
#include <event2/buffer.h>

static void *event_symbol(const char *name)
{
  void *symbol = dlsym(RTLD_NEXT, name);
  if (!symbol) {
    /* Deno loads the RAOP library/dependencies RTLD_LOCAL. A globally
     * preloaded observer cannot see those through RTLD_NEXT, unlike the
     * linked C probes. Resolve from libevent's own handle in that case. */
    void *library = dlopen("libevent.so", RTLD_NOW | RTLD_LOCAL);
    symbol = library ? dlsym(library, name) : NULL;
  }
  if (!symbol) { fprintf(stderr, "fault observer cannot resolve %s\n", name); abort(); }
  return symbol;
}

/* Public-FFI lifetime tests fail construction after runtime acquisition. */
static _Atomic int allocation_stage;
static _Atomic int metadata_copies;
void raop_fi_allocation_stage(int stage) {
  atomic_store(&metadata_copies, 0);
  atomic_store(&allocation_stage, stage);
}
char *strdup(const char *s)
{
  if (atomic_load(&allocation_stage) == 3 && !strcmp(s, "Fault metadata") &&
      atomic_fetch_add(&metadata_copies, 1) == 0) {
    atomic_store(&allocation_stage, 0); return NULL;
  }
  char *(*real)(const char *) = dlsym(RTLD_NEXT, "strdup");
  return real(s);
}
struct evbuffer *evbuffer_new(void)
{
  int expected = 4;
  if (atomic_compare_exchange_strong(&allocation_stage, &expected, 0)) return NULL;
  struct evbuffer *(*real)(void) = event_symbol("evbuffer_new");
  return real();
}
int event_add(struct event *event, const struct timeval *timeout)
{
  int expected = 6;
  if (atomic_compare_exchange_strong(&allocation_stage, &expected, 0)) return -1;
  int (*real)(struct event *, const struct timeval *) = event_symbol("event_add");
  return real(event, timeout);
}
int timerfd_create(int clock, int flags)
{
  int expected = 1;
  if (atomic_compare_exchange_strong(&allocation_stage, &expected, 0)) {
    errno = EMFILE; return -1;
  }
  int (*real)(int, int) = dlsym(RTLD_NEXT, "timerfd_create");
  return real(clock, flags);
}
struct event *event_new(struct event_base *base, evutil_socket_t fd, short events,
                         event_callback_fn cb, void *arg)
{
  int expected = 2;
  if (atomic_compare_exchange_strong(&allocation_stage, &expected, 0)) return NULL;
  struct event *(*real)(struct event_base *, evutil_socket_t, short, event_callback_fn, void *) = event_symbol("event_new");
  return real(base, fd, events, cb, arg);
}

/* Test-only independently observed live TCP generations (not RAOP state). */
static pthread_mutex_t fd_lock = PTHREAD_MUTEX_INITIALIZER;
static unsigned long fd_generation[4096];
static unsigned long next_generation;

unsigned long raop_fi_last_generation(void)
{
  unsigned long generation;
  pthread_mutex_lock(&fd_lock);
  generation = next_generation;
  pthread_mutex_unlock(&fd_lock);
  return generation;
}

int raop_fi_generation_live(unsigned long generation)
{
  int live = 0;
  pthread_mutex_lock(&fd_lock);
  for (int i = 0; i < 4096; i++) if (fd_generation[i] == generation) live = 1;
  pthread_mutex_unlock(&fd_lock);
  return live;
}

int raop_fi_live_connections(void)
{
  int count = 0;
  pthread_mutex_lock(&fd_lock);
  for (int i = 0; i < 4096; i++) if (fd_generation[i]) count++;
  pthread_mutex_unlock(&fd_lock);
  return count;
}

int connect(int fd, const struct sockaddr *address, socklen_t size)
{
  static int (*real_connect)(int, const struct sockaddr *, socklen_t);
  int type = 0, rc, saved;
  socklen_t n = sizeof(type);
  if (!real_connect) real_connect = dlsym(RTLD_NEXT, "connect");
  rc = real_connect(fd, address, size); saved = errno;
  if ((rc == 0 || saved == EINPROGRESS) && fd >= 0 && fd < 4096 &&
      getsockopt(fd, SOL_SOCKET, SO_TYPE, &type, &n) == 0 && type == SOCK_STREAM)
    {
      pthread_mutex_lock(&fd_lock);
      fd_generation[fd] = ++next_generation;
      pthread_mutex_unlock(&fd_lock);
    }
  errno = saved;
  return rc;
}

int close(int fd)
{
  static int (*real_close)(int);
  int rc;
  if (!real_close) real_close = dlsym(RTLD_NEXT, "close");
  pthread_mutex_lock(&fd_lock);
  rc = real_close(fd);
  if (fd >= 0 && fd < 4096 && rc == 0)
    {
      fd_generation[fd] = 0;
    }
  pthread_mutex_unlock(&fd_lock);
  return rc;
}

/* dlsym may itself call calloc; give resolution a static bootstrap arena. */
static char bootstrap[1 << 16];
static size_t bootstrap_off;
static int resolving;
static int once_blocking;
static _Atomic int poll_blocking;
int raop_fi_poll_blocking(void) { return atomic_load(&poll_blocking); }
struct held_poll {
  struct event_base *base;
  event_callback_fn callback;
  void *arg;
};
static void held_poll_cb(evutil_socket_t fd, short events, void *arg)
{
  struct held_poll *work = arg;
  const char *arm = getenv("RAOP_FI_POLL_ARM_FILE");
  if (arm && access(arm, F_OK) == 0) {
    atomic_store(&poll_blocking, 1);
    int (*real)(struct event_base *, evutil_socket_t, short, event_callback_fn, void *, const struct timeval *) = event_symbol("event_base_once");
    struct timeval retry = { 0, 1000 };
    if (real(work->base, -1, EV_TIMEOUT, held_poll_cb, work, &retry) < 0) abort();
    return;
  }
  atomic_store(&poll_blocking, 0);
  work->callback(fd, events, work->arg);
  free(work);
}
int raop_fi_once_blocking(void)
{
  pthread_mutex_lock(&fd_lock);
  int blocking = once_blocking;
  pthread_mutex_unlock(&fd_lock);
  return blocking;
}

void *
calloc(size_t nmemb, size_t size)
{
  static void *(*real_calloc)(size_t, size_t);
  const char *arm;
  size_t total = nmemb * size;

  if (!real_calloc)
    {
      if (resolving)
        {
          void *p = bootstrap + bootstrap_off;
          bootstrap_off += (total + 15) & ~(size_t)15;
          return p;
        }
      resolving = 1;
      real_calloc = dlsym(RTLD_NEXT, "calloc");
      resolving = 0;
    }

  if (total >= 1024 && (arm = getenv("RAOP_FI_CALLOC_ARM_FILE")) != NULL &&
      access(arm, F_OK) == 0)
    {
      unlink(arm); /* one-shot */
      return NULL;
    }
  if ((arm = getenv("RAOP_FI_RELEASE_ALLOC_ARM_FILE")) != NULL && access(arm, F_OK) == 0) {
    Dl_info info;
    if (dladdr(__builtin_return_address(0), &info) && info.dli_sname &&
        strcmp(info.dli_sname, "raop_release_device") == 0) {
      unlink(arm); return NULL;
    }
  }
  if ((arm = getenv("RAOP_FI_FREE_ALLOC_ARM_FILE")) != NULL && access(arm, F_OK) == 0) {
    Dl_info info;
    if (dladdr(__builtin_return_address(0), &info) && info.dli_sname &&
        strcmp(info.dli_sname, "raop_free") == 0) {
      unlink(arm); return NULL;
    }
  }
  return real_calloc(nmemb, size);
}

static int blocked_fd = -1;
static double blocked_until;
static double now(void)
{
  struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts);
  return ts.tv_sec + ts.tv_nsec / 1e9;
}
int raop_fi_write_blocking(void)
{
  pthread_mutex_lock(&fd_lock);
  int blocking = blocked_fd >= 0 && now() < blocked_until;
  pthread_mutex_unlock(&fd_lock);
  return blocking;
}
int evbuffer_write(struct evbuffer *buf, evutil_socket_t fd)
{
  static int (*real_write)(struct evbuffer *, evutil_socket_t);
  if (!real_write) real_write = event_symbol("evbuffer_write");
  const char *arm = getenv("RAOP_FI_WRITE_BLOCK_ARM_FILE");
  pthread_mutex_lock(&fd_lock);
  if (arm && access(arm, F_OK) == 0) {
    unlink(arm); blocked_fd = fd; blocked_until = now() + 0.5;
  }
  int blocking = fd == blocked_fd && now() < blocked_until;
  pthread_mutex_unlock(&fd_lock);
  if (blocking) { errno = EAGAIN; return -1; }
  return real_write(buf, fd);
}

/* Exact-admission probes only: fail the ingress allocation without perturbing
 * RTSP/encoder/logging buffers. No test knob is linked into the shipping .so. */
int evbuffer_add(struct evbuffer *buf, const void *data, size_t size)
{
  int expected = 5;
  if (atomic_compare_exchange_strong(&allocation_stage, &expected, 0)) return -1;
  static int (*real_add)(struct evbuffer *, const void *, size_t);
  if (!real_add) real_add = event_symbol("evbuffer_add");
  const char *arm = getenv("RAOP_FI_APPEND_ARM_FILE");
  if (arm && access(arm, F_OK) == 0) {
    Dl_info info;
    if (dladdr(__builtin_return_address(0), &info) && info.dli_sname &&
        strcmp(info.dli_sname, "raop_player_append") == 0) {
      unlink(arm); return -1;
    }
  }
  return real_add(buf, data, size);
}

int
event_base_once(struct event_base *base, evutil_socket_t fd, short events,
                event_callback_fn cb, void *arg, const struct timeval *tv)
{
  static int (*real_once)(struct event_base *, evutil_socket_t, short,
                          event_callback_fn, void *, const struct timeval *);
  static long calls;
  const char *at;
  long n;

  if (!real_once)
    real_once = event_symbol("event_base_once");
  const char *poll_arm = getenv("RAOP_FI_POLL_ARM_FILE");
  if (poll_arm && access(poll_arm, F_OK) == 0) {
    Dl_info info;
    if (dladdr(__builtin_return_address(0), &info) && info.dli_sname &&
        strcmp(info.dli_sname, "raop_stream_completion_poll") == 0) {
      struct held_poll *work = calloc(1, sizeof(*work));
      if (!work) return -1;
      work->base = base; work->callback = cb; work->arg = arg;
      int result = real_once(base, fd, events, held_poll_cb, work, tv);
      if (result < 0) free(work);
      return result;
    }
  }
  const char *arm = getenv("RAOP_FI_RESET_ARM_FILE");
  if (arm && access(arm, F_OK) == 0) {
    Dl_info info;
    if (dladdr(__builtin_return_address(0), &info) && info.dli_sname &&
        strcmp(info.dli_sname, "raop_stream_reset") == 0) {
      pthread_mutex_lock(&fd_lock); once_blocking = 1; pthread_mutex_unlock(&fd_lock);
      while (access(arm, F_OK) == 0) usleep(1000);
      pthread_mutex_lock(&fd_lock); once_blocking = 0; pthread_mutex_unlock(&fd_lock);
    }
  }
  n = ++calls;
  if (n == 1 && getenv("RAOP_FI_EBO_BLOCK_FAIL")) {
    pthread_mutex_lock(&fd_lock); once_blocking = 1; pthread_mutex_unlock(&fd_lock);
    usleep(150000);
    pthread_mutex_lock(&fd_lock); once_blocking = 0; pthread_mutex_unlock(&fd_lock);
    return -1;
  }
  at = getenv("RAOP_FI_EBO_FAIL_AT");
  if (at && atol(at) == n)
    return -1;
  return real_once(base, fd, events, cb, arg, tv);
}

struct event_base *event_base_new(void)
{
  static struct event_base *(*real_new)(void);
  if (!real_new) real_new = event_symbol("event_base_new");
  if (getenv("RAOP_FI_BASE_FAIL")) { usleep(50000); return NULL; }
  return real_new();
}
