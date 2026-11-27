/* Standalone guest-only numeric source contract, not linked into production.
 * Build with the helper's other objects (excluding vendor/outputs/raop.o).
 * Run in a fresh rootless network namespace without an uplink. */
#include <assert.h>
#include <sys/resource.h>
#include "../ffi.h"
#define raop_write raop_vendor_write
#include "../vendor/outputs/raop.c"
#undef raop_write

/* Watch the one startup snapshot allocation without changing the product
 * allocator or depending on its device/command layout. */
enum { ARTWORK_BYTES = 3017 };
static _Atomic(void *) watched_snapshot;
static _Atomic int snapshot_freed;
static _Atomic bool watch_snapshot;
void *__real_calloc(size_t, size_t);
void __real_free(void *);
void *__wrap_calloc(size_t count, size_t size)
{
  void *p = __real_calloc(count, size);
  if (watch_snapshot && count == 1 &&
      size == sizeof(struct raop_startup_metadata) + ARTWORK_BYTES) {
    assert(!watched_snapshot && p);
    watched_snapshot = p;
  }
  return p;
}
void __wrap_free(void *p)
{
  if (p && p == watched_snapshot) {
    watched_snapshot = NULL;
    snapshot_freed++;
  }
  __real_free(p);
}

static void startup_release(int port)
{
  uint8_t jpeg[ARTWORK_BYTES] = { 0xff, 0xd8, 0xff, 0xd9 };
  char event[256];
  raop_t *handle = raop_new();
  watch_snapshot = true;
  assert(handle && raop_start_v3(handle, "127.0.0.1", port, "artwork-release", 50,
    0, 0, 0, 1000, 2, 0, 0, "title", "artist", 0, NULL, 0, NULL, 0,
    "album", 2, jpeg, sizeof(jpeg)) == 0);
  for (int i = 0; i < 500; i++) {
    if (raop_poll(handle, event, sizeof(event)) > 0 && strstr(event, "connected")) {
      assert(watched_snapshot);
      assert(raop_free(handle) == 0);
      assert(snapshot_freed == 1 && !watched_snapshot);
      return;
    }
    usleep(10000);
  }
  assert(!"startup receiver did not connect");
}

static uint64_t fake_clock_ns;
static unsigned remaining_sends;
int __real_clock_gettime(clockid_t, struct timespec *);
ssize_t __real_send(int, const void *, size_t, int);
int __wrap_clock_gettime(clockid_t kind, struct timespec *out)
{
  if (!fake_clock_ns || kind != CLOCK_MONOTONIC) return __real_clock_gettime(kind, out);
  *out = (struct timespec){ fake_clock_ns / 1000000000ULL, fake_clock_ns % 1000000000ULL };
  return 0;
}
ssize_t __wrap_send(int fd, const void *bytes, size_t size, int flags)
{
  if (fake_clock_ns && --remaining_sends == 0) fake_clock_ns += 10000000;
  return __real_send(fd, bytes, size, flags);
}

static void ignore_deferred(evutil_socket_t fd, short flags, void *arg)
{ (void)fd; (void)flags; (void)arg; }

static void live_deadline_after_backfill(void)
{
  int pair[2];
  uint8_t pcm[352 * 4] = { 0 };
  assert(socketpair(AF_UNIX, SOCK_DGRAM, 0, pair) == 0);
  struct event_base *base = event_base_new();
  struct raop_master_session master = {
    .rtp_session = rtp_session_new(&raop_quality_default, 8, 0, 0),
    .epoch_frames = 352, .samples_per_packet = 352,
    .rawbuf = pcm, .rawbuf_size = sizeof(pcm), .encoded_buffer = evbuffer_new(),
  };
  assert(base && master.rtp_session && master.encoded_buffer);
  struct rtp_packet *queued = rtp_packet_next(master.rtp_session, 1, 352, 96);
  assert(queued);
  queued->payload[0] = 0;
  rtp_packet_commit(master.rtp_session, queued);
  struct raop_session receiver = {
    .master_session = &master, .server_fd = pair[0],
    .state = RAOP_STATE_STREAMING, .schedule_valid = true,
    .schedule_origin_ns = 101000000ULL,
    .deferredev = evtimer_new(base, ignore_deferred, NULL),
  };
  assert(receiver.deferredev);
  raop_sessions = &receiver;
  fake_clock_ns = 100000000ULL;
  remaining_sends = 2;
  int result = packets_send(&master);
  fake_clock_ns = 0;
  assert(!remaining_sends && receiver.submitted_frames == 352);
  assert(result == -1 && receiver.failure_pending);
  raop_sessions = NULL;
  event_free(receiver.deferredev);
  event_base_free(base);
  rtp_session_free(master.rtp_session);
  evbuffer_free(master.encoded_buffer);
  close(pair[0]);
  close(pair[1]);
}

static void observation_error_session(int port)
{
  struct rlimit original, small;
  int fds[128], count = 0, connected = 0, failed = 0;
  char event[256];
  raop_t *handle = raop_new();
  assert(handle && raop_start(handle, "127.0.0.1", port, "source-error", 50,
                             0, 0, 0, 0, 0, 0, 0, "", "") == 0);
  for (int i = 0; i < 1000 && !connected; i++)
    {
      if (raop_poll(handle, event, sizeof(event)) > 0 && strstr(event, "connected")) connected++;
      usleep(10000);
    }
  assert(connected == 1);
  assert(getrlimit(RLIMIT_NOFILE, &original) == 0);
  small = original; small.rlim_cur = 64;
  assert(setrlimit(RLIMIT_NOFILE, &small) == 0);
  while (count < 128 && (fds[count] = open("/dev/null", O_RDONLY | O_CLOEXEC)) >= 0) count++;
  assert(count < 128 && errno == EMFILE);
  for (int i = 0; i < 400 && !failed; i++)
    {
      if (raop_poll(handle, event, sizeof(event)) > 0 && strstr(event, "failed")) failed++;
      usleep(10000);
    }
  assert(failed == 1);
  for (int i = 0; i < count; i++) close(fds[i]);
  assert(setrlimit(RLIMIT_NOFILE, &original) == 0);
  for (int i = 0; i < 250; i++)
    {
      if (raop_poll(handle, event, sizeof(event)) > 0)
        {
          if (strstr(event, "failed")) failed++;
          if (strstr(event, "connected")) connected++;
        }
      usleep(10000);
    }
  assert(failed == 1 && connected == 1 && raop_free(handle) == 0);
  puts("SOURCE-ERROR-SESSION-OK errno=EMFILE failed=1 native-redials=0 local-release=0");
}

int main(int argc, char **argv)
{
  if (argc == 3 && !strcmp(argv[1], "startup-release")) { startup_release(atoi(argv[2])); return 0; }
  if (argc == 2 && !strcmp(argv[1], "live-deadline")) { live_deadline_after_backfill(); return 0; }
  if (argc == 2) { observation_error_session(atoi(argv[1])); return 0; }
  assert(argc == 1);
  union net_sockaddr address = { 0 };
  struct raop_source a, b;
  struct raop_session session = { 0 };
  struct rlimit limit, small;
  int error, fds[128], count = 0;
  char ipv4[] = "192.0.2.138";
  char mapped[] = "::ffff:192.0.2.138";
  char scoped[] = "fe80::1234%17";
  assert(source_from_text(&a, ipv4, AF_INET) == 0);
  assert(source_from_text(&b, mapped, AF_INET6) == 0 && source_equal(&a, &b));
  address.sin.sin_family = AF_INET;
  address.sin.sin_port = htons(40000);
  inet_pton(AF_INET, ipv4, &address.sin.sin_addr);
  assert(source_normalize(&b, &address, sizeof(address.sin)) == 0 && source_equal(&a, &b));
  assert(source_from_text(&a, scoped, AF_INET6) == 0 && a.scope == 17);
  assert(strcmp(scoped, "fe80::1234%17") == 0);
  b = a; b.scope = 18; assert(!source_equal(&a, &b));
  errno = 0; assert(source_from_socket(&a, -1) == -1 && errno == EBADF);
  session.family = AF_INET;
  session.server_port = 7000;
  session.naddr.sin.sin_family = AF_INET;
  inet_pton(AF_INET, "203.0.113.10", &session.naddr.sin.sin_addr);
  assert(source_probe(&session, &a, &error) == SOURCE_UNAVAILABLE && error == ENETUNREACH);
  assert(getrlimit(RLIMIT_NOFILE, &limit) == 0);
  small = limit; small.rlim_cur = 64;
  assert(setrlimit(RLIMIT_NOFILE, &small) == 0);
  while (count < 128 && (fds[count] = open("/dev/null", O_RDONLY | O_CLOEXEC)) >= 0) count++;
  assert(count < 128 && errno == EMFILE);
  assert(source_probe(&session, &a, &error) == SOURCE_ERROR && error == EMFILE);
  for (int i = 0; i < count; i++) close(fds[i]);
  assert(setrlimit(RLIMIT_NOFILE, &limit) == 0);
  puts("SOURCE-CONTRACTS-OK ports=ignored mapped=normalized scope=checked unavailable=ENETUNREACH error=EMFILE");
  return 0;
}
