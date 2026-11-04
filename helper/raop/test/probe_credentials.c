/* Input seam, not Apple pair verification. Inspect only on the native loop;
 * observe zeroed owned allocations at free without ever printing their bytes. */
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <event2/event.h>
#include "config.h"
#include "outputs.h"
#include "../ffi.h"

extern struct event_base *evbase_player;
/* Linux/glibc probe, matching stub/config.h. dlsym itself frees loader memory;
 * resolving free from inside its interposer would recursively enter dlsym. */
extern void __libc_free(void *);
static void *password_ptr, *key_ptr;
static size_t password_len;
static int erased;
static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t ready = PTHREAD_COND_INITIALIZER;
static int inspected;
static uint8_t key[128], password[32];

void free(void *ptr)
{
  if (ptr && (ptr == password_ptr || ptr == key_ptr)) {
    size_t n = ptr == key_ptr ? 128 : password_len;
    for (size_t i = 0; i < n; i++) if (((uint8_t *)ptr)[i]) abort();
    erased++;
    if (ptr == key_ptr) key_ptr = NULL; else password_ptr = NULL;
  }
  __libc_free(ptr);
}

static void inspect(evutil_socket_t fd, short what, void *arg)
{
  (void)fd; (void)what; (void)arg;
  struct output_device *dev = outputs_device_get(2);
  if (!dev || !dev->has_password || !dev->password || !dev->auth_key ||
      strlen(dev->password) != sizeof(password) || strlen(dev->auth_key) != sizeof(key)) abort();
  for (size_t i = 0; i < sizeof(password); i++) if (dev->password[i] != 'p') abort();
  for (size_t i = 0; i < sizeof(key); i++) if (dev->auth_key[i] != 'a') abort();
  password_ptr = (void *)dev->password; key_ptr = dev->auth_key; password_len = sizeof(password);
  pthread_mutex_lock(&lock); inspected = 1; pthread_cond_signal(&ready); pthread_mutex_unlock(&lock);
}

static int start(raop_t *h, int port, const uint8_t *p, size_t n, const uint8_t *k, size_t kn)
{
  return raop_start_v2(h, "127.0.0.1", port, "Seam", 50, 3, 0, 0, 1000, 0, 0, 0,
                       "", "", 1, p, n, k, kn);
}

int main(int argc, char **argv)
{
  if (argc != 2 && argc != 3) return 2;
  int port = atoi(argv[1]);
  /* The fixture's delayed POST targets active-remote 2, as in the existing
   * session-lifetime probes. Keep its empty peer alive until inspection ends. */
  raop_t *guard = raop_new();
  raop_t *h = raop_new(); if (!guard || !h) return 1;
  memset(key, 'a', sizeof(key)); memset(password, 'p', sizeof(password));
  uint8_t nul[] = {'a', 0, 'b'}, large[4097]; memset(large, 'p', sizeof(large));
  if (start(h, port, NULL, 1, NULL, 0) != -1 ||
      start(h, port, nul, sizeof(nul), NULL, 0) != -1 ||
      start(h, port, large, sizeof(large), NULL, 0) != -1 ||
      start(h, port, NULL, 0, NULL, 128) != -1 ||
      start(h, port, NULL, 0, key, 127) != -1) abort();
  key[4] = 'z'; if (start(h, port, NULL, 0, key, 128) != -1) abort();
  key[4] = 0; if (start(h, port, NULL, 0, key, 128) != -1) abort();
  key[4] = 'a';
  if (start(h, port, password, sizeof(password), key, sizeof(key))) abort();
  memset(key, 'x', sizeof(key)); memset(password, 'x', sizeof(password));
  struct timeval delay = {0, 100000};
  pthread_mutex_lock(&lock);
  if (event_base_once(evbase_player, -1, EV_TIMEOUT, inspect, NULL, &delay)) abort();
  while (!inspected) pthread_cond_wait(&ready, &lock);
  pthread_mutex_unlock(&lock);
  /* A fake pair-verify response is intentionally invalid. This second path
   * observes erasure at native key invalidation, before the later device free. */
  if (argc == 3) usleep(1000000);
  if (raop_free(h) || erased != 2 || raop_free(guard)) abort();
  puts("CREDENTIAL-SEAM-OK"); return 0;
}
