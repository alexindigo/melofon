/* Public diagnostic API proof; no private handles/control/pacing layout mirrors. */
#include "ffi.h"
#include "logger.h"
#include <assert.h>
#include <pthread.h>
#include <stdio.h>
#include <string.h>
#include <libavutil/log.h>
#include "../vendor/evrtsp/log.h"

static void *flood(void *unused)
{
  (void)unused;
  for (int i = 0; i < 600; i++)
    helper_log_event(E_LOG, L_RAOP, "probe_queued", &(struct helper_log_fields){ .value = i });
  return NULL;
}
int main(void)
{
  char buffer[32768], long_message[8192];
  pthread_t thread;
  assert(raop_log_consumer(1) == 0);
  assert(raop_log_consumer(1) == -1);
  DPRINTF(E_LOG, L_RAOP, "before-handle credential/CANARY\nforged-line\033[31m\n");
  memset(long_message, 'x', sizeof(long_message) - 1);
  long_message[sizeof(long_message) - 1] = 0;
  DPRINTF(E_LOG, L_RAOP, "%s", long_message);
  av_log(NULL, AV_LOG_ERROR, "system-ffmpeg credential/CANARY\n");
  event_warnx("libevent credential/CANARY");
  assert(pthread_create(&thread, NULL, flood, NULL) == 0);
  assert(pthread_join(thread, NULL) == 0);
  assert(raop_log_poll(buffer, 1) == -1); /* Record is retained on insufficient cap. */
  int n, records = 0;
  while ((n = raop_log_poll(buffer, sizeof(buffer))) > 0) {
    assert(n < sizeof(buffer));
    puts(buffer);
    records++;
  }
  assert(n == 0 && records == 256);
  assert(raop_log_consumer(0) == 0);
  assert(raop_log_consumer(1) == 0);
  assert(raop_log_poll(buffer, sizeof(buffer)) == 0);
  assert(raop_log_consumer(0) == 0);
  return 0;
}
