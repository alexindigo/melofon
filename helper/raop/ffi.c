/* ffi.c — libmelofon_raop: OwnTone's RAOP (raop.c, vendored under vendor/)
 * as an in-process library for Melofon's Deno FFI — no helper binary, no
 * stdin protocol (that was the old main.c). Flat opaque-handle C API, no
 * callbacks into JS; Deno polls events (raop_poll).
 *
 * Threading: raop.c is process-global (OwnTone runs one RAOP module per
 * process), so the library owns ONE runtime — a background pthread with the
 * libevent base and the 10 ms pacing tick — ref-counted by handles
 * (raop_new starts it, the last raop_free stops and joins it). Each handle
 * is one AirPlay device: a command queue onto the loop (event_base_once,
 * evthread), a PCM buffer the tick drains, and an event ring Deno drains.
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
 *   void raop_free(raop_t *);
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

/* The RAOP output backend (raop.c). */
extern struct output_definition output_raop;

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

/* OwnTone player's tick (player.c): 10 ms. */
#define TICK_MS      10
#define TICK_SAMPLES 441  /* 44100 Hz * 10 ms */
#define TICK_BYTES   (TICK_SAMPLES * 4) /* s16 stereo */

/* Per-handle PCM read-ahead cap; raop_write accepts what fits (the Deno
 * pump's backpressure). ~2 s of 44.1k/s16/stereo: a wedged-then-late session
 * must never dump a stale backlog (the old 256 MB cap let ~24 min pile up —
 * the "57 min late" bug). */
#define PCM_CAP (2 * 44100 * 4)

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
} cmd_type;

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
  struct cmd *next;
} cmd;

struct raop_handle
{
  uint64_t id;                     /* device id (raop.c outputs_device_get) */
  struct output_device *device;    /* NULL until the start command runs */
  enum output_device_state state;

  /* PCM read-ahead the 10 ms tick paces out; mutex-guarded (raop_write is
   * called from the caller's thread, the tick from the loop thread). */
  struct evbuffer *pcm;
  pthread_mutex_t pcm_lock;
  uint64_t pts_samples;            /* stream clock (loop thread only) */

  /* Diagnostics (MELOFON_RAOP_DEBUG): cumulative samples the tick has fed
   * into raop_write — the library's view of "audio is leaving". Compare
   * against /proc/net/snmp OutDatagrams (the kernel's view). */
  uint64_t fed_samples;
  uint64_t fed_bytes_pending;
  struct timeval last_debug;

  /* Event ring for raop_poll. */
  char events[EVENT_RING][EVENT_LEN];
  int events_head;                 /* next write */
  int events_tail;                 /* next read */
  pthread_mutex_t events_lock;

  /* Commands queued by the API onto the loop thread. */
  cmd *cmds_head;
  cmd *cmds_tail;
  pthread_mutex_t cmds_lock;

  struct raop_handle *next;
};

typedef struct raop_handle raop_t;

/* ------------------------------------------------------------------ runtime */

static struct
{
  pthread_t thread;
  struct event_base *base;
  struct event *tick;
  int handles;                 /* live handle count (runtime_lock) */
  bool running;
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
        if (state == OUTPUT_STATE_CONNECTED)
          {
            /* Backlog policy: the session just came up — drop anything
             * buffered during startup (stale on the wedged-then-late path)
             * and start the stream clock fresh. */
            pthread_mutex_lock(&h->pcm_lock);
            evbuffer_drain(h->pcm, evbuffer_get_length(h->pcm));
            pthread_mutex_unlock(&h->pcm_lock);
            h->pts_samples = 0;
            h->fed_samples = 0;
          }
        event_push(h, value);
        break;
      }
  pthread_mutex_unlock(&rt.lock);
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

/* ------------------------------------------------------------------- pacing */

/* 10 ms tick on the loop thread: feed up to one tick's worth of PCM per
 * handle to the RAOP sessions, stream clock advancing per handle. */
static const char *
state_name(enum output_device_state state)
{
  switch (state)
    {
      case OUTPUT_STATE_STOPPED:   return "stopped";
      case OUTPUT_STATE_STARTUP:   return "startup";
      case OUTPUT_STATE_CONNECTED: return "connected";
      case OUTPUT_STATE_STREAMING: return "streaming";
      case OUTPUT_STATE_FAILED:    return "failed";
      case OUTPUT_STATE_PASSWORD:  return "password";
      default:                     return "unknown";
    }
}

/* Once per second per handle at E_DBG: state machine, buffered PCM, and the
 * cumulative samples fed into raop_write (frames, not RTP packets). */
static void
tick_debug(raop_t *h)
{
  struct timeval now;
  size_t buffered;

  gettimeofday(&now, NULL);
  if (now.tv_sec == h->last_debug.tv_sec)
    return;
  h->last_debug = now;

  pthread_mutex_lock(&h->pcm_lock);
  buffered = evbuffer_get_length(h->pcm);
  pthread_mutex_unlock(&h->pcm_lock);

  /* RAOP packets are 352 samples; fed_samples/352 approximates RTP audio. */
  DPRINTF(E_DBG, L_RAOP,
          "tick: state=%s pcm_buffered=%zu fed_samples=%llu (~%llu rtp)\n",
          state_name(h->state), buffered,
          (unsigned long long)h->fed_samples,
          (unsigned long long)(h->fed_samples / 352));
}

static void
tick_cb(evutil_socket_t fd, short what, void *arg)
{
  struct output_buffer obuf;
  uint8_t scratch[TICK_BYTES];
  raop_t *h;
  size_t avail;
  size_t n;

  (void)fd; (void)what; (void)arg;

  pthread_mutex_lock(&rt.lock);
  for (h = rt.handles_list; h; h = h->next)
    {
      if (h->state != OUTPUT_STATE_CONNECTED
          && h->state != OUTPUT_STATE_STREAMING)
        {
          tick_debug(h);
          continue;
        }

      pthread_mutex_lock(&h->pcm_lock);
      avail = evbuffer_get_length(h->pcm);
      if (avail < 4)
        {
          pthread_mutex_unlock(&h->pcm_lock);
          continue;
        }
      n = avail > TICK_BYTES ? TICK_BYTES : (avail & ~(size_t)3);
      if (evbuffer_remove(h->pcm, scratch, n) < 0)
        {
          pthread_mutex_unlock(&h->pcm_lock);
          continue;
        }
      pthread_mutex_unlock(&h->pcm_lock);

      memset(&obuf, 0, sizeof(obuf));
      obuf.data[0].buffer = scratch;
      obuf.data[0].bufsize = n;
      obuf.data[0].samples = (int)(n / 4);
      obuf.data[0].quality.sample_rate = 44100;
      obuf.data[0].quality.bits_per_sample = 16;
      obuf.data[0].quality.channels = 2;
      /* obuf.data[1].buffer = NULL terminates the quality array. */
      obuf.pts.tv_sec = (time_t)(h->pts_samples / 44100);
      obuf.pts.tv_nsec =
        (long)((h->pts_samples % 44100) * 1000000000ULL / 44100);

      output_raop.write(&obuf);

      h->fed_samples += (uint64_t)(n / 4);
      h->pts_samples += (uint64_t)(n / 4);
      tick_debug(h);
    }
  pthread_mutex_unlock(&rt.lock);
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
      DPRINTF(E_LOG, L_RAOP, "Cannot resolve '%s'\n", host);
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

/* Loop thread: create the device for h and open the RAOP session. */
static int
device_start(raop_t *h, const cmd *c)
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
  re->wanted_metadata = 0;            /* no artwork/text source in-process */
  re->encrypt = c->encrypt ? true : false;
  re->supports_auth_setup = true;     /* allow the PIN verification flow */

  dev->id = h->id;
  dev->name = strdup(c->name);
  dev->type = OUTPUT_TYPE_RAOP;
  dev->type_name = "AirPlay 1";
  dev->selected = 1;
  dev->advertised = 1;
  dev->volume = c->volume;
  dev->relvol = c->volume;
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

  if (output_raop.device_start(dev, 0) < 0)
    {
      device_free(h);
      h->state = OUTPUT_STATE_FAILED;
      event_push(h, "failed");
      return -1;
    }

  return 0;
}

static void
device_teardown(raop_t *h)
{
  if (!h->device)
    return;

  if (h->device->session)
    output_raop.device_stop(h->device, 0);
  device_free(h);

  pthread_mutex_lock(&h->pcm_lock);
  evbuffer_drain(h->pcm, evbuffer_get_length(h->pcm));
  pthread_mutex_unlock(&h->pcm_lock);

  h->pts_samples = 0;
  h->state = OUTPUT_STATE_STOPPED;
  event_push(h, "stopped");
}

/* Loop thread: run every queued command. */
static void
cmds_drain_cb(evutil_socket_t fd, short what, void *arg)
{
  raop_t *h = arg;
  cmd *list;
  cmd *c;

  (void)fd; (void)what;

  pthread_mutex_lock(&h->cmds_lock);
  list = h->cmds_head;
  h->cmds_head = h->cmds_tail = NULL;
  pthread_mutex_unlock(&h->cmds_lock);

  while ((c = list) != NULL)
    {
      list = c->next;
      switch (c->type)
        {
          case CMD_START:
            if (h->device)
              device_teardown(h);
            h->pts_samples = 0;
            h->fed_samples = 0;
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
            pthread_mutex_lock(&h->pcm_lock);
            evbuffer_drain(h->pcm, evbuffer_get_length(h->pcm));
            pthread_mutex_unlock(&h->pcm_lock);
            if (h->device && h->device->session)
              output_raop.device_flush(h->device, 0);
            break;

          case CMD_TEARDOWN:
            device_teardown(h);
            break;

          case CMD_PIN:
            if (h->device)
              output_raop.device_authorize(h->device, c->pin, 0);
            break;
        }
      free(c);
    }
}

/* API thread: queue a command onto the loop. */
static int
cmd_push(raop_t *h, cmd *c)
{
  struct timeval zero = { 0, 0 };

  pthread_mutex_lock(&h->cmds_lock);
  c->next = NULL;
  if (h->cmds_tail)
    h->cmds_tail->next = c;
  else
    h->cmds_head = c;
  h->cmds_tail = c;
  pthread_mutex_unlock(&h->cmds_lock);

  /* Wakes the loop (evthread). Executes the queue ASAP. */
  return event_base_once(rt.base, -1, EV_TIMEOUT, cmds_drain_cb, h, &zero);
}

/* ------------------------------------------------------------------ runtime */

static void *
loop_main(void *arg)
{
  struct timeval tick;

  (void)arg;

  rt.base = event_base_new();
  if (!rt.base)
    {
      fprintf(stderr, "[raop] event_base_new failed\n");
      return NULL;
    }
  evbase_player = rt.base;

  if (output_raop.init() < 0)
    {
      fprintf(stderr, "[raop] raop init failed\n");
      return NULL;
    }

  rt.tick = event_new(rt.base, -1, EV_TIMEOUT | EV_PERSIST, tick_cb, NULL);
  tick.tv_sec = 0;
  tick.tv_usec = TICK_MS * 1000;
  evtimer_add(rt.tick, &tick);

  event_base_dispatch(rt.base);

  output_raop.deinit();
  event_free(rt.tick);
  event_base_free(rt.base);
  rt.base = NULL;
  evbase_player = NULL;

  return NULL;
}

/* First handle: init threads/gcrypt and start the loop thread. */
static int
runtime_acquire(void)
{
  int ret = 0;

  pthread_mutex_lock(&rt.lock);
  if (!rt.running)
    {
      const char *debug = getenv("MELOFON_RAOP_DEBUG");
      if (debug && (strcmp(debug, "1") == 0 || strcmp(debug, "true") == 0))
        helper_logger_set_severity(E_DBG);

      gcry_check_version(NULL);
      if (evthread_use_pthreads() != 0)
        {
          fprintf(stderr, "[raop] evthread_use_pthreads failed\n");
          pthread_mutex_unlock(&rt.lock);
          return -1;
        }
      if (pthread_create(&rt.thread, NULL, loop_main, NULL) != 0)
        {
          pthread_mutex_unlock(&rt.lock);
          return -1;
        }
      rt.running = true;
      /* Give loop_main a moment to publish rt.base before commands queue. */
      while (rt.base == NULL)
        {
          pthread_mutex_unlock(&rt.lock);
          usleep(1000);
          pthread_mutex_lock(&rt.lock);
        }
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
  pthread_mutex_unlock(&rt.lock);

  if (rt.base)
    event_base_loopbreak(rt.base);
  pthread_join(rt.thread, NULL);

  pthread_mutex_lock(&rt.lock);
  rt.running = false;
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

  h->pcm = evbuffer_new();
  if (!h->pcm)
    {
      free(h);
      return NULL;
    }
  pthread_mutex_init(&h->pcm_lock, NULL);
  pthread_mutex_init(&h->events_lock, NULL);
  pthread_mutex_init(&h->cmds_lock, NULL);
  h->state = OUTPUT_STATE_STOPPED;

  if (runtime_acquire() < 0)
    {
      evbuffer_free(h->pcm);
      free(h);
      return NULL;
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
           int devtype, int encrypt)
{
  cmd *c;

  if (!h || !host || !*host)
    return -1;
  if (port <= 0 || port > 65535)
    port = 7000;
  if (!name || !*name)
    name = host;

  c = calloc(1, sizeof(*c));
  if (!c)
    return -1;
  c->type = CMD_START;
  snprintf(c->host, sizeof(c->host), "%s", host);
  c->port = port;
  snprintf(c->name, sizeof(c->name), "%s", name);
  c->volume = volume < 0 ? 0 : (volume > 100 ? 100 : volume);
  c->devtype = devtype < 0 || devtype > 6 ? RDEV_APPLETV : devtype;
  c->encrypt = encrypt ? 1 : 0;

  return cmd_push(h, c);
}

int
raop_write(raop_t *h, const uint8_t *pcm, size_t len)
{
  size_t avail;
  size_t accept;

  if (!h || !pcm)
    return -1;

  pthread_mutex_lock(&h->pcm_lock);
  avail = evbuffer_get_length(h->pcm);
  accept = len;
  if (avail + accept > PCM_CAP)
    accept = avail >= PCM_CAP ? 0 : PCM_CAP - avail;
  accept &= ~(size_t)3; /* keep whole s16-stereo frames */
  if (accept > 0 && evbuffer_add(h->pcm, pcm, accept) < 0)
    accept = 0;
  pthread_mutex_unlock(&h->pcm_lock);

  return (int)accept;
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

  if (!h || !pin || !*pin)
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

void
raop_free(raop_t *h)
{
  raop_t **link;

  if (!h)
    return;

  /* Teardown first if the caller didn't. */
  if (h->device)
    {
      raop_teardown(h);
      /* Wait for the loop to run the teardown (state -> stopped). */
      for (int i = 0; i < 5000 && h->state != OUTPUT_STATE_STOPPED; i++)
        usleep(1000);
    }

  pthread_mutex_lock(&rt.lock);
  for (link = &rt.handles_list; *link; link = &(*link)->next)
    if (*link == h)
      {
        *link = h->next;
        break;
      }
  pthread_mutex_unlock(&rt.lock);

  while (h->cmds_head)
    {
      cmd *c = h->cmds_head;
      h->cmds_head = c->next;
      free(c);
    }

  evbuffer_free(h->pcm);
  pthread_mutex_destroy(&h->pcm_lock);
  pthread_mutex_destroy(&h->events_lock);
  pthread_mutex_destroy(&h->cmds_lock);
  free(h);

  runtime_release();
}
