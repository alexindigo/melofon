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
struct raop_player *raop_player_new(struct event_base *evbase);
void raop_player_free(struct raop_player *p);
int raop_player_write(struct raop_player *p, const uint8_t *pcm, size_t len);
void raop_player_flush(struct raop_player *p);
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
  raop_t *handles_list;        /* all handles (loop thread iterates) */
} rt = {
  .lock = PTHREAD_MUTEX_INITIALIZER,
  .idle = PTHREAD_COND_INITIALIZER,
  .next_device_id = 1,
};

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
        h->state = state;
        /* OwnTone arms the playback timer when the device reports
         * CONNECTED and disarms it on teardown/failure — no PCM leaves
         * during the handshake, and nothing buffered earlier is dumped
         * (Deno waits for the connected event before feeding). */
        if (state == OUTPUT_STATE_CONNECTED || state == OUTPUT_STATE_STREAMING)
          raop_player_session_started(h->player);
        else if (state == OUTPUT_STATE_STOPPED || state == OUTPUT_STATE_FAILED)
          raop_player_session_stopped(h->player);
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

  address = resolve_address(c->host);
  if (!address)
    {
      event_push(h, "failed");
      return -1;
    }

  dev = calloc(1, sizeof(*dev));
  re = calloc(1, sizeof(*re));
  if (!dev || !re)
    {
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
  h->state = OUTPUT_STATE_STARTUP;
  event_push(h, "starting");

  raop_player_item_set(h->player, c->title, c->artist, c->pos_ms, c->len_ms,
                       c->wanted_metadata);

  /* OwnTone raop_device_cb (raop.c:4463). Contract test greps this. */
  helper_log_event(E_LOG, L_RAOP, "device_start", &(struct helper_log_fields){
    .device = h->id, .name = c->name, .host = address, .value = c->port,
    .value2 = re->wanted_metadata,
    .flags = (dev->requires_auth ? 1 : 0) | (re->encrypt ? 2 : 0) |
             (re->supports_auth_setup ? 4 : 0) | (c->devtype << 3)
  });

  if ((c->probe ? output_raop.device_probe(dev, 0) : output_raop.device_start(dev, 0)) < 0)
    {
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

  raop_player_session_stopped(h->player);

  device_free(h);

  raop_player_flush(h->player);

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
      if (!released && (c->type == CMD_TEARDOWN || c->type == CMD_FREE ||
                        (c->type == CMD_START && h->device))) {
        raop_player_session_stopped(h->player);
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
            raop_player_flush(h->player);
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
            pthread_mutex_unlock(&rt.lock);
            raop_player_free(h->player);
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

raop_t *
raop_new(void)
{
  raop_t *h;

  h = calloc(1, sizeof(*h));
  if (!h)
    return NULL;

  pthread_mutex_init(&h->events_lock, NULL);
  pthread_mutex_init(&h->cmds_lock, NULL);
  pthread_mutex_init(&h->credential_lock, NULL);
  h->state = OUTPUT_STATE_STOPPED;

  if (runtime_acquire() < 0)
    {
      pthread_mutex_destroy(&h->events_lock);
      pthread_mutex_destroy(&h->cmds_lock);
      pthread_mutex_destroy(&h->credential_lock);
      free(h);
      return NULL;
    }

  h->player = raop_player_new(rt.base);
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
    raop_player_free(h->player); runtime_release();
    pthread_mutex_destroy(&h->events_lock); pthread_mutex_destroy(&h->cmds_lock);
    pthread_mutex_destroy(&h->credential_lock);
    free(h); return NULL;
  }

  pthread_mutex_lock(&rt.lock);
  h->id = rt.next_device_id++;
  h->next = rt.handles_list;
  rt.handles_list = h;
  pthread_mutex_unlock(&rt.lock);

  return h;
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
  if (!h || !pcm)
    return -1;

  return raop_player_write(h->player, pcm, len);
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
