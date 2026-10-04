/* probe_free_contract.c — the raop_free result observability probe (plan
 * atv3-session-recycle): start → connected → teardown → stopped, then a
 * free-path failure injected by faultinject (LD_PRELOAD) must surface as
 * raop_free() == -1. Compiled by run_fake_device_test.py against the built
 * library; against the pre-repair header (void raop_free) this file does
 * not compile — that build failure is the scenario's red on the base. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>

#include "../ffi.h"

static int
wait_event(raop_t *h, const char *want, int timeout_ms)
{
  char buf[256];
  int waited;

  for (waited = 0; waited < timeout_ms; waited += 20)
    {
      int n = raop_poll(h, buf, sizeof(buf));
      if (n > 0 && strstr(buf, want))
        return 0;
      usleep(20000);
    }
  fprintf(stderr, "probe: timed out waiting for '%s'\n", want);
  return -1;
}

int
main(int argc, char **argv)
{
  raop_t *h;
  const char *arm;
  int port;
  int rc;

  if (argc < 2)
    {
      fprintf(stderr, "usage: probe_free_contract <port>\n");
      return 2;
    }
  port = atoi(argv[1]);

  h = raop_new();
  if (!h)
    return 1;
  if (raop_start(h, "127.0.0.1", port, "probe", 80, 3, 0, 0,
                 1000, 0, 0, 0, "", "") < 0)
    return 1;
  if (wait_event(h, "\"connected\"", 15000) < 0)
    return 1;
  if (raop_teardown(h) < 0)
    return 1;
  if (wait_event(h, "\"stopped\"", 10000) < 0)
    return 1;

  /* Arm the one-shot calloc failure (if requested) without stdio: open()
   * allocates no userland buffers that could eat the injection. */
  arm = getenv("RAOP_FI_CALLOC_ARM_FILE");
  if (arm)
    {
      int fd = open(arm, O_CREAT | O_WRONLY, 0644);
      if (fd >= 0)
        close(fd);
    }

  rc = raop_free(h);
  printf("FREE-RC=%d\n", rc);
  return rc == -1 ? 0 : 2;
}
