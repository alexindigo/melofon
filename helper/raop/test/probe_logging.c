/* Public diagnostic API proof; no private handles/control/pacing layout mirrors. */
#include "ffi.h"
#include "logger.h"
#include <assert.h>
#include <dlfcn.h>
#include <json-c/json.h>
#include <pthread.h>
#include <stdio.h>
#include <string.h>
#include <libavutil/log.h>
#include "../vendor/evrtsp/log.h"

static int publish_during_encode;

static void *publish(void *marker)
{
  helper_log_event(E_LOG, L_RAOP, marker, NULL);
  return NULL;
}

/* Interpose only in this probe executable. Finish two native publications
 * inside a real poll's serialization, without timing or queue-layout hooks. */
const char *json_object_to_json_string_ext(struct json_object *json, int flags)
{
  const char *(*encode)(struct json_object *, int) =
    dlsym(RTLD_NEXT, "json_object_to_json_string_ext");
  assert(encode);
  if (publish_during_encode) {
    pthread_t first, second;
    publish_during_encode = 0;
    assert(pthread_create(&first, NULL, publish, "during_encode_first") == 0);
    assert(pthread_create(&second, NULL, publish, "during_encode_second") == 0);
    assert(pthread_join(first, NULL) == 0);
    assert(pthread_join(second, NULL) == 0);
  }
  return encode(json, flags);
}

static void check_concurrent_publication(char *buffer, size_t cap)
{
  helper_log_event(E_LOG, L_RAOP, "polled_before_encode", NULL);
  publish_during_encode = 1;
  assert(raop_log_poll(buffer, cap) > 0);
  assert(!publish_during_encode);
  assert(strstr(buffer, "\"nativeEvent\":\"polled_before_encode\""));
  unsigned seen = 0;
  for (int i = 0; i < 2; i++) {
    assert(raop_log_poll(buffer, cap) > 0);
    assert(strstr(buffer, "\"dropped\":0"));
    if (strstr(buffer, "\"nativeEvent\":\"during_encode_first\"")) seen |= 1;
    if (strstr(buffer, "\"nativeEvent\":\"during_encode_second\"")) seen |= 2;
  }
  assert(seen == 3);
  assert(raop_log_poll(buffer, cap) == 0);
}

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
  check_concurrent_publication(buffer, sizeof(buffer));
  assert(raop_log_consumer(0) == 0);
  assert(raop_log_consumer(1) == 0);
  assert(raop_log_poll(buffer, sizeof(buffer)) == 0);
  assert(raop_log_consumer(0) == 0);
  return 0;
}
