/* driver.c — drives libmelofon_raop against test/fake_raop.py for
 * `make test`. Modes:
 *   driver <port>                — start → wait connected → 1 s of PCM →
 *                                  volume + flush → teardown → wait stopped.
 *   driver <port> backlog <sec>  — the wedge: start feeding DURING startup.
 *   driver <port> fail           — ANNOUNCE 403 → clean free.
 *   driver <port> contract       — wanted_metadata=7, title/artist, 3 s of
 *                                  non-zero PCM (progress after 88200 samples).
 *   driver <port> authsetup      — supports_auth_setup → POST /auth-setup
 *                                  before ANNOUNCE.
 *   driver <port> schedfail      — failure injection (LD_PRELOAD): the first
 *                                  start's enqueue fails → API must reject →
 *                                  retry must recover the queue and connect.
 *   driver <port> teardownfail   — failure injection: the teardown enqueue
 *                                  fails → raop_free must still fully release
 *                                  the handle and RETURN (not hang).
 *   driver <port> password-required - missing password must raise the native
 *                                    password state without reaching RECORD.
 * Prints DRIVER-OK on success. */
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "../ffi.h"

#define PCM_BYTES 176400 /* 1 s of s16le/44100/stereo */

static void
fill_tone(unsigned char *buf, size_t nbytes)
{
  size_t i;

  for (i = 0; i < nbytes / 4; i++)
    {
      int16_t v = (i / 50) % 2 == 0 ? 8000 : -8000;
      buf[i * 4 + 0] = (unsigned char)(v & 0xff);
      buf[i * 4 + 1] = (unsigned char)((v >> 8) & 0xff);
      buf[i * 4 + 2] = (unsigned char)(v & 0xff);
      buf[i * 4 + 3] = (unsigned char)((v >> 8) & 0xff);
    }
}

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

/* Feed `total` bytes while events arrive; snapshot accepted bytes at the
 * moment "connected" lands. Returns -1 on timeout. */
static int
feed_through_connect(raop_t *h, const unsigned char *pcm, size_t total,
                     size_t *pre_out, int timeout_ms)
{
  size_t offered = 0, accepted = 0;
  bool connected = false;
  int waited;

  for (waited = 0; waited < timeout_ms && (offered < total || !connected);
       waited += 5)
    {
      char buf[256];
      int n = raop_poll(h, buf, sizeof(buf));
      if (n > 0 && strstr(buf, "\"connected\"") && !connected)
        {
          connected = true;
          *pre_out = accepted;
        }
      if (offered < total)
        {
          size_t in_array = PCM_BYTES - (offered % PCM_BYTES);
          size_t chunk = total - offered;
          if (chunk > 8192)
            chunk = 8192;
          if (chunk > in_array)
            chunk = in_array;
          int a = raop_write(h, pcm + (offered % PCM_BYTES), chunk);
          if (a > 0)
            {
              offered += (size_t)a;
              accepted += (size_t)a;
            }
          else
            usleep(5000);
        }
      else
        usleep(20000);
    }
  if (!connected)
    {
      fprintf(stderr, "driver: timed out waiting for connect\n");
      return -1;
    }
  printf("PRE=%zu TOTAL=%zu\n", *pre_out, accepted);
  return 0;
}

int
main(int argc, char **argv)
{
  raop_t *h;
  static unsigned char tone[PCM_BYTES];
  size_t written;
  bool backlog;
  bool fail;
  bool contract;
  bool authsetup;
  bool schedfail;
  bool teardownfail;
  bool password_required;
  bool credentials;
  bool isolation;
  int port;
  int feed_seconds = 0;
  int feed_bytes;

  if (argc < 2)
    {
      fprintf(stderr, "usage: driver <port> [backlog <feed_seconds> | fail | contract | authsetup | schedfail | teardownfail | password-required]\n");
      return 2;
    }
  port = atoi(argv[1]);
  backlog = argc > 3 && strcmp(argv[2], "backlog") == 0;
  fail = argc > 2 && strcmp(argv[2], "fail") == 0;
  contract = argc > 2 && strcmp(argv[2], "contract") == 0;
  authsetup = argc > 2 && strcmp(argv[2], "authsetup") == 0;
  schedfail = argc > 2 && strcmp(argv[2], "schedfail") == 0;
  teardownfail = argc > 2 && strcmp(argv[2], "teardownfail") == 0;
  password_required = argc > 2 && strcmp(argv[2], "password-required") == 0;
  credentials = argc > 2 && strcmp(argv[2], "credentials") == 0;
  isolation = argc > 2 && strcmp(argv[2], "isolation") == 0;
  if (backlog)
    feed_seconds = atoi(argv[3]);

  fill_tone(tone, PCM_BYTES);

  h = raop_new();
  if (!h)
    {
      fprintf(stderr, "driver: raop_new failed\n");
      return 1;
    }

  if (schedfail)
    {
      /* The first start's command-queue scheduling is injected to fail
       * (RAOP_FI_EBO_FAIL_AT=1): raop_start must reject it, and the retry
       * must recover the queue — the fake device seeing the handshake is
       * the wire-observable proof. On the pre-repair library the retry
       * wedges (cmds_scheduled stuck) and connected never arrives. */
      if (raop_start(h, "127.0.0.1", port, "Fake ATV", 80, 3, 0, 0,
                     1000, 0, 0, 0, "", "") >= 0)
        {
          fprintf(stderr, "driver: schedfail: first start was not rejected\n");
          return 1;
        }
      if (raop_start(h, "127.0.0.1", port, "Fake ATV", 80, 3, 0, 0,
                     1000, 0, 0, 0, "", "") < 0)
        {
          fprintf(stderr, "driver: schedfail: retry rejected\n");
          return 1;
        }
      if (wait_event(h, "\"connected\"", 15000) < 0)
        return 1;
      raop_teardown(h);
      wait_event(h, "\"stopped\"", 10000);
      raop_free(h);
      printf("DRIVER-OK\n");
      return 0;
    }

  if (credentials || isolation) {
    const char *secret = getenv("DRIVER_PASSWORD");
    char *copy = secret ? strdup(secret) : NULL;
    if (raop_start_v2(h, "127.0.0.1", port, "Credential receiver", 80, 3, 0, 0,
                       1000, 0, 0, 0, "", "", 1,
                       (const uint8_t *)copy, copy ? strlen(copy) : 0, NULL, 0) < 0) return 1;
    /* Queue must own an independent copy before the API returns. */
    if (copy) { memset(copy, 'x', strlen(copy)); free(copy); }
    if (getenv("DRIVER_REJECT")) {
      if (wait_event(h, "\"password\"", 15000) < 0 || raop_free(h) != 0) return 1;
      puts("DRIVER-OK"); return 0;
    }
  } else if (raop_start(h, "127.0.0.1", port, "Fake ATV", 80, 3, 0, 0,
                 contract ? 3000 : 1000,
                 contract ? 7 : 0,
                 authsetup ? 1 : 0,
                 0,
                 contract ? "Cool Vibes" : "",
                 contract ? "Blue Tattoo" : "") < 0)
    return 1;

  raop_t *peer = NULL;
  if (isolation) {
    if (wait_event(h, "\"connected\"", 15000) < 0) return 1;
    peer = raop_new();
    const char *first = getenv("DRIVER_PASSWORD"), *second = getenv("DRIVER_PEER_PASSWORD");
    int peer_port = atoi(getenv("DRIVER_PEER_PORT"));
    if (!peer || !first || !second) return 1;
    if (raop_start_v2(peer, "127.0.0.1", peer_port, "Peer", 80, 3, 0, 0, 1000, 0, 0, 0,
                       "", "", 1, (const uint8_t *)first, strlen(first), NULL, 0) < 0 ||
        wait_event(peer, "\"password\"", 15000) < 0) return 1;
    /* Replacement on the same native handle crosses the local release barrier. */
    if (raop_start_v2(peer, "127.0.0.1", peer_port, "Peer", 80, 3, 0, 0, 1000, 0, 0, 0,
                       "", "", 1, (const uint8_t *)second, strlen(second), NULL, 0) < 0 ||
        wait_event(peer, "\"connected\"", 15000) < 0) return 1;
  }

  if (teardownfail)
    {
      /* The teardown enqueue is injected to fail (RAOP_FI_EBO_FAIL_AT=2):
       * raop_teardown must say so, and raop_free must still fully release
       * the handle — the loop-thread free tears the still-attached device
       * down — and RETURN. On the pre-repair library raop_free wedges the
       * queue and blocks forever here (the runner's timeout is the red). */
      if (wait_event(h, "\"connected\"", 15000) < 0)
        return 1;
      if (raop_teardown(h) >= 0)
        {
          fprintf(stderr,
                  "driver: teardownfail: teardown was not rejected\n");
          return 1;
        }
      raop_free(h);
      printf("DRIVER-OK\n");
      return 0;
    }

  if (fail || password_required)
    {
      /* Observe either ANNOUNCE refusal or an actual digest challenge.
       * Credential inputs are deliberately left to the additive ABI item. */
      if (wait_event(h, password_required ? "\"password\"" : "\"failed\"", 15000) < 0)
        return 1;
      raop_teardown(h);
      raop_free(h);
      printf("DRIVER-OK\n");
      return 0;
    }

  if (backlog)
    {
      size_t pre = 0;
      /* Feed during startup — the fake's RECORD is delayed; the ~2 s cap
       * must hold pre-connect, pacing at connect must reopen the flow. */
      if (feed_through_connect(h, tone, (size_t)feed_seconds * PCM_BYTES,
                               &pre, 30000) < 0)
        return 1;
    }
  else
    {
      if (!isolation && wait_event(h, "\"connected\"", 15000) < 0)
        return 1;

      feed_bytes = contract ? 3 * PCM_BYTES : PCM_BYTES;
      written = 0;
      while (written < (size_t)feed_bytes)
        {
          size_t chunk = (size_t)feed_bytes - written > 8192
                           ? 8192
                           : (size_t)feed_bytes - written;
          if (chunk > PCM_BYTES - (written % PCM_BYTES))
            chunk = PCM_BYTES - (written % PCM_BYTES);
          int accepted = raop_write(h, tone + (written % PCM_BYTES), chunk);
          if (accepted < 0)
            return 1;
          if (accepted == 0)
            {
              usleep(10000);
              continue;
            }
          written += (size_t)accepted;
        }
    }

  usleep(2000000); /* let the pacing drain the audio */

  raop_volume(h, 42);
  raop_flush(h);
  usleep(500000);

  raop_teardown(h);
  wait_event(h, "\"stopped\"", 10000);

  raop_free(h);
  if (peer && raop_free(peer) != 0) return 1;
  printf("DRIVER-OK\n");
  return 0;
}
