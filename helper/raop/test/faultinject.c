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

#include <event2/event.h>

/* dlsym may itself call calloc; give resolution a static bootstrap arena. */
static char bootstrap[1 << 16];
static size_t bootstrap_off;
static int resolving;

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
  return real_calloc(nmemb, size);
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
    real_once = dlsym(RTLD_NEXT, "event_base_once");
  n = ++calls;
  at = getenv("RAOP_FI_EBO_FAIL_AT");
  if (at && atol(at) == n)
    return -1;
  return real_once(base, fd, events, cb, arg, tv);
}
