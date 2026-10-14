/* Native local close must complete while another handle retains the runtime. */
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include "../ffi.h"

static int connected(raop_t *h)
{
  char buf[256];
  for (int i = 0; i < 1000; i++)
    {
      if (raop_poll(h, buf, sizeof(buf)) > 0 && strstr(buf, "connected")) return 0;
      usleep(10000);
    }
  return -1;
}

int main(int argc, char **argv)
{
  int (*live)(void) = dlsym(RTLD_DEFAULT, "raop_fi_live_connections");
  if (argc != 2 || !live) return 2;
  raop_t *a = raop_new(), *b = raop_new();
  if (!a || !b) return 2;
  int port = atoi(argv[1]);
  if (raop_start(a,"127.0.0.1",port,"release",50,3,0,0,1000,0,0,0,"","") < 0 ||
      raop_start(b,"127.0.0.1",port,"persistent peer",50,3,0,0,1000,0,0,0,"","") < 0 ||
      connected(a) < 0 || connected(b) < 0) return 3;
  if (live() != 2) return 4;
  int rc = raop_free(a);
  int remaining = live();
  printf("LOCAL_RELEASE_RC=%d LIVE_TCP_AFTER_FREE=%d\n",rc,remaining);
  if (rc != 0 || remaining != 1) return 1;
  if (raop_free(b) != 0 || live() != 0) return 1;
  puts("LOCAL-RELEASE-OK");
  return 0;
}
