/* Release during delayed native handshake/FLUSH/pairing; observe TCP
 * generations independently and serialize same-handle start after teardown. */
#include <assert.h>
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <stdint.h>
#include "../ffi.h"

static int state(raop_t *h, const char *wanted)
{
  char buf[256];
  for (int i = 0; i < 1000; i++) {
    if (raop_poll(h, buf, sizeof(buf)) > 0 && strstr(buf, wanted)) return 0;
    usleep(10000);
  }
  return -1;
}
#define connected(h) state(h, "connected")
static void start(raop_t *h, int port)
{
  assert(raop_start(h,"127.0.0.1",port,"lifetime",50,3,0,0,1000,0,0,0,"","") == 0);
}
int main(int argc, char **argv)
{
  assert(argc == 3);
  int (*live)(void) = dlsym(RTLD_DEFAULT, "raop_fi_live_connections");
  unsigned long (*last)(void) = dlsym(RTLD_DEFAULT, "raop_fi_last_generation");
  int (*generation_live)(unsigned long) = dlsym(RTLD_DEFAULT, "raop_fi_generation_live");
  assert(live && last && generation_live);
  void *(*find)(uint64_t) = dlsym(RTLD_DEFAULT, "raop_ffi_device_find");
  assert(find && find(UINT64_MAX) == NULL);
  int port = atoi(argv[1]); const char *mode = argv[2];
  raop_t *peer = raop_new(), *h = raop_new(); assert(peer && h);
  start(peer, port); assert(connected(peer) == 0);
  start(h, port);
  if (!strcmp(mode, "quiesce") || !strcmp(mode, "release-alloc")) {
    assert(connected(h) == 0);
    unsigned char pcm[176400] = {0};
    assert(raop_write(h, pcm, sizeof(pcm)) == sizeof(pcm));
    char line[16]; assert(fgets(line, sizeof(line), stdin));
    const char *arm = getenv(!strcmp(mode, "quiesce") ?
      "RAOP_FI_WRITE_BLOCK_ARM_FILE" : "RAOP_FI_RELEASE_ALLOC_ARM_FILE");
    assert(arm); FILE *file = fopen(arm, "w"); assert(file); fclose(file);
    if (!strcmp(mode, "release-alloc")) {
      assert(raop_free(h) == -1);
      assert(live() == 2 && access(arm, F_OK) != 0);
      assert(raop_volume(h, 50) == -1);
      puts("RELEASE-ALLOCATION-FAILURE-OK retained-native-ownership=1");
      return 0; /* Deliberate retained ownership is the failure contract. */
    }
    int (*blocking)(void) = dlsym(RTLD_DEFAULT, "raop_fi_write_blocking"); assert(blocking);
    assert(raop_teardown(h) == 0);
    for (int n = 0; n < 1000 && !blocking(); n++) usleep(1000);
    assert(blocking()); puts("RETIRING"); fflush(stdout);
    assert(fgets(line, sizeof(line), stdin));
    assert(raop_free(h) == 0 && live() == 1);
    assert(raop_free(peer) == 0 && live() == 0);
    puts("QUIESCENCE-OK"); return 0;
  }
  if (!strcmp(mode, "FLUSH")) {
    assert(connected(h) == 0);
    unsigned char pcm[176400] = {0};
    assert(raop_write(h, pcm, sizeof(pcm)) == sizeof(pcm));
    /* raop.c changes STREAMING silently. Wait for actual RTP observed by
     * the independent receiver, not a nonexistent state callback. */
    char flush[16]; assert(fgets(flush, sizeof(flush), stdin));
    assert(raop_flush(h) == 0);
  }
  if (!strcmp(mode, "pair")) { assert(connected(h) == 0); assert(raop_pin(h,"1234") == 0); }
  if (!strcmp(mode, "restart")) {
    assert(connected(h) == 0);
    unsigned long old = last(); assert(generation_live(old));
    assert(raop_teardown(h) == 0); start(h, port);
    assert(connected(h) == 0);
    assert(!generation_live(old) && last() > old && live() == 2);
    assert(raop_free(h) == 0 && live() == 1);
  } else {
    char line[16]; assert(fgets(line,sizeof(line),stdin));
    unsigned long old = last(); assert(generation_live(old));
    assert(raop_free(h) == 0 && !generation_live(old) && live() == 1);
    usleep(750000); assert(live() == 1); /* Late reply cannot revive the old device. */
  }
  assert(raop_free(peer) == 0 && live() == 0);
  printf("SESSION-LIFETIME-OK mode=%s\n",mode);
  return 0;
}
