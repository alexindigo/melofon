/* ffi.c — libmelofon_raop: OwnTone's RAOP (raop.c, vendored under vendor/)
 * as an in-process library for Melofon's Deno FFI — no helper binary, no
 * stdin protocol (that was the old main.c). Flat opaque-handle C API, no
 * callbacks into JS; Deno polls events (raop_poll). This file is only the
 * dlopen surface: command queue, PCM hand-off, event ring. The pacing —
 * the 10 ms tick, the pts clock, the start buffer, starting only after
 * CONNECTED — lives in player.c, the stand-in for OwnTone's player.c.
 *
 * Threading: raop.c is process-global (OwnTone runs one RAOP module per
 * process), so the library owns ONE runtime — a background pthread with the
 * libevent base — ref-counted by handles (raop_new starts it, the last
 * raop_free stops and joins it). Each handle is one AirPlay device: a
 * command queue onto the loop (event_base_once, evthread), a player.c
 * instance the PCM flows through, and an event ring Deno drains.
 * Several selected outputs of one format share raop.c's master session —
 * OwnTone's synced multi-speaker model; the Deno side feeds PCM through a
 * single designated handle so the shared stream is never double-fed.
 *
 * The additive explicit-stream API instead owns one player per stream and
 * immutable device attachments. Compatibility handles retain their old pacers
 * during the boot migration. Both routes reserve the same active-stream guard;
 * dormant streams keep the runtime alive without activating native sessions.
 *
 * Exported API (see also helper/raop/ffi.h):
 *   raop_t *raop_new(void);
 *   int raop_start(raop_t *, host, port, name, volume);
 *   int raop_write(raop_t *, pcm, len)   — bytes accepted (< len: full)
 *   int raop_volume(raop_t *, pct);
 *   int raop_flush(raop_t *);
 *   int raop_teardown(raop_t *);
 *   int raop_pin(raop_t *, pin);
 *   int raop_poll(raop_t *, buf, cap)    — JSON bytes, 0 = none
 *   int raop_free(raop_t *);             — 0 = released, -1 = leaked (said so)
 */

#ifdef HAVE_CONFIG_H
# include <config.h>
#endif

#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <unistd.h>
#include <netdb.h>
#include <arpa/inet.h>
#include <pthread.h>
#include <limits.h>

#include <event2/event.h>
#include <event2/buffer.h>
#include <event2/thread.h>
#include <gcrypt.h>

#include "logger.h"
#include "misc.h"
#include "outputs.h"
#include "ffi.h"
#include "raop-bridge.h"

/* The RAOP output backend (raop.c). */
extern struct output_definition output_raop;

/* player.c — the stand-in for OwnTone src/player.c's RAOP calling
 * convention: the 10 ms pacing tick (timerfd, armed at CONNECTED), the pts
 * stream clock, and the PCM read-ahead with its backpressure cap. */
struct raop_player;
struct raop_player *raop_player_new(struct event_base *evbase, uint64_t stream_id);
void raop_player_free(struct raop_player *p);
int raop_player_write(struct raop_player *p, const uint8_t *pcm, size_t len);
void raop_player_flush(struct raop_player *p);
void raop_player_fence(struct raop_player *p, bool fenced);
int raop_player_append(struct raop_player *p, const uint8_t *pcm, size_t len);
void raop_player_session_started(struct raop_player *p);
void raop_player_session_stopped(struct raop_player *p);
void raop_player_item_set(struct raop_player *p, const char *title,
                          const char *artist, uint32_t pos_ms, uint32_t len_ms,
                          uint16_t wanted_metadata);

/* Globals the vendored code expects (see stubs.c). */
struct event_base *evbase_player;

/* stubs.c — the debug knob (MELOFON_RAOP_DEBUG raises severity to E_DBG). */
void helper_logger_set_severity(int severity);

/* raop.c enum raop_devtype values. */
#define RDEV_APEX1   0
#define RDEV_APEX2   1
#define RDEV_APEX3   2
#define RDEV_APPLETV 3
#define RDEV_APPLETV4 4
#define RDEV_HOMEPOD 5
#define RDEV_OTHER   6

/* Event ring per handle (state events are tiny and rare). */
#define EVENT_RING 16
#define EVENT_LEN  96

typedef enum
{
  CMD_START,
  CMD_VOLUME,
  CMD_FLUSH,
  CMD_TEARDOWN,
  CMD_PIN,
  CMD_FREE,
} cmd_type;

/* raop_free ↔ the loop thread: the free happens on the loop thread (the only
 * place nothing can be mid-callback on the handle), then it signals done. */
typedef struct free_sync
{
  pthread_mutex_t lock;
  pthread_cond_t cond;
  int done;
  int result;
} free_sync;

typedef struct cmd
{
  cmd_type type;
  uint64_t epoch; /* stream incarnation captured at control admission */
  char host[256];
  int port;
  char name[256];
  int volume;
  int devtype;                  /* RDEV_* (raop.c enum raop_devtype) */
  int encrypt;
  char pin[32];
  uint32_t pos_ms;
  uint32_t len_ms;
  uint16_t wanted_metadata;     /* TXT md bitmask (raop_device_cb) */
  int authsetup;                /* TXT et token 4 */
  int requires_auth;            /* TXT sf bit 9 */
  int has_password;
  int probe;
  char *password;
  char *auth_key;
  char title[256];
  char artist[256];
  free_sync *sync;              /* CMD_FREE only */
  struct cmd *next;
} cmd;

static void
cmd_free(cmd *c)
{
  if (c->password) { explicit_bzero(c->password, strlen(c->password)); free(c->password); }
  if (c->auth_key) { explicit_bzero(c->auth_key, strlen(c->auth_key)); free(c->auth_key); }
  explicit_bzero(c->pin, sizeof(c->pin));
  free(c);
}

struct raop_handle
{
  uint64_t id;                     /* device id (raop.c outputs_device_get) */
  struct output_device *device;    /* NULL until the start command runs */
  enum output_device_state state;

  /* The player stand-in: PCM read-ahead, pacing tick, pts clock (player.c). */
  struct raop_player *player;
  struct raop_stream *stream;       /* immutable; NULL = compatibility handle */
  bool ready;                       /* loop-owned attachment readiness */
  bool quiescing;                   /* local release fences late callbacks */
  bool legacy_claim;                /* rt.lock; retained until proven free */
  uint64_t session_revision;        /* loop-owned, never reuses retired session */
  uint64_t failure_epoch, session_error; /* rt.lock; attachment-local failure */
  bool probe_only;

  /* Event ring for raop_poll. */
  char events[EVENT_RING][EVENT_LEN];
  int events_head;                 /* next write */
  int events_tail;                 /* next read */
  pthread_mutex_t events_lock;

  /* Latest credential state plus one leased snapshot. Fixed-size owned storage
   * avoids allocation failure at export; revisions never use the state ring. */
  pthread_mutex_t credential_lock;
  uint64_t credential_revision, credential_pending, credential_leased;
  int credential_kind, credential_lease_kind;
  char credential_key[129], credential_lease_key[129];

  /* Commands queued by the API onto the loop thread. */
  cmd *cmds_head;
  cmd *cmds_tail;
  pthread_mutex_t cmds_lock;
  int cmds_scheduled;           /* one pending once-callback at a time */
  struct event *resume_event;
  cmd *release_command;
  int release_completed;
  int free_requested;

  struct raop_handle *next;
};

typedef struct raop_handle raop_t;

struct cancel_receipt {
  struct raop_cancel_result result;
  size_t retire_count;
  uint64_t *retire_ids;
  cmd **retire_commands;
  bool applied;
  struct cancel_receipt *next;
};

#define COMPLETION_CAP 256
struct completion_receipt {
  struct raop_completion_result result;
  struct raop_completion_attachment *attachment;
  /* Latest captured-session facts remain live behind an immutable terminal
   * result. A revision copies these facts, never mutates the old snapshot. */
  struct raop_completion_attachment *observed;
  uint64_t observed_transport_end;
  struct completion_receipt *next;
};
static void completion_update_locked(struct raop_stream *);
static void completion_withdraw_locked(raop_t *);
static void completion_settle_locked(struct raop_stream *, uint64_t, uint64_t, uint64_t);

static void
cancel_receipt_free(struct cancel_receipt *c)
{
  for (size_t i = 0; i < c->retire_count; i++)
    if (c->retire_commands[i]) cmd_free(c->retire_commands[i]);
  free(c->retire_commands);
  free(c->retire_ids);
  free(c);
}

struct raop_stream
{
  uint64_t id;
  uint64_t epoch;                    /* rt.lock; exact admission incarnation */
  struct raop_player *player;
  unsigned attachments;             /* rt.lock; includes retiring handles */
  unsigned readers;                 /* rt.lock; loop-dispatched progress reads */
  bool closing;                     /* rt.lock; admission fence */
  bool input_closed;                /* rt.lock; typed close precedes join/free */
  bool active;                      /* rt.lock; guard retained until free */
  bool item_set;                    /* loop-owned first attachment item */
  bool resetting;                   /* rt.lock; local reset admission fence */
  bool canceling;                   /* rt.lock; ordered receiver reset */
  struct event *cancel_event;
  struct cancel_receipt *cancels;
  struct completion_receipt *completions; /* rt.lock; retained across epochs */
  size_t completion_count;
  bool marker_reserved;             /* current unsealed source's receipt slot */
  struct raop_stream *next;
};

/* ------------------------------------------------------------------ runtime */

static struct
{
  pthread_t thread;
  struct event_base *base;
  int handles;                 /* live handle count (runtime_lock) */
  bool running;
  bool stopping;
  bool starting;
  bool startup_finished;
  int startup_result;
  pthread_mutex_t lock;
  pthread_cond_t idle;
  uint64_t next_device_id;
  uint64_t next_stream_id;
  uint64_t active_stream_id;        /* 0 = none, 1 = compatibility group */
  unsigned legacy_claims;
  raop_t *handles_list;        /* all handles (loop thread iterates) */
  struct raop_stream *streams;
} rt = {
  .lock = PTHREAD_MUTEX_INITIALIZER,
  .idle = PTHREAD_COND_INITIALIZER,
  .next_device_id = 1,
  .next_stream_id = 2,
};

/* All admission routes, including compatibility read-ahead, share this guard.
 * Retain it through failed close and all queued/retiring native resources. */
static int
stream_claim_locked(struct raop_stream *stream, raop_t *legacy)
{
  uint64_t id = stream ? stream->id : 1;
  if (stream && (stream->closing || stream->input_closed)) return -1;
  if (rt.active_stream_id && rt.active_stream_id != id) return -2;
  rt.active_stream_id = id;
  if (stream) stream->active = true;
  else if (!legacy->legacy_claim) {
    legacy->legacy_claim = true;
    rt.legacy_claims++;
  }
  return 0;
}

/* Loop thread, rt.lock held. A device's loss does not stop the stream while
 * any healthy attachment remains. No receiver owns or elects the pacer. */
static void
stream_readiness_locked(raop_t *h)
{
  if (h->stream && h->stream->resetting) {
    raop_player_session_stopped(h->player);
    return;
  }
  if (!h->stream) {
    if (h->ready) raop_player_session_started(h->player);
    else raop_player_session_stopped(h->player);
    return;
  }
  for (raop_t *peer = rt.handles_list; peer; peer = peer->next)
    if (peer->stream == h->stream && peer->ready) {
      raop_player_session_started(h->player);
      return;
    }
  raop_player_session_stopped(h->player);
}

/* ------------------------------------------------------------ event ring */

static void
event_push(raop_t *h, const char *state_value)
{
  pthread_mutex_lock(&h->events_lock);
  snprintf(h->events[h->events_head], EVENT_LEN,
           "{\"event\":\"state\",\"value\":\"%s\"}", state_value);
  h->events_head = (h->events_head + 1) % EVENT_RING;
  if (h->events_head == h->events_tail)
    h->events_tail = (h->events_tail + 1) % EVENT_RING; /* drop oldest */
  pthread_mutex_unlock(&h->events_lock);
}

/* stubs.c routes outputs_cb() here. */
void
raop_ffi_on_state(uint64_t device_id, enum output_device_state state)
{
  raop_t *h;
  const char *value;

  switch (state)
    {
      case OUTPUT_STATE_STARTUP:   value = "starting";  break;
      case OUTPUT_STATE_CONNECTED: value = "connected"; break;
      case OUTPUT_STATE_STREAMING: value = "streaming"; break;
      case OUTPUT_STATE_STOPPED:   value = "stopped";   break;
      case OUTPUT_STATE_FAILED:    value = "failed";    break;
      case OUTPUT_STATE_PASSWORD:  value = "password";  break;
      default:                     value = "unknown";   break;
    }

  pthread_mutex_lock(&rt.lock);
  for (h = rt.handles_list; h; h = h->next)
    if (h->id == device_id)
      {
        if (h->stream && (state == OUTPUT_STATE_FAILED || state == OUTPUT_STATE_PASSWORD)) {
          completion_update_locked(h->stream);
          completion_settle_locked(h->stream, h->id, 3, RAOP_PROGRESS_TRANSPORT);
        }
        h->state = state;
        /* OwnTone arms the playback timer when the device reports
         * CONNECTED and disarms it on teardown/failure — no PCM leaves
         * during the handshake, and nothing buffered earlier is dumped
         * (Deno waits for the connected event before feeding). */
        if (state == OUTPUT_STATE_CONNECTED || state == OUTPUT_STATE_STREAMING)
          h->ready = !h->quiescing;
        else if (state == OUTPUT_STATE_STOPPED || state == OUTPUT_STATE_FAILED ||
                 state == OUTPUT_STATE_PASSWORD)
          h->ready = false;
        stream_readiness_locked(h);
        event_push(h, value);
        break;
      }
  pthread_mutex_unlock(&rt.lock);
}

/* stubs.c routes pairing saves here; never a diagnostic/control event. */
int
raop_ffi_credential_changed(uint64_t device_id, const char *key)
{
  if (key) {
    if (strnlen(key, 129) != 128) return -1;
    for (size_t i = 0; i < 128; i++)
      if (!((key[i] >= '0' && key[i] <= '9') ||
            (key[i] >= 'a' && key[i] <= 'f') ||
            (key[i] >= 'A' && key[i] <= 'F'))) return -1;
  }
  int result = -1;
  pthread_mutex_lock(&rt.lock);
  for (raop_t *h = rt.handles_list; h; h = h->next) if (h->id == device_id) {
    pthread_mutex_lock(&h->credential_lock);
    if (h->credential_revision != UINT64_MAX) {
      h->credential_pending = ++h->credential_revision;
      h->credential_kind = key ? 1 : 2;
      explicit_bzero(h->credential_key, sizeof(h->credential_key));
      if (key) memcpy(h->credential_key, key, 128);
      result = 0;
    }
    pthread_mutex_unlock(&h->credential_lock);
    break;
  }
  pthread_mutex_unlock(&rt.lock);
  return result;
}

/* stubs.c routes outputs_device_get() here. */
struct output_device *
raop_ffi_device_find(uint64_t device_id)
{
  raop_t *h;
  struct output_device *device = NULL;

  pthread_mutex_lock(&rt.lock);
  for (h = rt.handles_list; h; h = h->next)
    if (h->id == device_id)
      {
        device = h->device;
        break;
      }
  pthread_mutex_unlock(&rt.lock);
  return device;
}

/* ----------------------------------------------------------------- commands */

/* Resolve host (name or numeric) to a numeric v4/v6 string for inet_pton. */
static char *
resolve_address(const char *host)
{
  struct addrinfo hints;
  struct addrinfo *res = NULL;
  struct addrinfo *ai;
  char *out = NULL;

  memset(&hints, 0, sizeof(hints));
  hints.ai_family = AF_UNSPEC;
  hints.ai_socktype = SOCK_STREAM;

  if (getaddrinfo(host, NULL, &hints, &res) != 0)
    {
      helper_log_event(E_LOG, L_RAOP, "resolve_failed", &(struct helper_log_fields){ .host = host });
      return NULL;
    }

  for (ai = res; ai; ai = ai->ai_next)
    {
      char buf[INET6_ADDRSTRLEN];
      void *addr;

      if (ai->ai_family == AF_INET)
        addr = &((struct sockaddr_in *)ai->ai_addr)->sin_addr;
      else if (ai->ai_family == AF_INET6)
        addr = &((struct sockaddr_in6 *)ai->ai_addr)->sin6_addr;
      else
        continue;

      if (inet_ntop(ai->ai_family, addr, buf, sizeof(buf)))
        {
          out = strdup(buf);
          break;
        }
    }

  freeaddrinfo(res);
  return out;
}

static void
device_free(raop_t *h)
{
  if (!h->device)
    return;

  if (h->device->extra_device_info)
    {
      free(h->device->extra_device_info);
      h->device->extra_device_info = NULL;
    }

  outputs_device_free(h->device);
  h->device = NULL;
}

/* raop.c's private struct raop_extra, mirrored (see VENDORING.md). */
struct raop_extra_mirror
{
  int devtype;
  uint16_t wanted_metadata;
  bool encrypt;
  bool supports_auth_setup;
};

/* OwnTone raop.c:302-311 — grep-able vs "Adding AirPlay device". */
static const char *raop_devtype_name[] =
{
  "AirPort Express 1 - 802.11g",
  "AirPort Express 2 - 802.11n",
  "AirPort Express 3 - 802.11n",
  "AppleTV",
  "AppleTV4",
  "HomePod",
  "Other",
};

/* Loop thread: create the device for h and open the RAOP session. */
static int
device_start(raop_t *h, cmd *c)
{
  struct output_device *dev;
  struct raop_extra_mirror *re;
  char *address;

  pthread_mutex_lock(&rt.lock);
  h->failure_epoch = h->session_error = 0;
  pthread_mutex_unlock(&rt.lock);

  if (h->session_revision == UINT64_MAX) {
    if (h->stream) raop_ffi_attachment_failed(h->stream->id, h->id, RAOP_PROGRESS_TRANSPORT);
    event_push(h, "failed");
    return -1;
  }

  address = resolve_address(c->host);
  if (!address)
    {
      if (h->stream) raop_ffi_attachment_failed(h->stream->id, h->id, RAOP_PROGRESS_TRANSPORT);
      event_push(h, "failed");
      return -1;
    }

  dev = calloc(1, sizeof(*dev));
  re = calloc(1, sizeof(*re));
  if (!dev || !re)
    {
      if (h->stream) raop_ffi_attachment_failed(h->stream->id, h->id, RAOP_PROGRESS_ALLOCATION);
      free(dev);
      free(re);
      free(address);
      event_push(h, "failed");
      return -1;
    }

  re->devtype = c->devtype;           /* from mDNS am (default appletv) */
  re->wanted_metadata = c->wanted_metadata;
  re->encrypt = c->encrypt ? true : false;
  re->supports_auth_setup = c->authsetup ? true : false;

  dev->id = h->id;
  dev->stream_id = h->stream ? h->stream->id : 1;
  dev->name = strdup(c->name);
  dev->type = OUTPUT_TYPE_RAOP;
  dev->type_name = "AirPlay 1";
  dev->selected = 1;
  dev->advertised = 1;
  dev->volume = c->volume;
  dev->relvol = c->volume;
  dev->requires_auth = c->requires_auth ? 1 : 0;
  dev->has_password = c->has_password;
  dev->password = c->password;
  dev->auth_key = c->auth_key;
  c->password = NULL;
  c->auth_key = NULL;
  /* OwnTone's RAOP_CONFIG_MAX_VOLUME: pct 100 maps to 0 dB, pct 0 to -30. */
  dev->max_volume = 11;
  dev->quality.sample_rate = 44100;
  dev->quality.bits_per_sample = 16;
  dev->quality.channels = 2;
  dev->supported_formats = MEDIA_FORMAT_PCM;
  dev->default_format = MEDIA_FORMAT_PCM;
  dev->extra_device_info = re;

  if (strchr(address, ':'))
    {
      dev->v6_address = address;
      dev->v6_port = (short)c->port;
    }
  else
    {
      dev->v4_address = address;
      dev->v4_port = (short)c->port;
    }

  h->device = dev;
  pthread_mutex_lock(&rt.lock);
  if (c->probe) completion_withdraw_locked(h);
  h->probe_only = c->probe;
  h->quiescing = false;
  pthread_mutex_unlock(&rt.lock);
  h->state = OUTPUT_STATE_STARTUP;
  event_push(h, "starting");

  if (!h->stream || !h->stream->item_set) {
    raop_player_item_set(h->player, c->title, c->artist, c->pos_ms, c->len_ms,
                         c->wanted_metadata);
    if (h->stream) h->stream->item_set = true;
  }

  /* OwnTone raop_device_cb (raop.c:4463). Contract test greps this. */
  helper_log_event(E_LOG, L_RAOP, "device_start", &(struct helper_log_fields){
    .device = h->id, .name = c->name, .host = address, .value = c->port,
    .value2 = re->wanted_metadata,
    .flags = (dev->requires_auth ? 1 : 0) | (re->encrypt ? 2 : 0) |
             (re->supports_auth_setup ? 4 : 0) | (c->devtype << 3)
  });

  if ((c->probe ? output_raop.device_probe(dev, 0) : output_raop.device_start(dev, 0)) < 0)
    {
      if (h->stream) raop_ffi_attachment_failed(h->stream->id, h->id, RAOP_PROGRESS_TRANSPORT);
      device_free(h);
      h->state = OUTPUT_STATE_FAILED;
      event_push(h, "failed");
      return -1;
    }

  return 0;
}

static void
device_released(raop_t *h)
{
  if (!h->device)
    return;

  device_free(h);
  if (!h->stream) {
    raop_player_session_stopped(h->player);
    raop_player_flush(h->player);
  }

  h->state = OUTPUT_STATE_STOPPED;
  event_push(h, "stopped");
}

static void cmds_drain_cb(evutil_socket_t fd, short what, void *arg);

/* Native completion signals device ID, never a raw handle. Resume only on the
 * preallocated owned event, not inline inside a still-running drain stack. */
static void
native_released(uint64_t id, int sent)
{
  raop_t *h;
  pthread_mutex_lock(&rt.lock);
  for (h = rt.handles_list; h; h = h->next) if (h->id == id) {
    h->release_completed = 1;
    if (sent < 0) helper_log_event(E_LOG, L_RAOP, "teardown_unsent", &(struct helper_log_fields){ .device = id });
    event_active(h->resume_event, EV_TIMEOUT, 1);
    break;
  }
  pthread_mutex_unlock(&rt.lock);
}

/* Loop thread: serialize commands across native terminal release. */
static void
cmds_drain_cb(evutil_socket_t fd, short what, void *arg)
{
  raop_t *h = arg;
  cmd *c;
  (void)fd; (void)what;
  for (;;)
    {
      int released = 0;
      if (h->release_command) {
        if (!h->release_completed) return;
        c = h->release_command;
        h->release_command = NULL;
        h->release_completed = 0;
        device_released(h);
        released = 1;
      } else {
        pthread_mutex_lock(&h->cmds_lock);
        c = h->cmds_head;
        if (!c) {
          h->cmds_scheduled = 0;
          pthread_mutex_unlock(&h->cmds_lock);
          return;
        }
        h->cmds_head = c->next;
        if (!h->cmds_head) h->cmds_tail = NULL;
        pthread_mutex_unlock(&h->cmds_lock);
      }
      if (h->stream && (c->type == CMD_START || c->type == CMD_FLUSH)) {
        pthread_mutex_lock(&rt.lock);
        bool stale = c->epoch != h->stream->epoch;
        pthread_mutex_unlock(&rt.lock);
        if (stale) { cmd_free(c); continue; }
      }
      if (!released && (c->type == CMD_TEARDOWN || c->type == CMD_FREE ||
                        (c->type == CMD_START && h->device))) {
        pthread_mutex_lock(&rt.lock);
        completion_withdraw_locked(h);
        h->quiescing = true;
        h->ready = false;
        stream_readiness_locked(h);
        pthread_mutex_unlock(&rt.lock);
        h->release_command = c;
        if (raop_release_device(h->id, native_released) == 0) return;
        h->release_command = NULL;
        helper_log_event(E_LOG, L_RAOP, "release_blocked", &(struct helper_log_fields){ .device = h->id });
        if (c->type == CMD_FREE) {
          pthread_mutex_lock(&c->sync->lock);
          c->sync->result = -1; c->sync->done = 1;
          pthread_cond_signal(&c->sync->cond);
          pthread_mutex_unlock(&c->sync->lock);
        } else event_push(h, "failed");
        cmd_free(c);
        continue;
      }
      switch (c->type)
        {
          case CMD_START:
            device_start(h, c);
            break;

          case CMD_VOLUME:
            if (h->device)
              {
                h->device->volume = c->volume;
                output_raop.device_volume_set(h->device, 0);
              }
            break;

          case CMD_FLUSH:
            pthread_mutex_lock(&rt.lock);
            completion_withdraw_locked(h);
            pthread_mutex_unlock(&rt.lock);
            if (!h->stream) raop_player_flush(h->player);
            if (h->device && h->device->session)
              output_raop.device_flush(h->device, 0);
            break;

          case CMD_TEARDOWN:
            /* device_released ran only after native sockets were destroyed. */
            break;

          case CMD_PIN:
            if (h->device)
              {
                if (output_raop.device_authorize(h->device, c->pin, 0) < 0)
                  event_push(h, "failed");
              }
            break;

          case CMD_FREE:
            /* Registry and runtime remain owned UNTIL native completion. */
            pthread_mutex_lock(&rt.lock);
            raop_t **link;
            for (link = &rt.handles_list; *link; link = &(*link)->next)
              if (*link == h) { *link = h->next; break; }
            if (h->stream) h->stream->attachments--;
            if (h->legacy_claim && --rt.legacy_claims == 0)
              rt.active_stream_id = 0;
            pthread_mutex_unlock(&rt.lock);
            if (!h->stream) raop_player_free(h->player);
            event_free(h->resume_event);
            pthread_mutex_destroy(&h->events_lock);
            pthread_mutex_destroy(&h->cmds_lock);
            explicit_bzero(h->credential_key, sizeof(h->credential_key));
            explicit_bzero(h->credential_lease_key, sizeof(h->credential_lease_key));
            pthread_mutex_destroy(&h->credential_lock);
            free(h);
            pthread_mutex_lock(&c->sync->lock);
            c->sync->result = 0;
            c->sync->done = 1;
            pthread_cond_signal(&c->sync->cond);
            pthread_mutex_unlock(&c->sync->lock);
            cmd_free(c);
            return;
        }
      cmd_free(c);
    }
}

/* API thread: queue a command onto the loop. At most one drain callback is
 * pending per handle at a time (cmds_scheduled) — a second pending callback
 * could run after a CMD_FREE freed the handle (the JBL-403 crash).
 *
 * Failure contract (plan atv3-session-recycle): if event_base_once fails,
 * the push is ROLLED BACK — command unlinked, cmds_scheduled restored — and
 * -1 is returned. Without the rollback the queue would be permanently
 * undrainable: the command stays linked with no drain pending, the stuck
 * cmds_scheduled blocks every later schedule, and raop_free would wait
 * forever on its CMD_FREE. */
static int
cmd_push(raop_t *h, cmd *c)
{
  struct timeval zero = { 0, 0 };
  int schedule;

  pthread_mutex_lock(&h->cmds_lock);
  if (h->free_requested && c->type != CMD_FREE) {
    pthread_mutex_unlock(&h->cmds_lock); cmd_free(c); return -1;
  }
  c->next = NULL;
  if (h->cmds_tail)
    h->cmds_tail->next = c;
  else
    h->cmds_head = c;
  h->cmds_tail = c;
  schedule = !h->cmds_scheduled;
  h->cmds_scheduled = 1;

  if (!schedule)
    {
      pthread_mutex_unlock(&h->cmds_lock);
      return 0; /* the pending drain will see this command */
    }

  /* Keep scheduling and rollback under the queue lock: a concurrent FREE
   * must not be accepted behind a provisional once-event that then fails.
   * Otherwise its waiter can be stranded with no drain left to wake it. */
  if (event_base_once(rt.base, -1, EV_TIMEOUT, cmds_drain_cb, h, &zero) < 0)
    {
      cmd **link;

      /* c is in the queue (we just linked it) and no drain callback is
       * pending — schedule was true ⇔ cmds_scheduled was 0 — so nothing
       * can have consumed it. Concurrent pushes are held at the queue lock.
       * The failed push owns c: unlink it, free it, restore the flag. */
      link = &h->cmds_head;
      while (*link && *link != c)
        link = &(*link)->next;
      if (*link == c)
        {
          cmd *tail;

          *link = c->next;
          if (h->cmds_tail == c)
            {
              tail = NULL;
              for (link = &h->cmds_head; *link; link = &(*link)->next)
                tail = *link;
              h->cmds_tail = tail;
            }
        }
      h->cmds_scheduled = 0;
      pthread_mutex_unlock(&h->cmds_lock);
      cmd_free(c);
      return -1;
    }
  pthread_mutex_unlock(&h->cmds_lock);
  return 0;
}

/* ------------------------------------------------------------------ runtime */

static void *
loop_main(void *arg)
{
  (void)arg;

  struct event_base *base = event_base_new();
  evbase_player = base;
  int ready = base && output_raop.init() == 0;
  pthread_mutex_lock(&rt.lock);
  rt.base = ready ? base : NULL;
  rt.startup_result = ready ? 0 : -1;
  rt.startup_finished = true;
  pthread_cond_broadcast(&rt.idle);
  pthread_mutex_unlock(&rt.lock);
  if (!ready) { if (base) event_base_free(base); evbase_player = NULL; return NULL; }

  event_base_dispatch(rt.base);

  output_raop.deinit();
  event_base_free(rt.base);
  pthread_mutex_lock(&rt.lock);
  rt.base = NULL;
  pthread_mutex_unlock(&rt.lock);
  evbase_player = NULL;

  return NULL;
}

/* First handle: init threads/gcrypt and start the loop thread. */
static int
runtime_acquire(void)
{
  int ret = 0;

  pthread_mutex_lock(&rt.lock);
  /* Only the initializer owns startup publication/join. Other acquire calls
   * wait through failure cleanup instead of attempting duplicate joins. */
  while (rt.stopping || rt.starting) pthread_cond_wait(&rt.idle, &rt.lock);
  if (!rt.running)
    {
      const char *debug = getenv("MELOFON_RAOP_DEBUG");
      if (debug && (strcmp(debug, "1") == 0 || strcmp(debug, "true") == 0))
        helper_logger_set_severity(E_DBG);

      /* Application bootstrap precedes native playback threads. Pairing
       * rejects an unfinished libgcrypt even when AES playback succeeded.
       * Preserve an already-initialized in-process consumer and its secure
       * memory policy; do not reconfigure/deinitialize global crypto. */
      if (!gcry_check_version(GCRYPT_VERSION) ||
          (!gcry_control(GCRYCTL_INITIALIZATION_FINISHED_P) &&
           gcry_control(GCRYCTL_INITIALIZATION_FINISHED, 0) != 0))
        {
          helper_log_event(E_LOG, L_MAIN, "gcrypt_init_failed", NULL);
          pthread_mutex_unlock(&rt.lock);
          return -1;
        }
      if (evthread_use_pthreads() != 0)
        {
          helper_log_event(E_LOG, L_MAIN, "event_threads_failed", NULL);
          pthread_mutex_unlock(&rt.lock);
          return -1;
        }
      rt.starting = true;
      rt.startup_finished = false;
      if (pthread_create(&rt.thread, NULL, loop_main, NULL) != 0)
        {
          rt.starting = false;
          pthread_cond_broadcast(&rt.idle);
          pthread_mutex_unlock(&rt.lock);
          return -1;
        }
      rt.running = true;
      while (!rt.startup_finished) pthread_cond_wait(&rt.idle, &rt.lock);
      if (rt.startup_result < 0) {
        rt.stopping = true;
        pthread_mutex_unlock(&rt.lock);
        pthread_join(rt.thread, NULL);
        pthread_mutex_lock(&rt.lock);
        rt.running = false; rt.stopping = false; rt.starting = false;
        pthread_cond_broadcast(&rt.idle);
        pthread_mutex_unlock(&rt.lock);
        return -1;
      }
      rt.starting = false;
      pthread_cond_broadcast(&rt.idle);
    }
  rt.handles++;
  pthread_mutex_unlock(&rt.lock);
  return ret;
}

/* Last handle: stop the loop and join it. */
static void
runtime_release(void)
{
  pthread_mutex_lock(&rt.lock);
  if (--rt.handles > 0)
    {
      pthread_mutex_unlock(&rt.lock);
      return;
    }
  rt.stopping = true;
  if (rt.base) event_base_loopbreak(rt.base);
  pthread_mutex_unlock(&rt.lock);
  pthread_join(rt.thread, NULL);

  pthread_mutex_lock(&rt.lock);
  rt.running = false;
  rt.stopping = false;
  pthread_cond_broadcast(&rt.idle);
  pthread_mutex_unlock(&rt.lock);
}

/* -------------------------------------------------------------- public API */

static raop_t *
handle_new(struct raop_stream *stream)
{
  raop_t *h;

  h = calloc(1, sizeof(*h));
  if (!h)
    return NULL;

  pthread_mutex_init(&h->events_lock, NULL);
  pthread_mutex_init(&h->cmds_lock, NULL);
  pthread_mutex_init(&h->credential_lock, NULL);
  h->state = OUTPUT_STATE_STOPPED;
  h->session_revision = 1;

  if (runtime_acquire() < 0)
    {
      pthread_mutex_destroy(&h->events_lock);
      pthread_mutex_destroy(&h->cmds_lock);
      pthread_mutex_destroy(&h->credential_lock);
      free(h);
      return NULL;
    }

  h->stream = stream;
  h->player = stream ? stream->player : raop_player_new(rt.base, 1);
  if (!h->player)
    {
      runtime_release();
      pthread_mutex_destroy(&h->events_lock);
      pthread_mutex_destroy(&h->cmds_lock);
      pthread_mutex_destroy(&h->credential_lock);
      free(h);
      return NULL;
    }
  h->resume_event = event_new(rt.base, -1, 0, cmds_drain_cb, h);
  if (!h->resume_event) {
    if (!stream) raop_player_free(h->player);
    runtime_release();
    pthread_mutex_destroy(&h->events_lock); pthread_mutex_destroy(&h->cmds_lock);
    pthread_mutex_destroy(&h->credential_lock);
    free(h); return NULL;
  }

  pthread_mutex_lock(&rt.lock);
  if (rt.next_device_id == UINT64_MAX) {
    pthread_mutex_unlock(&rt.lock);
    if (!stream) raop_player_free(h->player);
    event_free(h->resume_event);
    runtime_release();
    pthread_mutex_destroy(&h->events_lock); pthread_mutex_destroy(&h->cmds_lock);
    pthread_mutex_destroy(&h->credential_lock); free(h); return NULL;
  }
  h->id = rt.next_device_id++;
  h->next = rt.handles_list;
  rt.handles_list = h;
  pthread_mutex_unlock(&rt.lock);

  return h;
}

raop_t *
raop_new(void)
{
  return handle_new(NULL);
}

static void stream_cancel_cb(evutil_socket_t fd, short what, void *arg);

raop_stream_t *
raop_stream_new(void)
{
  struct raop_stream *stream = calloc(1, sizeof(*stream));
  if (!stream) return NULL;
  if (runtime_acquire() < 0) { free(stream); return NULL; }
  pthread_mutex_lock(&rt.lock);
  if (rt.next_stream_id == UINT64_MAX) {
    pthread_mutex_unlock(&rt.lock); runtime_release(); free(stream); return NULL;
  }
  stream->id = rt.next_stream_id++;
  stream->epoch = 1;
  pthread_mutex_unlock(&rt.lock);
  stream->player = raop_player_new(rt.base, stream->id);
  if (!stream->player) { runtime_release(); free(stream); return NULL; }
  stream->cancel_event = event_new(rt.base, -1, 0, stream_cancel_cb, stream);
  if (!stream->cancel_event) {
    raop_player_free(stream->player); runtime_release(); free(stream); return NULL;
  }
  pthread_mutex_lock(&rt.lock);
  stream->next = rt.streams;
  rt.streams = stream;
  pthread_mutex_unlock(&rt.lock);
  return stream;
}

uint64_t
raop_stream_id(raop_stream_t *stream)
{
  return stream ? stream->id : 0;
}

uint64_t
raop_attachment_id(raop_t *h)
{
  return h ? h->id : 0;
}

raop_t *
raop_stream_attach(raop_stream_t *stream)
{
  if (!stream) return NULL;
  pthread_mutex_lock(&rt.lock);
  if (stream->closing || stream->input_closed || stream->attachments == UINT_MAX) {
    pthread_mutex_unlock(&rt.lock); return NULL;
  }
  stream->attachments++;
  pthread_mutex_unlock(&rt.lock);
  raop_t *h = handle_new(stream);
  if (!h) {
    pthread_mutex_lock(&rt.lock); stream->attachments--; pthread_mutex_unlock(&rt.lock);
  }
  return h;
}

int
raop_stream_write(raop_stream_t *stream, const uint8_t *pcm, size_t len)
{
  if (!stream || !pcm || len % 4) return -1;
  if (!len) return 0;
  pthread_mutex_lock(&rt.lock);
  int result = stream_claim_locked(stream, NULL);
  if (result == 0) result = stream->resetting ? 0 : raop_player_write(stream->player, pcm, len);
  pthread_mutex_unlock(&rt.lock);
  return result;
}

_Static_assert(sizeof(struct raop_append_result) == 40, "append receipt ABI");

uint64_t
raop_stream_epoch(raop_stream_t *stream)
{
  pthread_mutex_lock(&rt.lock);
  uint64_t epoch = stream ? stream->epoch : 0;
  pthread_mutex_unlock(&rt.lock);
  return epoch;
}

int
raop_stream_append(raop_stream_t *stream, uint64_t epoch, uint64_t segment,
                   const uint8_t *pcm, size_t len,
                   struct raop_append_result *result)
{
  if (!result) return -1;
  *result = (struct raop_append_result){
    .epoch = epoch, .segment = segment,
    .status = RAOP_APPEND_ERROR, .error = RAOP_APPEND_ERROR_INVALID,
  };
  if (!stream || !epoch || !segment || (!pcm && len) || len % 4) return 0;
  pthread_mutex_lock(&rt.lock);
  if (stream->closing || stream->input_closed) result->error = RAOP_APPEND_ERROR_CLOSING;
  else if (epoch != stream->epoch) {
    result->status = RAOP_APPEND_CANCELED;
    result->error = RAOP_APPEND_ERROR_NONE;
  } else if (stream->resetting) {
    result->status = RAOP_APPEND_NOT_READY;
    result->error = RAOP_APPEND_ERROR_NONE;
  } else if (!len) {
    result->status = RAOP_APPEND_ACCEPTED;
    result->error = RAOP_APPEND_ERROR_NONE;
  } else {
    int claim = stream_claim_locked(stream, NULL);
    if (claim < 0) result->error = RAOP_APPEND_ERROR_BUSY;
    else {
      int accepted = raop_player_append(stream->player, pcm, len);
      if (accepted < 0) result->error = accepted == -2
        ? RAOP_APPEND_ERROR_INVALID : RAOP_APPEND_ERROR_ALLOCATION;
      else {
        result->accepted_frames = (uint64_t)accepted / 4;
        result->status = (size_t)accepted == len
          ? RAOP_APPEND_ACCEPTED : RAOP_APPEND_BACKPRESSURE;
        result->error = RAOP_APPEND_ERROR_NONE;
      }
    }
  }
  pthread_mutex_unlock(&rt.lock);
  return 0;
}

_Static_assert(sizeof(struct raop_cancel_result) == 48, "cancel receipt ABI");
_Static_assert(sizeof(struct raop_source_append_result) == 64, "source append ABI");
_Static_assert(sizeof(struct raop_marker_result) == 48, "marker ABI");
_Static_assert(sizeof(struct raop_source_snapshot) == 56, "source snapshot ABI");
_Static_assert(sizeof(struct raop_range_snapshot) == 64, "range snapshot ABI");
_Static_assert(sizeof(struct raop_progress_snapshot) == 120, "progress snapshot ABI");
_Static_assert(sizeof(struct raop_completion_result) == 96, "completion ABI");
_Static_assert(sizeof(struct raop_completion_attachment) == 64, "completion attachment ABI");

static uint64_t
completion_now(void)
{
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (uint64_t)ts.tv_sec * 1000000000ULL + ts.tv_nsec;
}

static struct completion_receipt *
completion_find(raop_stream_t *s, uint64_t epoch, uint64_t source, uint64_t revision)
{
  for (struct completion_receipt *c = s->completions; c; c = c->next)
    if (c->result.epoch == epoch && c->result.source == source &&
        c->result.revision == revision) return c;
  return NULL;
}

/* Only loop-thread observations resolve successful boundaries. Pending reads
 * may coalesce; terminal values never change, even when a newer epoch starts. */
static void
completion_update_locked(raop_stream_t *s)
{
  for (struct completion_receipt *c = s->completions; c; c = c->next) {
    if (c->result.epoch != s->epoch || s->resetting) continue;
    bool terminal = c->result.status != 0;
    bool complete = c->result.required > 0 && c->result.target > 0;
    for (size_t i = 0; i < c->result.attachments; i++) {
      struct raop_completion_attachment *a = terminal
        ? &c->observed[i] : &c->attachment[i];
      if (a->excluded) continue;
      if (!a->outcome) {
        struct raop_progress_snapshot p;
        uint64_t end = 0;
        int fed = raop_player_completion_progress(s->player, c->result.source,
          a->attachment, &p, &end);
        a->coverage_start = p.coverage_start;
        a->submitted_frames = p.submitted_frames;
        a->scheduled_frames = p.scheduled_frames;
        if (fed) {
          c->observed_transport_end = end;
          if (!terminal) c->result.transport_end = end;
        }
        if (fed && p.participants && p.status == 1 &&
            p.source_frames == c->result.target && p.scheduled_frames >= end &&
            p.submitted_frames >= end) a->outcome = 1;
        else if (fed && p.participants && p.status == 1 &&
                 p.scheduled_frames >= end && p.source_frames < c->result.target) {
          /* A late join's suffix can never become full-source coverage, even
           * after its clock passes the end. Resolve the impossible barrier. */
          a->outcome = 3; a->error = RAOP_PROGRESS_TRANSPORT;
        }
      }
      if (a->outcome != 1) complete = false;
      if (!terminal && (a->outcome == 2 || a->outcome == 3)) {
        c->result.status = 3; c->result.error = a->error;
        c->result.captured_ns = completion_now();
      }
      c->observed[i] = *a;
    }
    if (!terminal && complete) {
      c->result.status = 1;
      c->result.captured_ns = completion_now();
    }
  }
}

void
raop_ffi_completion_update(uint64_t stream_id)
{
  pthread_mutex_lock(&rt.lock);
  for (raop_stream_t *s = rt.streams; s; s = s->next) if (s->id == stream_id) {
    completion_update_locked(s);
    /* Completion is not receiver release. Stop only the ended stream's pacer,
     * after actual surviving transport playout, not receipt settlement/ack. */
    raop_player_drain_complete(s->player);
    break;
  }
  pthread_mutex_unlock(&rt.lock);
}

static void
completion_settle_locked(raop_stream_t *s, uint64_t attachment, uint64_t outcome, uint64_t error)
{
  for (struct completion_receipt *c = s->completions; c; c = c->next) {
    if (c->result.epoch != s->epoch) continue;
    bool affected = false;
    for (size_t i = 0; i < c->result.attachments; i++) {
      struct raop_completion_attachment *a = &c->observed[i];
      if (a->excluded || (attachment && a->attachment != attachment)) continue;
      /* A per-attachment completion already observed at its boundary survives
       * that peer's later loss while another peer is still draining. */
      if (a->outcome) continue;
      a->outcome = outcome; a->error = error; affected = true;
      if (!c->result.status) c->attachment[i] = *a;
    }
    if (affected && !c->result.status) {
      c->result.status = outcome == 4 ? 2 : 3;
      c->result.error = error;
      c->result.captured_ns = completion_now();
    }
  }
}

static void
completion_withdraw_locked(raop_t *h)
{
  if (!h->stream) return;
  completion_update_locked(h->stream);
  completion_settle_locked(h->stream, h->id, 2, RAOP_PROGRESS_TRANSPORT);
  if (h->session_revision < UINT64_MAX) h->session_revision++;
}

static struct completion_receipt *
completion_prepare_locked(raop_stream_t *s, uint64_t epoch, uint64_t source,
  uint64_t target, struct raop_marker_result *result)
{
  if (s->completion_count == COMPLETION_CAP) {
    result->status = RAOP_APPEND_BACKPRESSURE; result->error = RAOP_APPEND_ERROR_NONE;
    return NULL;
  }
  size_t count = 0;
  /* Both passes use only rt.lock-owned membership facts. free_requested belongs
   * to cmds_lock and may change between sizing and copying; a queued FREE is
   * instead observed by the loop as an explicit captured-session withdrawal. */
  for (raop_t *h = rt.handles_list; h; h = h->next)
    if (h->stream == s && !h->quiescing && !h->probe_only) count++;
  struct completion_receipt *c = calloc(1, sizeof(*c));
  if (c) c->attachment = calloc(count ? count * 2 : 1, sizeof(*c->attachment));
  if (!c || !c->attachment) {
    if (c) free(c);
    result->error = RAOP_APPEND_ERROR_ALLOCATION;
    return NULL;
  }
  c->result = (struct raop_completion_result){ .stream = s->id, .epoch = epoch,
    .source = source, .target = target, .revision = 1, .attachments = count, .required = count };
  c->observed = c->attachment + count;
  size_t i = 0;
  for (raop_t *h = rt.handles_list; h; h = h->next)
    if (h->stream == s && !h->quiescing && !h->probe_only)
      c->attachment[i++] = (struct raop_completion_attachment){
        .attachment = h->id, .session = h->session_revision,
        .outcome = h->failure_epoch == epoch ? 3 : 0,
        .error = h->failure_epoch == epoch ? h->session_error : 0 };
  memcpy(c->observed, c->attachment, count * sizeof(*c->attachment));
  return c;
}

/* rt.lock is the admission linearization point for PCM, seals, end and cancel.
 * The pacer owns dispatch, under its inner lock, and never calls the backend
 * while holding it. No JS queue or decoder EOF can overtake admitted PCM. */
static bool
timeline_admit_locked(raop_stream_t *stream, uint64_t epoch, uint64_t *status, uint64_t *error)
{
  if (stream->closing || stream->input_closed) *error = RAOP_APPEND_ERROR_CLOSING;
  else if (epoch != stream->epoch) {
    *status = RAOP_APPEND_CANCELED; *error = RAOP_APPEND_ERROR_NONE;
  } else if (stream->resetting) {
    *status = RAOP_APPEND_NOT_READY; *error = RAOP_APPEND_ERROR_NONE;
  } else return true;
  return false;
}

int
raop_stream_append_source(raop_stream_t *stream, uint64_t epoch, uint64_t source,
                          uint64_t segment, const uint8_t *pcm, size_t len,
                          struct raop_source_append_result *result)
{
  if (!result) return -1;
  *result = (struct raop_source_append_result){ .epoch = epoch, .source = source,
    .segment = segment, .status = RAOP_APPEND_ERROR, .error = RAOP_APPEND_ERROR_INVALID };
  if (!stream || !epoch || !source || !segment || (!pcm && len) || len % 4) return 0;
  pthread_mutex_lock(&rt.lock);
  if (timeline_admit_locked(stream, epoch, &result->status, &result->error)) {
    if (rt.active_stream_id && rt.active_stream_id != stream->id)
      result->error = RAOP_APPEND_ERROR_BUSY;
    else {
      struct raop_source_snapshot existing;
      bool found = raop_player_source(stream->player, source, &existing);
      if (!found && stream->completion_count == COMPLETION_CAP) {
        result->status = RAOP_APPEND_BACKPRESSURE; result->error = RAOP_APPEND_ERROR_NONE;
      } else {
        raop_player_append_source(stream->player, source, segment, pcm, len, result);
        if (!found && result->status == RAOP_APPEND_ACCEPTED)
          stream->marker_reserved = true;
        if (!found && result->accepted_frames) stream->marker_reserved = true;
      }
      if (result->accepted_frames) stream_claim_locked(stream, NULL);
    }
  }
  pthread_mutex_unlock(&rt.lock);
  return 0;
}

static int
stream_marker(raop_stream_t *stream, uint64_t epoch, uint64_t source, uint64_t target,
               bool end, struct raop_marker_result *result)
{
  if (!result) return -1;
  *result = (struct raop_marker_result){ .epoch = epoch, .source = source,
    .target = target, .status = RAOP_APPEND_ERROR, .error = RAOP_APPEND_ERROR_INVALID };
  if (!stream || !epoch || (!end && !source)) return 0;
  pthread_mutex_lock(&rt.lock);
  if (timeline_admit_locked(stream, epoch, &result->status, &result->error)) {
    if (end) raop_player_end(stream->player, target, result);
    else {
      struct completion_receipt *old = stream->completions;
      while (old && (old->result.epoch != epoch || old->result.source != source)) old = old->next;
      if (old) raop_player_seal(stream->player, source, target, result);
      else {
        struct completion_receipt *c = completion_prepare_locked(stream, epoch, source, target, result);
        if (c) {
          raop_player_seal(stream->player, source, target, result);
          if (result->status == RAOP_APPEND_ACCEPTED) {
            c->result.input_end = result->input_end;
            struct raop_progress_snapshot failure;
            raop_player_failure(stream->player, &failure);
            if (!c->result.required || !target || failure.error) {
              c->result.status = 3;
              c->result.error = failure.error ? failure.error : RAOP_PROGRESS_TRANSPORT;
              c->result.captured_ns = completion_now();
              for (size_t i = 0; i < c->result.attachments; i++) {
                c->attachment[i].outcome = 3;
                c->attachment[i].error = c->result.error;
              }
            }
            memcpy(c->observed, c->attachment, c->result.attachments * sizeof(*c->attachment));
            c->next = stream->completions; stream->completions = c;
            stream->completion_count++;
            stream->marker_reserved = false;
          } else { free(c->attachment); free(c); }
        }
      }
    }
  }
  pthread_mutex_unlock(&rt.lock);
  return 0;
}

int
raop_stream_seal(raop_stream_t *stream, uint64_t epoch, uint64_t source, uint64_t target,
                 struct raop_marker_result *result)
{
  return stream_marker(stream, epoch, source, target, false, result);
}

int
raop_stream_end(raop_stream_t *stream, uint64_t epoch, uint64_t target,
                struct raop_marker_result *result)
{
  return stream_marker(stream, epoch, 0, target, true, result);
}

int
raop_stream_source(raop_stream_t *stream, uint64_t epoch, uint64_t source,
                   struct raop_source_snapshot *result)
{
  if (!stream || !result || !source) return -1;
  pthread_mutex_lock(&rt.lock);
  int found = epoch == stream->epoch && !stream->resetting
    ? raop_player_source(stream->player, source, result) : 0;
  if (found) result->epoch = epoch;
  pthread_mutex_unlock(&rt.lock);
  return found;
}

int
raop_stream_range(raop_stream_t *stream, uint64_t epoch, uint64_t index,
                  struct raop_range_snapshot *result)
{
  if (!stream || !result) return -1;
  pthread_mutex_lock(&rt.lock);
  int found = epoch == stream->epoch && !stream->resetting
    ? raop_player_range(stream->player, index, result) : 0;
  if (found) result->epoch = epoch;
  pthread_mutex_unlock(&rt.lock);
  return found;
}

struct progress_work {
  raop_stream_t *stream;
  uint64_t epoch, source, attachment;
  struct raop_progress_snapshot *result;
  struct raop_completion_result *completion;
  uint64_t revision;
  free_sync sync;
  int found;
};

static void
stream_progress_cb(evutil_socket_t fd, short what, void *arg)
{
  (void)fd; (void)what;
  struct progress_work *work = arg;
  pthread_mutex_lock(&rt.lock);
  raop_stream_t *s = work->stream;
  if (work->completion && !s->closing) {
    completion_update_locked(s);
    struct completion_receipt *c = completion_find(s, work->epoch, work->source, work->revision);
    if (c) { *work->completion = c->result; work->found = 1; }
  } else if (!s->closing && !s->resetting && s->epoch == work->epoch) {
    work->found = raop_player_progress(s->player, work->source, work->attachment, work->result);
    work->result->epoch = work->epoch;
  }
  s->readers--;
  pthread_mutex_unlock(&rt.lock);
  pthread_mutex_lock(&work->sync.lock);
  work->sync.done = 1;
  pthread_cond_signal(&work->sync.cond);
  pthread_mutex_unlock(&work->sync.lock);
}

int
raop_stream_progress(raop_stream_t *stream, uint64_t epoch, uint64_t source,
                      uint64_t attachment, struct raop_progress_snapshot *result)
{
  if (!stream || !result || !epoch) return -1;
  struct progress_work work = { .stream = stream, .epoch = epoch,
    .source = source, .attachment = attachment, .result = result,
    .sync = { .lock = PTHREAD_MUTEX_INITIALIZER, .cond = PTHREAD_COND_INITIALIZER } };
  struct timeval zero = { 0, 0 };
  pthread_mutex_lock(&work.sync.lock);
  pthread_mutex_lock(&rt.lock);
  int rc = -1;
  if (!stream->closing) {
    stream->readers++;
    rc = event_base_once(rt.base, -1, EV_TIMEOUT, stream_progress_cb, &work, &zero);
    if (rc < 0) stream->readers--;
  }
  pthread_mutex_unlock(&rt.lock);
  if (rc == 0) while (!work.sync.done) pthread_cond_wait(&work.sync.cond, &work.sync.lock);
  pthread_mutex_unlock(&work.sync.lock);
  pthread_cond_destroy(&work.sync.cond);
  pthread_mutex_destroy(&work.sync.lock);
  return rc < 0 ? -1 : work.found;
}

int
raop_stream_completion_poll(raop_stream_t *s, uint64_t epoch, uint64_t source,
  uint64_t revision, struct raop_completion_result *result)
{
  if (!s || !epoch || !source || !revision || !result) return -1;
  struct progress_work work = { .stream = s, .epoch = epoch, .source = source,
    .revision = revision, .completion = result,
    .sync = { .lock = PTHREAD_MUTEX_INITIALIZER, .cond = PTHREAD_COND_INITIALIZER } };
  struct timeval zero = { 0, 0 };
  pthread_mutex_lock(&work.sync.lock);
  pthread_mutex_lock(&rt.lock);
  int rc = -1;
  if (!s->closing) {
    s->readers++;
    rc = event_base_once(rt.base, -1, EV_TIMEOUT, stream_progress_cb, &work, &zero);
    if (rc < 0) s->readers--;
  }
  pthread_mutex_unlock(&rt.lock);
  if (!rc) while (!work.sync.done) pthread_cond_wait(&work.sync.cond, &work.sync.lock);
  pthread_mutex_unlock(&work.sync.lock);
  pthread_cond_destroy(&work.sync.cond); pthread_mutex_destroy(&work.sync.lock);
  return rc < 0 ? -1 : work.found;
}

int
raop_stream_completion_attachment(raop_stream_t *s, uint64_t epoch, uint64_t source,
  uint64_t revision, uint64_t index, struct raop_completion_attachment *result)
{
  if (!s || !result) return -1;
  pthread_mutex_lock(&rt.lock);
  struct completion_receipt *c = completion_find(s, epoch, source, revision);
  int found = c && index < c->result.attachments;
  if (found) *result = c->attachment[index];
  pthread_mutex_unlock(&rt.lock);
  return found;
}

int
raop_stream_completion_revise(raop_stream_t *s, uint64_t epoch, uint64_t source,
  uint64_t target, uint64_t revision, const uint64_t *exclude, size_t count)
{
  if (!s || !count || !exclude || revision == UINT64_MAX) return -1;
  int rc = -1;
  pthread_mutex_lock(&rt.lock);
  struct completion_receipt *old = completion_find(s, epoch, source, revision);
  if (s->closing || s->input_closed || s->resetting || s->epoch != epoch || !old ||
      old->result.target != target || old->result.status != 3 ||
      s->completion_count + s->marker_reserved == COMPLETION_CAP ||
      completion_find(s, epoch, source, revision + 1)) goto out;
  for (size_t i = 0; i < count; i++) {
    bool found = false;
    for (size_t j = 0; j < old->result.attachments; j++) {
      struct raop_completion_attachment *a = &old->observed[j];
      if (a->attachment == exclude[i] && !a->excluded &&
          (a->outcome == 2 || a->outcome == 3)) found = true;
    }
    for (size_t j = 0; j < i; j++) if (exclude[j] == exclude[i]) found = false;
    if (!found) goto out;
  }
  struct completion_receipt *c = calloc(1, sizeof(*c));
  if (!c) goto out;
  c->attachment = malloc(old->result.attachments * 2 * sizeof(*c->attachment));
  if (!c->attachment) { free(c); goto out; }
  memcpy(c->attachment, old->observed, old->result.attachments * sizeof(*c->attachment));
  c->observed = c->attachment + old->result.attachments;
  c->result = old->result; c->result.revision++; c->result.status = c->result.error = 0;
  c->observed_transport_end = c->result.transport_end = old->observed_transport_end;
  c->result.captured_ns = 0;
  struct raop_progress_snapshot epoch_progress;
  /* Stored epoch failures are safe to read here under pcm_lock. Its presence
   * means the pacer cannot supply a missing suffix; only already submitted
   * healthy full-source coverage may still reach its presentation boundary. */
  raop_player_failure(s->player, &epoch_progress);
  for (size_t i = 0; i < c->result.attachments; i++) {
    struct raop_completion_attachment *a = &c->attachment[i];
    for (size_t j = 0; j < count; j++) if (a->attachment == exclude[j]) {
      a->excluded = 1; c->result.required--;
    }
    if (!a->excluded && !a->outcome && epoch_progress.error &&
        (!c->result.transport_end || a->submitted_frames < c->result.transport_end)) {
      a->outcome = 3; a->error = epoch_progress.error;
    }
    if (!a->excluded && (a->outcome == 2 || a->outcome == 3)) {
      c->result.status = 3; c->result.error = a->error;
    }
  }
  if (!c->result.required) { c->result.status = 3; c->result.error = RAOP_PROGRESS_TRANSPORT; }
  memcpy(c->observed, c->attachment, c->result.attachments * sizeof(*c->attachment));
  if (c->result.status) c->result.captured_ns = completion_now();
  c->next = s->completions; s->completions = c; s->completion_count++;
  rc = 0;
out:
  pthread_mutex_unlock(&rt.lock);
  return rc;
}

int
raop_stream_completion_ack(raop_stream_t *s, uint64_t epoch, uint64_t source,
  uint64_t target, uint64_t revision)
{
  if (!s) return -1;
  int rc = -1;
  pthread_mutex_lock(&rt.lock);
  for (struct completion_receipt **slot = &s->completions; *slot; slot = &(*slot)->next) {
    struct completion_receipt *c = *slot;
    if (c->result.epoch != epoch || c->result.source != source || c->result.revision != revision) continue;
    if (c->result.target != target || !c->result.status) break;
    *slot = c->next; free(c->attachment); free(c); s->completion_count--;
    bool retained = false;
    for (c = s->completions; c; c = c->next)
      if (c->result.epoch == epoch && c->result.source == source) retained = true;
    if (!retained && epoch == s->epoch) raop_player_ack_source(s->player, source);
    rc = 0; break;
  }
  pthread_mutex_unlock(&rt.lock);
  return rc;
}

/* Loop thread only, before a failing session is retired. Failure is an epoch
 * fact retained by the stream, not a lossy device state-ring notification. */
void
raop_ffi_progress_failed(uint64_t stream_id, uint64_t error)
{
  pthread_mutex_lock(&rt.lock);
  for (struct raop_stream *s = rt.streams; s; s = s->next)
    if (s->id == stream_id && !s->canceling && !s->closing) {
      completion_update_locked(s);
      completion_settle_locked(s, 0, 3, error);
      raop_player_failed(s->player, error);
      break;
    }
  pthread_mutex_unlock(&rt.lock);
}

void
raop_ffi_attachment_failed(uint64_t stream_id, uint64_t attachment, uint64_t error)
{
  pthread_mutex_lock(&rt.lock);
  for (raop_stream_t *s = rt.streams; s; s = s->next)
    if (s->id == stream_id && !s->canceling && !s->closing) {
      completion_update_locked(s);
      completion_settle_locked(s, attachment, 3, error);
      bool viable = false;
      for (raop_t *h = rt.handles_list; h; h = h->next) {
        if (h->stream != s || h->quiescing || h->probe_only) continue;
        if (h->id == attachment) {
          if (h->failure_epoch != s->epoch) { h->failure_epoch = s->epoch; h->session_error = error; }
        }
        else if (h->failure_epoch != s->epoch) viable = true;
      }
      /* A failed join/start or receiver is not a pacer failure. Freeze shared
       * diagnostics only when no attachment can continue this epoch. */
      if (!viable) raop_player_failed(s->player, error);
      break;
    }
  pthread_mutex_unlock(&rt.lock);
}

int
raop_ffi_stream_fenced(uint64_t stream_id)
{
  int fenced = 0;
  pthread_mutex_lock(&rt.lock);
  for (struct raop_stream *s = rt.streams; s; s = s->next)
    if (s->id == stream_id) { fenced = s->canceling || s->closing || s->input_closed; break; }
  pthread_mutex_unlock(&rt.lock);
  return fenced;
}

void
raop_ffi_cancel_changed(uint64_t stream_id)
{
  pthread_mutex_lock(&rt.lock);
  for (struct raop_stream *s = rt.streams; s; s = s->next)
    if (s->id == stream_id && s->canceling && !s->closing) {
      event_active(s->cancel_event, EV_TIMEOUT, 1);
      break;
    }
  pthread_mutex_unlock(&rt.lock);
}

static void
stream_cancel_cb(evutil_socket_t fd, short what, void *arg)
{
  struct raop_stream *stream = arg;
  (void)fd; (void)what;
  for (;;) {
    pthread_mutex_lock(&rt.lock);
    struct cancel_receipt *c = stream->cancels;
    while (c && c->applied) c = c->next;
    pthread_mutex_unlock(&rt.lock);
    if (!c) break;
    raop_player_session_stopped(stream->player);
    raop_player_flush(stream->player);
    uint64_t cutoff = raop_cancel_stream(stream->id, c->result.admitted_ns,
                                        c->retire_ids, c->retire_count);
    bool failed = false;
    for (size_t i = 0; i < c->retire_count; i++) {
      raop_t *h;
      /* Loop-owned handle lifetime; lookup by captured identity, never a pointer
       * retained from admission. A missing handle already proved destruction. */
      for (h = rt.handles_list; h && h->id != c->retire_ids[i]; h = h->next) {}
      if (!h) continue;
      pthread_mutex_lock(&rt.lock);
      h->quiescing = true;
      h->ready = false;
      stream_readiness_locked(h);
      pthread_mutex_unlock(&rt.lock);
      cmd *command = c->retire_commands[i];
      c->retire_commands[i] = NULL;
      if (cmd_push(h, command) < 0) {
        /* A concurrent close may have already admitted FREE (and its owned
         * destruction). It is the same readiness proof, not failed retirement. */
        pthread_mutex_lock(&h->cmds_lock);
        if (!h->free_requested) failed = true;
        pthread_mutex_unlock(&h->cmds_lock);
      }
    }
    pthread_mutex_lock(&rt.lock);
    c->result.cutoff_frames = cutoff;
    c->result.local_reset = 1;
    if (failed && !c->result.status) c->result.status = 3;
    c->applied = true;
    pthread_mutex_unlock(&rt.lock);
  }
  if (raop_cancel_pending(stream->id)) return;
  pthread_mutex_lock(&rt.lock);
  bool all_applied = true;
  for (struct cancel_receipt *c = stream->cancels; c; c = c->next)
    if (!c->applied) all_applied = false;
  bool failed = false;
  for (struct cancel_receipt *c = stream->cancels; c; c = c->next)
    if (c->result.status == 3) failed = true;
  if (all_applied && !failed && stream->canceling && !stream->closing && !stream->input_closed) {
    for (struct cancel_receipt *c = stream->cancels; c; c = c->next)
      if (!c->result.status) c->result.status = 1;
    stream->canceling = stream->resetting = false;
    raop_player_fence(stream->player, false);
    for (raop_t *h = rt.handles_list; h; h = h->next)
      if (h->stream == stream && h->ready) {
        raop_player_session_started(stream->player);
        break;
      }
  }
  pthread_mutex_unlock(&rt.lock);
}

int
raop_stream_cancel(raop_stream_t *stream, uint64_t epoch)
{
  return raop_stream_cancel_v2(stream, epoch, NULL, 0);
}

int
raop_stream_cancel_v2(raop_stream_t *stream, uint64_t epoch,
                      const uint64_t *retire_ids, size_t retire_count)
{
  if (!stream || !epoch || (retire_count && !retire_ids) ||
      retire_count > SIZE_MAX / sizeof(uint64_t) ||
      retire_count > SIZE_MAX / sizeof(cmd *)) return -1;
  struct cancel_receipt *receipt = calloc(1, sizeof(*receipt));
  if (!receipt) return -1;
  if (retire_count) {
    receipt->retire_ids = malloc(retire_count * sizeof(uint64_t));
    receipt->retire_commands = calloc(retire_count, sizeof(cmd *));
    if (!receipt->retire_ids || !receipt->retire_commands) {
      cancel_receipt_free(receipt); return -1;
    }
    receipt->retire_count = retire_count;
    memcpy(receipt->retire_ids, retire_ids, retire_count * sizeof(uint64_t));
    for (size_t i = 0; i < retire_count; i++) {
      receipt->retire_commands[i] = calloc(1, sizeof(cmd));
      if (!receipt->retire_commands[i]) { cancel_receipt_free(receipt); return -1; }
      receipt->retire_commands[i]->type = CMD_TEARDOWN;
    }
  }
  pthread_mutex_lock(&rt.lock);
  if (stream->closing || stream->input_closed || epoch != stream->epoch || epoch == UINT64_MAX ||
      (stream->resetting && !stream->canceling)) {
    pthread_mutex_unlock(&rt.lock); cancel_receipt_free(receipt); return -1;
  }
  for (size_t i = 0; i < retire_count; i++) {
    raop_t *h;
    for (h = rt.handles_list; h && h->id != retire_ids[i]; h = h->next) {}
    bool duplicate = false;
    for (size_t j = 0; j < i; j++) if (retire_ids[j] == retire_ids[i]) duplicate = true;
    if (!h || h->stream != stream || duplicate) {
      pthread_mutex_unlock(&rt.lock); cancel_receipt_free(receipt); return -1;
    }
  }
  struct timespec now;
  clock_gettime(CLOCK_MONOTONIC, &now);
  receipt->result = (struct raop_cancel_result){
    .epoch = epoch, .next_epoch = epoch + 1,
    .admitted_ns = (uint64_t)now.tv_sec * 1000000000ULL + now.tv_nsec,
  };
  struct cancel_receipt **tail = &stream->cancels;
  for (; *tail; tail = &(*tail)->next)
    if (!(*tail)->result.status) (*tail)->result.status = 2;
  *tail = receipt;
  completion_settle_locked(stream, 0, 4, RAOP_PROGRESS_OK);
  stream->epoch++;
  stream->marker_reserved = false;
  stream->resetting = stream->canceling = true;
  raop_player_fence(stream->player, true);
  event_active(stream->cancel_event, EV_TIMEOUT, 1);
  pthread_mutex_unlock(&rt.lock);
  return 0;
}

int
raop_stream_cancel_poll(raop_stream_t *stream, uint64_t epoch,
                        struct raop_cancel_result *result)
{
  if (!stream || !result) return -1;
  int found = 0;
  pthread_mutex_lock(&rt.lock);
  for (struct cancel_receipt *c = stream->cancels; c; c = c->next)
    if (c->result.epoch == epoch) {
      *result = c->result;
      if (!c->applied) result->status = 0;
      found = 1; break;
    }
  pthread_mutex_unlock(&rt.lock);
  return found;
}

int
raop_stream_cancel_ack(raop_stream_t *stream, uint64_t epoch)
{
  if (!stream) return -1;
  int result = -1;
  pthread_mutex_lock(&rt.lock);
  for (struct cancel_receipt **c = &stream->cancels; *c; c = &(*c)->next)
    if ((*c)->result.epoch == epoch) {
      if ((*c)->applied && (*c)->result.status) {
        struct cancel_receipt *old = *c;
       *c = old->next; cancel_receipt_free(old); result = 0;
      }
      break;
    }
  pthread_mutex_unlock(&rt.lock);
  return result;
}

struct stream_free_work { struct raop_stream *stream; free_sync *sync; };

int
raop_stream_close_input(raop_stream_t *stream)
{
  if (!stream) return -1;
  pthread_mutex_lock(&rt.lock);
  stream->input_closed = true;
  raop_player_fence(stream->player, true);
  completion_settle_locked(stream, 0, 4, RAOP_PROGRESS_OK);
  pthread_mutex_unlock(&rt.lock);
  return 0;
}

static void
stream_reset_cb(evutil_socket_t fd, short what, void *arg)
{
  struct stream_free_work *work = arg;
  struct raop_stream *stream = work->stream;
  (void)fd; (void)what;
  raop_player_session_stopped(stream->player);
  raop_player_flush(stream->player);
  raop_discard_pending_input(stream->id);
  raop_reanchor_stream(stream->id);
  pthread_mutex_lock(&rt.lock);
  stream->resetting = false;
  for (raop_t *h = rt.handles_list; h; h = h->next)
    if (h->stream == stream && h->ready) {
      raop_player_session_started(stream->player);
      break;
    }
  pthread_mutex_unlock(&rt.lock);
  pthread_mutex_lock(&work->sync->lock);
  work->sync->done = 1;
  pthread_cond_signal(&work->sync->cond);
  pthread_mutex_unlock(&work->sync->lock);
}

int
raop_stream_reset(raop_stream_t *stream)
{
  if (!stream) return -1;
  pthread_mutex_lock(&rt.lock);
  /* The legacy local reset has no epoch advance or retained outcome. It cannot
   * erase timeline identities/targets within an epoch: use ordered cancel. */
  /* Cleanup already admitted by the typed owner may reach this port after
   * close_input fences producers. input_closed is permanent, so this reset
   * cannot reopen admission; C1 still joins it before the eventual free. */
  bool unavailable = stream->closing || stream->resetting ||
    raop_player_timeline_active(stream->player);
  if (!unavailable) stream->resetting = true;
  pthread_mutex_unlock(&rt.lock);
  if (unavailable) return -1;
  free_sync sync = { .lock = PTHREAD_MUTEX_INITIALIZER, .cond = PTHREAD_COND_INITIALIZER };
  struct stream_free_work work = { stream, &sync };
  struct timeval zero = { 0, 0 };
  pthread_mutex_lock(&sync.lock);
  int result = event_base_once(rt.base, -1, EV_TIMEOUT, stream_reset_cb, &work, &zero);
  if (result == 0)
    while (!sync.done) pthread_cond_wait(&sync.cond, &sync.lock);
  pthread_mutex_unlock(&sync.lock);
  pthread_cond_destroy(&sync.cond); pthread_mutex_destroy(&sync.lock);
  if (result < 0) {
    pthread_mutex_lock(&rt.lock);
    stream->resetting = false;
    pthread_mutex_unlock(&rt.lock);
  }
  return result < 0 ? -1 : 0;
}

static void
stream_free_cb(evutil_socket_t fd, short what, void *arg)
{
  struct stream_free_work *work = arg;
  struct raop_stream *stream = work->stream;
  (void)fd; (void)what;
  raop_player_session_stopped(stream->player);
  pthread_mutex_lock(&rt.lock);
  completion_settle_locked(stream, 0, 4, RAOP_PROGRESS_OK);
  pthread_mutex_unlock(&rt.lock);
  raop_player_free(stream->player);
  event_free(stream->cancel_event);
  pthread_mutex_lock(&rt.lock);
  struct raop_stream **slot = &rt.streams;
  while (*slot != stream) slot = &(*slot)->next;
  *slot = stream->next;
  while (stream->cancels) {
    struct cancel_receipt *c = stream->cancels;
    stream->cancels = c->next;
    cancel_receipt_free(c);
  }
  while (stream->completions) {
    struct completion_receipt *c = stream->completions;
    stream->completions = c->next;
    free(c->attachment); free(c);
  }
  if (stream->active) rt.active_stream_id = 0;
  pthread_mutex_unlock(&rt.lock);
  free(stream);
  pthread_mutex_lock(&work->sync->lock);
  work->sync->done = 1;
  pthread_cond_signal(&work->sync->cond);
  pthread_mutex_unlock(&work->sync->lock);
}

int
raop_stream_free(raop_stream_t *stream)
{
  if (!stream) return -1;
  pthread_mutex_lock(&rt.lock);
  if (stream->closing || stream->attachments || stream->readers) {
    int result = stream->attachments || stream->readers ? -2 : -1;
    pthread_mutex_unlock(&rt.lock); return result;
  }
  stream->closing = true;
  pthread_mutex_unlock(&rt.lock);
  free_sync sync = { .lock = PTHREAD_MUTEX_INITIALIZER, .cond = PTHREAD_COND_INITIALIZER };
  struct stream_free_work work = { stream, &sync };
  struct timeval zero = { 0, 0 };
  pthread_mutex_lock(&sync.lock);
  int result = event_base_once(rt.base, -1, EV_TIMEOUT, stream_free_cb, &work, &zero);
  if (result == 0) {
    while (!sync.done) pthread_cond_wait(&sync.cond, &sync.lock);
  } else {
    pthread_mutex_lock(&rt.lock); stream->closing = false; pthread_mutex_unlock(&rt.lock);
  }
  pthread_mutex_unlock(&sync.lock);
  pthread_cond_destroy(&sync.cond); pthread_mutex_destroy(&sync.lock);
  if (result == 0) runtime_release();
  return result < 0 ? -1 : 0;
}

int
raop_start(raop_t *h, const char *host, int port, const char *name, int volume,
           int devtype, int encrypt, uint32_t pos_ms, uint32_t len_ms,
           uint16_t wanted_metadata, int authsetup, int requires_auth,
           const char *title, const char *artist)
{
  return raop_start_v2(h, host, port, name, volume, devtype, encrypt,
                       pos_ms, len_ms, wanted_metadata, authsetup, requires_auth,
                       title, artist, 0, NULL, 0, NULL, 0);
}

static int
raop_open(raop_t *h, const char *host, int port, const char *name, int volume,
              int devtype, int encrypt, uint32_t pos_ms, uint32_t len_ms,
              uint16_t wanted_metadata, int authsetup, int requires_auth,
              const char *title, const char *artist, int has_password,
              const uint8_t *password, size_t password_len,
              const uint8_t *auth_key, size_t auth_key_len, int probe)
{
  cmd *c;

  if (!h || !host || !*host)
    return -1;
  if ((!password && password_len) || password_len > 4096 ||
      (password && memchr(password, 0, password_len)) ||
      (!auth_key && auth_key_len) || (auth_key && auth_key_len != 128))
    return -1;
  for (size_t i = 0; i < auth_key_len; i++)
    if (!((auth_key[i] >= '0' && auth_key[i] <= '9') ||
          (auth_key[i] >= 'a' && auth_key[i] <= 'f') ||
          (auth_key[i] >= 'A' && auth_key[i] <= 'F')))
      return -1;
  if (port <= 0 || port > 65535)
    port = 7000;
  if (!name || !*name)
    name = host;

  c = calloc(1, sizeof(*c));
  if (!c)
    return -1;
  c->type = CMD_START;
  c->probe = probe;
  c->has_password = has_password ? 1 : 0;
  if (password) {
    c->password = calloc(password_len + 1, 1);
    if (!c->password) { cmd_free(c); return -1; }
    memcpy(c->password, password, password_len);
  }
  if (auth_key) {
    c->auth_key = calloc(auth_key_len + 1, 1);
    if (!c->auth_key) { cmd_free(c); return -1; }
    memcpy(c->auth_key, auth_key, auth_key_len);
  }
  snprintf(c->host, sizeof(c->host), "%s", host);
  c->port = port;
  snprintf(c->name, sizeof(c->name), "%s", name);
  c->volume = volume < 0 ? 0 : (volume > 100 ? 100 : volume);
  c->devtype = devtype < 0 || devtype > 6 ? RDEV_APPLETV : devtype;
  c->encrypt = encrypt ? 1 : 0;
  c->pos_ms = pos_ms;
  c->len_ms = len_ms;
  c->wanted_metadata = wanted_metadata;
  c->authsetup = authsetup ? 1 : 0;
  c->requires_auth = requires_auth ? 1 : 0;
  if (title)
    snprintf(c->title, sizeof(c->title), "%s", title);
  if (artist)
    snprintf(c->artist, sizeof(c->artist), "%s", artist);

  pthread_mutex_lock(&rt.lock);
  int claimed = stream_claim_locked(h->stream, h);
  if (h->stream) c->epoch = h->stream->epoch;
  pthread_mutex_unlock(&rt.lock);
  if (claimed < 0) { cmd_free(c); return claimed; }
  return cmd_push(h, c);
}

int
raop_start_v2(raop_t *h, const char *host, int port, const char *name, int volume,
              int devtype, int encrypt, uint32_t pos_ms, uint32_t len_ms,
              uint16_t wanted_metadata, int authsetup, int requires_auth,
              const char *title, const char *artist, int has_password,
              const uint8_t *password, size_t password_len,
              const uint8_t *auth_key, size_t auth_key_len)
{
  return raop_open(h, host, port, name, volume, devtype, encrypt, pos_ms, len_ms,
                   wanted_metadata, authsetup, requires_auth, title, artist,
                   has_password, password, password_len, auth_key, auth_key_len, 0);
}

int
raop_probe_v2(raop_t *h, const char *host, int port, const char *name, int volume,
              int devtype, int encrypt, uint32_t pos_ms, uint32_t len_ms,
              uint16_t wanted_metadata, int authsetup, int requires_auth,
              const char *title, const char *artist, int has_password,
              const uint8_t *password, size_t password_len,
              const uint8_t *auth_key, size_t auth_key_len)
{
  return raop_open(h, host, port, name, volume, devtype, encrypt, pos_ms, len_ms,
                   wanted_metadata, authsetup, requires_auth, title, artist,
                   has_password, password, password_len, auth_key, auth_key_len, 1);
}

int
raop_write(raop_t *h, const uint8_t *pcm, size_t len)
{
  if (!h || !pcm || h->stream)
    return -1;
  pthread_mutex_lock(&rt.lock);
  int result = stream_claim_locked(NULL, h);
  if (result == 0) result = raop_player_write(h->player, pcm, len);
  pthread_mutex_unlock(&rt.lock);
  return result;
}

int
raop_volume(raop_t *h, int pct)
{
  cmd *c;

  if (!h)
    return -1;
  c = calloc(1, sizeof(*c));
  if (!c)
    return -1;
  c->type = CMD_VOLUME;
  c->volume = pct < 0 ? 0 : (pct > 100 ? 100 : pct);
  return cmd_push(h, c);
}

int
raop_flush(raop_t *h)
{
  cmd *c;

  if (!h)
    return -1;
  c = calloc(1, sizeof(*c));
  if (!c)
    return -1;
  c->type = CMD_FLUSH;
  pthread_mutex_lock(&rt.lock);
  if (h->stream && h->stream->canceling) {
    pthread_mutex_unlock(&rt.lock); cmd_free(c); return -1;
  }
  if (h->stream) c->epoch = h->stream->epoch;
  pthread_mutex_unlock(&rt.lock);
  return cmd_push(h, c);
}

int
raop_teardown(raop_t *h)
{
  cmd *c;

  if (!h)
    return -1;
  c = calloc(1, sizeof(*c));
  if (!c)
    return -1;
  c->type = CMD_TEARDOWN;
  return cmd_push(h, c);
}

int
raop_pin(raop_t *h, const char *pin)
{
  cmd *c;

  if (!h || !pin || strnlen(pin, 5) != 4 ||
      strspn(pin, "0123456789") != 4)
    return -1;
  c = calloc(1, sizeof(*c));
  if (!c)
    return -1;
  c->type = CMD_PIN;
  snprintf(c->pin, sizeof(c->pin), "%s", pin);
  return cmd_push(h, c);
}

int
raop_poll(raop_t *h, char *buf, size_t cap)
{
  size_t len;

  if (!h || !buf || cap == 0)
    return -1;

  pthread_mutex_lock(&h->events_lock);
  if (h->events_tail == h->events_head)
    {
      pthread_mutex_unlock(&h->events_lock);
      return 0;
    }
  len = strlen(h->events[h->events_tail]);
  if (len + 1 > cap)
    len = cap - 1;
  memcpy(buf, h->events[h->events_tail], len);
  buf[len] = '\0';
  h->events_tail = (h->events_tail + 1) % EVENT_RING;
  pthread_mutex_unlock(&h->events_lock);

  return (int)len;
}

int
raop_credential_poll(raop_t *h, uint64_t *revision, char *key, size_t cap)
{
  if (!h || !revision) return -1;
  pthread_mutex_lock(&h->credential_lock);
  int kind = h->credential_leased ? h->credential_lease_kind : h->credential_kind;
  if (!h->credential_leased && !h->credential_pending) {
    pthread_mutex_unlock(&h->credential_lock); return 0;
  }
  if (kind == 1 && (!key || cap < 129)) {
    pthread_mutex_unlock(&h->credential_lock); return -2;
  }
  if (!h->credential_leased) {
    h->credential_leased = h->credential_pending;
    h->credential_lease_kind = kind;
    memcpy(h->credential_lease_key, h->credential_key, 129);
  }
  *revision = h->credential_leased;
  if (key && cap) {
    key[0] = 0;
    if (kind == 1) memcpy(key, h->credential_lease_key, 129);
  }
  pthread_mutex_unlock(&h->credential_lock);
  return kind;
}

int
raop_credential_ack(raop_t *h, uint64_t revision)
{
  if (!h || !revision) return -1;
  pthread_mutex_lock(&h->credential_lock);
  if (h->credential_leased != revision) {
    pthread_mutex_unlock(&h->credential_lock); return 0;
  }
  if (h->credential_pending == revision) {
    h->credential_pending = 0;
    explicit_bzero(h->credential_key, sizeof(h->credential_key));
  }
  h->credential_leased = 0;
  explicit_bzero(h->credential_lease_key, sizeof(h->credential_lease_key));
  pthread_mutex_unlock(&h->credential_lock);
  return 1;
}

/* Teardown (if needed), free, and release the shared runtime. Returns 0
 * when the handle was provably released (the loop thread ran the free) and
 * -1 when the free could not be queued — the handle is then leaked BY
 * DESIGN (never a use-after-free), and the caller must treat cleanup as
 * failed, not as success (plan atv3-session-recycle). */
int
raop_free(raop_t *h)
{
  free_sync sync;
  cmd *c;

  if (!h)
    return -1;

  pthread_mutex_lock(&h->cmds_lock);
  h->free_requested = 1;
  pthread_mutex_unlock(&h->cmds_lock);

  /* Free ON the loop thread, after every queued command and every pending
   * drain callback for this handle (CMD_FREE is last-in, FIFO). */
  memset(&sync, 0, sizeof(sync));
  pthread_mutex_init(&sync.lock, NULL);
  pthread_cond_init(&sync.cond, NULL);

  c = calloc(1, sizeof(*c));
  if (!c)
    {
      /* Can't queue the free — leak the handle rather than UAF, and SAY so
       * (the caller cannot tell a leak from a release without the -1). */
      pthread_mutex_destroy(&sync.lock);
      pthread_cond_destroy(&sync.cond);
      return -1;
    }
  c->type = CMD_FREE;
  c->sync = &sync;

  pthread_mutex_lock(&sync.lock);
  if (cmd_push(h, c) < 0)
    {
      /* cmd_push owns (freed) c on a scheduling failure. */
      pthread_mutex_unlock(&sync.lock);
      pthread_mutex_destroy(&sync.lock);
      pthread_cond_destroy(&sync.cond);
      return -1;
    }
  while (!sync.done)
    pthread_cond_wait(&sync.cond, &sync.lock);
  pthread_mutex_unlock(&sync.lock);
  pthread_mutex_destroy(&sync.lock);
  pthread_cond_destroy(&sync.cond);

  if (sync.result == 0) runtime_release();
  return sync.result;
}
