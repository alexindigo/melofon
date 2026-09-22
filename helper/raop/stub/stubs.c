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
static int helper_log_severity = E_LOG;

void
DPRINTF(int severity, int domain, const char *fmt, ...)
{
  va_list ap;

  if (severity > helper_log_severity)
    return;

  va_start(ap, fmt);
  vfprintf(stderr, fmt, ap);
  va_end(ap);
}

void
DVPRINTF(int severity, int domain, const char *fmt, va_list ap)
{
  if (severity > helper_log_severity)
    return;

  vfprintf(stderr, fmt, ap);
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
  (void)level;
  (void)fmt;
  (void)ap;
}

void
logger_libevent(int severity, const char *msg)
{
  DPRINTF(severity, L_EVENT, "%s\n", msg);
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
uint64_t libhash = 0;

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
