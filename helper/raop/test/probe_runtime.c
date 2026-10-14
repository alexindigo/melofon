/* Concurrent startup failure and last-release/new-acquire lifetime gates. */
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <dlfcn.h>
#include <unistd.h>
#include "../ffi.h"

static pthread_barrier_t barrier;
static int failing;
static void *start_rejected(void *h)
{
  if (raop_start(h,"127.0.0.1",1,"schedule rollback",50,3,0,0,1000,0,0,0,"","") != -1) abort();
  return NULL;
}
static void *cycle(void *arg)
{
  pthread_barrier_wait(&barrier);
  for (int n = 0; n < (failing ? 1 : 80); n++) {
    raop_t *h = raop_new();
    if (failing ? h != NULL : h == NULL) abort();
    if (h && raop_free(h) != 0) abort();
  }
  return NULL;
}
int main(int argc, char **argv)
{
  if (argc > 1 && strcmp(argv[1], "schedule-race") == 0) {
    int (*blocking)(void) = dlsym(RTLD_DEFAULT, "raop_fi_once_blocking");
    if (!blocking) abort();
    raop_t *h = raop_new(); if (!h) abort();
    pthread_t start; if (pthread_create(&start, NULL, start_rejected, h)) abort();
    for (int i = 0; i < 1000 && !blocking(); i++) usleep(1000);
    if (!blocking() || raop_free(h) != 0 || pthread_join(start,NULL)) abort();
    puts("CONCURRENT-SCHEDULE-ROLLBACK-OK"); return 0;
  }
  failing = argc > 1 && strcmp(argv[1], "fail") == 0;
  pthread_t threads[4];
  pthread_barrier_init(&barrier, NULL, 4);
  for (int i = 0; i < 4; i++) if (pthread_create(&threads[i], NULL, cycle, NULL)) abort();
  for (int i = 0; i < 4; i++) if (pthread_join(threads[i], NULL)) abort();
  pthread_barrier_destroy(&barrier);
  puts(failing ? "STARTUP-FAILURE-OK" : "RUNTIME-CHURN-OK");
  return 0;
}
