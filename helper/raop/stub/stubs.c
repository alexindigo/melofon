/* stubs.c — implementations of the OwnTone services the vendored RAOP code
 * references but the helper does not have: config file (JSON stdin commands
 * instead), logger (stderr), db (no DuckDB — never), player, artwork, dmap
 * metadata, mdns (no discovery — the start command names the device), http
 * icy (no internet radio), and the outputs registry (one device, owned by
 * main.c). */

#include <stdarg.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <pthread.h>
#include <stdatomic.h>
#include <time.h>
#include <json-c/json.h>
#include <libavutil/log.h>
#include <event2/event.h>
#include "../ffi.h"

#include <event2/buffer.h>

#include "logger.h"
#include "conffile.h"
#include "player.h"
#include "artwork.h"
#include "dmap_common.h"
#include "mdns.h"
#include "http.h"
#include "misc.h"
#include "outputs.h"
#include "db.h"

/* ------------------------------- logger ---------------------------------- */

/* 0 = quiet .. 5 = spam; set from argv --verbose in main.c. */
static _Atomic int helper_log_severity = E_LOG;
enum { LOG_CAPACITY = 256, LOG_MESSAGE = 2048 };
struct diagnostic {
  int severity, domain, truncated, typed, flags;
  uint64_t sequence, device;
  int64_t time_ms, value, value2;
  char event[48], message[LOG_MESSAGE], name[256], host[256];
};
static pthread_mutex_t log_lock = PTHREAD_MUTEX_INITIALIZER;
static struct diagnostic diagnostics[LOG_CAPACITY];
static size_t log_head, log_count;
static _Atomic uint64_t log_dropped, log_sequence;
static _Atomic int log_consumer;

static void capture(struct diagnostic *record)
{
  struct timespec now;
  clock_gettime(CLOCK_REALTIME, &now);
  record->time_ms = (int64_t)now.tv_sec * 1000 + now.tv_nsec / 1000000;
  record->sequence = atomic_fetch_add(&log_sequence, 1) + 1;
  /* A pacing/foreign producer never waits for JS (or for polling's lock). */
  if (pthread_mutex_trylock(&log_lock) != 0) {
    atomic_fetch_add(&log_dropped, 1); return;
  }
  if (log_count == LOG_CAPACITY) atomic_fetch_add(&log_dropped, 1);
  else {
    diagnostics[(log_head + log_count) % LOG_CAPACITY] = *record;
    log_count++;
  }
  pthread_mutex_unlock(&log_lock);
}

int raop_log_consumer(int enable)
{
  if (enable) {
    int expected = 0;
    if (!atomic_compare_exchange_strong(&log_consumer, &expected, 1)) return -1;
    av_log_set_callback(logger_ffmpeg);
    event_set_log_callback(logger_libevent);
  } else {
    av_log_set_callback(av_log_default_callback);
    event_set_log_callback(NULL);
    atomic_store(&log_consumer, 0);
  }
  return 0;
}

int raop_log_poll(char *buf, size_t cap)
{
  struct diagnostic overflow = { .severity = E_WARN, .domain = L_MAIN };
  struct diagnostic *r;
  struct json_object *json, *payload;
  const char *encoded;
  size_t length;
  uint64_t lost;
  if (!buf || !cap || !atomic_load(&log_consumer)) return -1;
  pthread_mutex_lock(&log_lock);
  lost = atomic_load(&log_dropped);
  if (!log_count && !lost) { pthread_mutex_unlock(&log_lock); return 0; }
  if (log_count) r = &diagnostics[log_head];
  else {
    struct timespec now;
    clock_gettime(CLOCK_REALTIME, &now);
    overflow.time_ms = (int64_t)now.tv_sec * 1000 + now.tv_nsec / 1000000;
    overflow.sequence = atomic_fetch_add(&log_sequence, 1) + 1;
    strcpy(overflow.event, "overflow");
    r = &overflow;
  }
  json = json_object_new_object();
  if (!json) { pthread_mutex_unlock(&log_lock); return -1; }
  json_object_object_add(json, "severity", json_object_new_int(r->severity));
  json_object_object_add(json, "domain", json_object_new_int(r->domain));
  json_object_object_add(json, "timeMs", json_object_new_int64(r->time_ms));
  json_object_object_add(json, "nativeSequence", json_object_new_uint64(r->sequence));
  json_object_object_add(json, "nativeEvent", json_object_new_string(r->event));
  json_object_object_add(json, "truncated", json_object_new_int(r->truncated));
  json_object_object_add(json, "dropped", json_object_new_uint64(lost));
  if (r->typed) {
    payload = json_object_new_object();
    json_object_object_add(payload, "device", json_object_new_uint64(r->device));
    json_object_object_add(payload, "value", json_object_new_int64(r->value));
    json_object_object_add(payload, "value2", json_object_new_int64(r->value2));
    json_object_object_add(payload, "name", json_object_new_string(r->name));
    json_object_object_add(payload, "host", json_object_new_string(r->host));
    json_object_object_add(payload, "flags", json_object_new_int(r->flags));
    json_object_object_add(json, "payload", payload);
  } else json_object_object_add(json, "payload", json_object_new_string(r->message));
  encoded = json_object_to_json_string_ext(json, JSON_C_TO_STRING_PLAIN);
  length = strlen(encoded);
  if (length >= cap) { json_object_put(json); pthread_mutex_unlock(&log_lock); return -1; }
  memcpy(buf, encoded, length);
  buf[length] = 0;
  if (log_count) { log_head = (log_head + 1) % LOG_CAPACITY; log_count--; }
  atomic_fetch_sub(&log_dropped, lost);
  json_object_put(json);
  pthread_mutex_unlock(&log_lock);
  return (int)length;
}

void helper_log_event(int severity, int domain, const char *event,
                      const struct helper_log_fields *fields)
{
  struct diagnostic r = { .severity = severity, .domain = domain, .typed = 1 };
  if (severity > atomic_load(&helper_log_severity)) return;
  if (!atomic_load(&log_consumer)) {
    /* Central native standalone transport preserves historical probe evidence. */
    if (strcmp(event, "device_start") == 0 && fields)
      DPRINTF(severity, domain, "Adding AirPlay device '%s': password: 0, verification: %u, encrypt: %u, authsetup: %u, metadata: %lld, type %lld, address %s:%lld\n", fields->name, (fields->flags & 1) != 0, (fields->flags & 2) != 0, (fields->flags & 4) != 0, (long long)fields->value2, (long long)(fields->flags >> 3), fields->host, (long long)fields->value);
    else if (strcmp(event, "pcm_peak") == 0 && fields)
      DPRINTF(severity, domain, "pcm_peak=%lld samples=%lld\n", (long long)fields->value, (long long)fields->value2);
    else DPRINTF(severity, domain, "%s device=%llu value=%lld\n", event, (unsigned long long)(fields ? fields->device : 0), (long long)(fields ? fields->value : 0));
    return;
  }
  if (snprintf(r.event, sizeof(r.event), "%s", event) >= sizeof(r.event)) r.truncated++;
  if (fields) {
    r.device = fields->device; r.value = fields->value; r.value2 = fields->value2; r.flags = fields->flags;
    if (fields->name && snprintf(r.name, sizeof(r.name), "%s", fields->name) >= sizeof(r.name)) r.truncated++;
    if (fields->host && snprintf(r.host, sizeof(r.host), "%s", fields->host) >= sizeof(r.host)) r.truncated++;
  }
  capture(&r);
}

void
DPRINTF(int severity, int domain, const char *fmt, ...)
{
  va_list ap;

  va_start(ap, fmt);
  DVPRINTF(severity, domain, fmt, ap);
  va_end(ap);
}

void
DVPRINTF(int severity, int domain, const char *fmt, va_list ap)
{
  if (severity > atomic_load(&helper_log_severity))
    return;
  if (atomic_load(&log_consumer)) {
    struct diagnostic r = { .severity = severity, .domain = domain };
    int length = vsnprintf(r.message, sizeof(r.message), fmt, ap);
    strcpy(r.event, "printf");
    r.truncated = length < 0 || length >= sizeof(r.message);
    capture(&r);
  } else vfprintf(stderr, fmt, ap);
}

void
DHEXDUMP(int severity, int domain, const unsigned char *data, int data_len, const char *heading)
{
  (void)data;
  (void)data_len;
  (void)heading;

  if (severity > helper_log_severity)
    return;
}

void
logger_ffmpeg(void *ptr, int level, const char *fmt, va_list ap)
{
  (void)ptr;
  if (level > av_log_get_level()) return;
  /* Preserve FFmpeg's source filter, independent of OwnTone's E_LOG gate. */
  if (atomic_load(&log_consumer)) {
    struct diagnostic r = { .domain = L_FFMPEG, .severity = level <= AV_LOG_FATAL ? E_FATAL : level <= AV_LOG_ERROR ? E_LOG : level <= AV_LOG_WARNING ? E_WARN : level <= AV_LOG_INFO ? E_INFO : E_DBG };
    int length = vsnprintf(r.message, sizeof(r.message), fmt, ap);
    strcpy(r.event, "ffmpeg");
    r.truncated = length < 0 || length >= sizeof(r.message);
    capture(&r);
  }
}

void
logger_libevent(int severity, const char *msg)
{
  /* libevent's levels are _EVENT_LOG_DEBUG/MSG/WARN/ERR = 0/1/2/3.
   * No call back into libevent is permitted from this callback. */
  int mapped = severity <= 0 ? E_DBG : severity == 1 ? E_INFO : severity == 2 ? E_WARN : E_LOG;
  if (atomic_load(&log_consumer)) {
    struct diagnostic r = { .domain = L_EVENT, .severity = mapped };
    strcpy(r.event, "libevent");
    r.truncated = snprintf(r.message, sizeof(r.message), "%s", msg) >= sizeof(r.message);
    capture(&r);
  } else DPRINTF(mapped, L_EVENT, "%s\n", msg);
}

void
logger_reinit(void)
{
}

int
logger_severity(void)
{
  return helper_log_severity;
}

void
helper_logger_set_severity(int severity)
{
  helper_log_severity = severity;
}

/* ------------------------------- conffile -------------------------------- */

cfg_t *cfg = NULL;

/* OwnTone hashes the library name into the 64-bit id sent as DACP-ID /
 * Client-Instance on every RTSP request (conffile.c upstream). A zero id
 * makes Apple devices (arbat, AppleTV3,1) accept the session yet never
 * render — named by the 2026-09-22 wire capture vs owntone-ref. */
uint64_t libhash;

static void __attribute__((constructor))
libhash_init(void)
{
  const char *libname = "Melofon";

  libhash = murmur_hash64(libname, strlen(libname), 0);
}

cfg_t *cfg_getsec(cfg_t *c, const char *name) { (void)c; (void)name; return NULL; }
cfg_t *cfg_gettsec(cfg_t *c, const char *name, const char *title) { (void)c; (void)name; (void)title; return NULL; }

const char *cfg_getstr(cfg_t *c, const char *name)
{
  (void)c;
  /* OwnTone defaults the helper still wants (RTSP headers / SDP). */
  if (name && strcmp(name, "user_agent") == 0)
    return "Melofon/0.1";
  if (name && strcmp(name, "name") == 0)
    return "Melofon";
  return NULL;
}

const char *cfg_getnstr(cfg_t *c, const char *name, unsigned int index) { (void)c; (void)name; (void)index; return NULL; }
bool cfg_getbool(cfg_t *c, const char *name) { (void)c; (void)name; return false; }
int cfg_getint(cfg_t *c, const char *name) { (void)c; (void)name; return 0; }
cfg_opt_t *cfg_getopt(cfg_t *c, const char *name) { (void)c; (void)name; return NULL; }
int cfg_size(cfg_t *c, const char *name) { (void)c; (void)name; return 0; }
const char *cfg_name(cfg_t *c) { (void)c; return "melofon-raop"; }
bool cfg_opt_getnbool(cfg_opt_t *opt, unsigned int index) { (void)opt; (void)index; return false; }

/* -------------------------------- player --------------------------------- */

int
player_device_add(void *device)
{
  (void)device;
  return 0;
}

int
player_device_remove(void *device)
{
  (void)device;
  return 0;
}

/* -------------------------------- artwork -------------------------------- */

int
artwork_get_by_queue_item_id(struct evbuffer *evbuf, int item_id, int max_w, int max_h, int format)
{
  (void)evbuf; (void)item_id; (void)max_w; (void)max_h; (void)format;
  return -1;
}

/* --------------------------------- dmap ----------------------------------- */

int
dmap_encode_queue_metadata(struct evbuffer *songlist, struct evbuffer *song, struct db_queue_item *queue_item)
{
  (void)songlist; (void)song; (void)queue_item;
  return -1;
}

/* --------------------------------- mdns ----------------------------------- */

int
mdns_browse(char *type, mdns_browse_cb cb, enum mdns_options flags)
{
  (void)type; (void)cb; (void)flags;
  return 0;
}

/* ------------------------------ http (icy) -------------------------------- */

struct http_icy_metadata *
http_icy_metadata_get(struct AVFormatContext *fmtctx, int packet_only)
{
  (void)fmtctx; (void)packet_only;
  return NULL;
}

void
http_icy_metadata_free(struct http_icy_metadata *metadata, int content_only)
{
  (void)metadata; (void)content_only;
}

/* ---------------------------------- db ------------------------------------ */

struct db_queue_item *
db_queue_fetch_byitemid(uint32_t item_id)
{
  (void)item_id;
  return NULL;
}

int
db_speaker_save(struct output_device *device)
{
  (void)device;
  return 0;
}

void
free_queue_item(struct db_queue_item *qi, int content_only)
{
  (void)content_only;
  free(qi);
}

/* -------------------------------- outputs --------------------------------- */

/* ffi.c owns the device registry (one output_device per raop_t handle) and
 * the per-handle state-event hook. */
extern struct output_device *raop_ffi_device_find(uint64_t device_id);
extern void raop_ffi_on_state(uint64_t device_id, enum output_device_state state);

struct output_device *
outputs_device_get(uint64_t device_id)
{
  return raop_ffi_device_find(device_id);
}

int
outputs_device_session_add(uint64_t device_id, void *session)
{
  struct output_device *device = raop_ffi_device_find(device_id);
  if (device)
    device->session = session;
  return 0;
}

void
outputs_device_session_remove(uint64_t device_id)
{
  struct output_device *device = raop_ffi_device_find(device_id);
  if (device)
    device->session = NULL;
}

int
outputs_quality_subscribe(struct media_quality *quality)
{
  (void)quality;
  return 0;
}

void
outputs_quality_unsubscribe(struct media_quality *quality)
{
  (void)quality;
}

/* How much audio (ms) the output buffer holds — OwnTone's default
 * (outputs.c:1326): 2250 = the 2000 ms sender-side delay iTunes/Apple Music
 * signal in the first sync packet (88200 samples at 44.1k) plus the 250 ms
 * the device adds itself. raop.c:1925 turns this into output_buffer_samples
 * — a shorter value shifts the whole playout schedule earlier and some
 * AirPlay devices ignore the given values and stick to 2.25 seconds. */
uint64_t
outputs_buffer_duration_ms_get(void)
{
  return 2250; /* OwnTone default (outputs.c:1326). Not 1000. */
}

bool
outputs_exclusive_mode_get(void)
{
  return false;
}

void
outputs_cb(int callback_id, uint64_t device_id, enum output_device_state state)
{
  (void)callback_id;
  raop_ffi_on_state(device_id, state);
}

void
outputs_device_free(struct output_device *device)
{
  if (!device)
    return;

  free(device->name);
  free(device->v4_address);
  free(device->v6_address);
  free(device->auth_key);
  free(device);
}

const char *
outputs_name(enum output_types type)
{
  (void)type;
  return "AirPlay 1";
}
