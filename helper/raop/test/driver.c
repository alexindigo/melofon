/* driver.c — drives libmelofon_raop against test/fake_raop.py for
 * `make test`: start → wait connected → 1 s of PCM → volume + flush →
 * teardown → wait stopped. Prints DRIVER-OK on success. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "../ffi.h"

#define PCM_BYTES 176400 /* 1 s of s16le/44100/stereo */

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
  fprintf(stderr, "driver: timed out waiting for '%s'\n", want);
  return -1;
}

int
main(int argc, char **argv)
{
  raop_t *h;
  static unsigned char silence[PCM_BYTES];
  size_t written;
  int port;

  if (argc < 2)
    {
      fprintf(stderr, "usage: driver <port>\n");
      return 2;
    }
  port = atoi(argv[1]);

  h = raop_new();
  if (!h)
    {
      fprintf(stderr, "driver: raop_new failed\n");
      return 1;
    }

  if (raop_start(h, "127.0.0.1", port, "Fake ATV", 80, 3, 0) < 0) /* appletv, unencrypted */
    return 1;
  if (wait_event(h, "\"connected\"", 15000) < 0)
    return 1;

  /* Feed 1 s of PCM with backpressure handling. */
  written = 0;
  while (written < PCM_BYTES)
    {
      size_t chunk = PCM_BYTES - written > 8192 ? 8192 : PCM_BYTES - written;
      int accepted = raop_write(h, silence + written, chunk);
      if (accepted < 0)
        return 1;
      if (accepted == 0)
        {
          usleep(10000);
          continue;
        }
      written += (size_t)accepted;
    }

  usleep(2000000); /* let the pacing drain the second of audio */

  raop_volume(h, 42);
  raop_flush(h);
  usleep(500000);

  raop_teardown(h);
  wait_event(h, "\"stopped\"", 10000);

  raop_free(h);
  printf("DRIVER-OK\n");
  return 0;
}
