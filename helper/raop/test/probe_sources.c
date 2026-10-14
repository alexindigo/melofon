/* Standalone guest-only numeric source contract, not linked into production.
 * Build with the helper's other objects (excluding vendor/outputs/raop.o).
 * Run in a fresh rootless network namespace without an uplink. */
#include <assert.h>
#include <sys/resource.h>
#include "../ffi.h"
#define raop_write raop_vendor_write
#include "../vendor/outputs/raop.c"
#undef raop_write

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
