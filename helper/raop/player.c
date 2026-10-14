/* player.c — Melofon's stand-in for OwnTone src/player.c's RAOP calling
 * convention, not the music server. Tick, pts, start-buffer, start-after-
 * CONNECTED. Deno is the input thread; raop.c is the output.
 *
 * What this mirrors from OwnTone player.c:
 *  - the playback timer is a timerfd on CLOCK_MONOTONIC, 10 ms, one
 *    EV_READ|EV_PERSIST event (player.c:3986-3999);
 *  - the timer is ARMED when the device reports CONNECTED and disarmed on
 *    teardown/failure — never during the RTSP handshake
 *    (outputs_start -> device_activate_cb(CONNECTED) -> pb_timer_start,
 *    player.c:2105-2137 + playback_start_bh:2023-2036);
 *  - playback_cb reads the timer overrun and writes 1+overrun 10 ms frames
 *    to catch up after a stall (player.c:1272-1372);
 *  - the pts stream clock anchors at CLOCK_MONOTONIC on the first write
 *    after CONNECTED (OwnTone sets start_ts on the first source_read,
 *    player.c:869-874) and advances by the samples written
 *    (player.c:1366-1367).
 *
 * Deliberately not mirrored (Melofon owns that layer): source_read / the
 * input thread (Deno feeds s16le via raop_player_write), queue/repeat/
 * shuffle (the Melofon engine), multi-quality output buffering, speaker
 * resurrect, scrobbling.
 *
 * Threading: raop_player_write is called from the API (Deno) thread;
 * everything else runs on the runtime's libevent loop thread (ffi.c).
 * The pcm evbuffer is mutex-guarded; the write path never holds pcm_lock
 * while calling into raop.c (which re-enters ffi.c's registry).
 */

#ifdef HAVE_CONFIG_H
# include <config.h>
#endif

#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <pthread.h>
#include <sys/timerfd.h>

#include <event2/event.h>
#include <event2/buffer.h>

#include "logger.h"
#include "outputs.h"
#include "raop-bridge.h"

/* The RAOP output backend (raop.c). */
extern struct output_definition output_raop;
uint64_t outputs_buffer_duration_ms_get(void);

/* OwnTone player's tick (player.c): 10 ms. */
#define TICK_MS      10
#define TICK_SAMPLES 441  /* 44100 Hz * 10 ms */
#define TICK_BYTES   (TICK_SAMPLES * 4) /* s16 stereo */

/* raop.c:89 / 96-98. */
#define RAOP_AUDIO_LATENCY_MS  250
#define RAOP_MD_WANTS_TEXT     (1 << 0)
#define RAOP_MD_WANTS_ARTWORK  (1 << 1)
#define RAOP_MD_WANTS_PROGRESS (1 << 2)

/* raop.c's private struct raop_metadata, mirrored — the keep-alive and
 * event_play_start progress/text posts. */
struct raop_metadata_mirror
{
  struct evbuffer *metadata;
  struct evbuffer *artwork;
  int artwork_fmt;
};

/* Per-player PCM read-ahead cap; raop_player_write accepts what fits (the
 * Deno pump's backpressure). ~2 s of 44.1k/s16/stereo: a wedged-then-late
 * session must never dump a stale backlog (the old 256 MB cap let ~24 min
 * pile up — the "57 min late" bug). Backpressure, not a handshake dump:
 * the buffer is NOT drained when the session connects. */
#define PCM_CAP (2 * 44100 * 4)

struct raop_player
{
  struct event_base *evbase;     /* the runtime loop (ffi.c) */
  int timer_fd;                  /* timerfd, CLOCK_MONOTONIC */
  struct event *timer_ev;        /* EV_READ|EV_PERSIST on timer_fd */
  bool streaming;                /* between CONNECTED and teardown/failed */
  bool fed_in_epoch;             /* loop-owned actual backend write this epoch */

  /* PCM read-ahead the 10 ms tick paces out; mutex-guarded (write is
   * called from the caller's thread, the tick from the loop thread). */
  struct evbuffer *pcm;
  pthread_mutex_t pcm_lock;

  /* The pts stream clock, OwnTone's shape (player.c: pb_session.pts =
   * CLOCK_MONOTONIC at start + samples written): the sync packets' NTP
   * timestamps must share a base with the timing service's (which answers
   * with CLOCK_MONOTONIC) or the device schedules playout ~forever late —
   * receives the stream, asks retransmits, never renders. Anchored on the
   * first write after CONNECTED. */
  struct timespec pts_base;      /* CLOCK_MONOTONIC at the first write */
  uint64_t pts_samples;          /* samples fed since that base */
  bool clock_started;            /* pts_base is valid */

  /* Diagnostics (MELOFON_RAOP_DEBUG): cumulative samples the tick has fed
   * into raop_write — the library's view of "audio is leaving". Compare
   * against /proc/net/snmp OutDatagrams (the kernel's view). */
  uint64_t fed_samples;
  struct timeval last_debug;

  /* Current item — filled by raop_player_item_set from the start command.
   * Metadata goes out on the stream clock after output_buffer_samples
   * (OwnTone event_play_start, player.c:1109-1116 / 1178-1180). */
  char *title;
  char *artist;
  uint32_t pos_ms;
  uint32_t len_ms;
  uint16_t wanted_metadata;
  bool metadata_sent;
  bool peak_logged;
};

/* Once per second at E_DBG: streaming state, buffered PCM, and the
 * cumulative samples fed into raop_write (frames, not RTP packets). */
static void
player_debug(struct raop_player *p)
{
  struct timeval now;
  size_t buffered;

  gettimeofday(&now, NULL);
  if (now.tv_sec == p->last_debug.tv_sec)
    return;
  p->last_debug = now;

  pthread_mutex_lock(&p->pcm_lock);
  buffered = evbuffer_get_length(p->pcm);
  pthread_mutex_unlock(&p->pcm_lock);

  /* RAOP packets are 352 samples; fed_samples/352 approximates RTP audio. */
  helper_log_event(E_DBG, L_PLAYER, "player_tick", &(struct helper_log_fields){
    .value = buffered, .value2 = p->fed_samples, .flags = p->streaming ? 1 : 0
  });
}

static void
dmap_add_string(struct evbuffer *evbuf, const char *tag, const char *str)
{
  size_t len = str ? strlen(str) : 0;
  uint8_t hdr[8];

  memcpy(hdr, tag, 4);
  hdr[4] = (uint8_t)((len >> 24) & 0xff);
  hdr[5] = (uint8_t)((len >> 16) & 0xff);
  hdr[6] = (uint8_t)((len >> 8) & 0xff);
  hdr[7] = (uint8_t)(len & 0xff);
  evbuffer_add(evbuf, hdr, 8);
  if (len > 0)
    evbuffer_add(evbuf, str, len);
}

static void
dmap_add_container(struct evbuffer *evbuf, const char *tag, size_t len)
{
  uint8_t hdr[8];

  memcpy(hdr, tag, 4);
  hdr[4] = (uint8_t)((len >> 24) & 0xff);
  hdr[5] = (uint8_t)((len >> 16) & 0xff);
  hdr[6] = (uint8_t)((len >> 8) & 0xff);
  hdr[7] = (uint8_t)(len & 0xff);
  evbuffer_add(evbuf, hdr, 8);
}

/* Minimal mlit { minm, asar } — enough for RAOP text; full dmap_common.c
 * waits for DAAP (M7). */
static void
dmap_encode_text(struct evbuffer *out, const char *title, const char *artist)
{
  struct evbuffer *inner = evbuffer_new();
  size_t n;

  if (!inner)
    return;
  dmap_add_string(inner, "minm", title ? title : "");
  dmap_add_string(inner, "asar", artist ? artist : "");
  n = evbuffer_get_length(inner);
  dmap_add_container(out, "mlit", n);
  evbuffer_add_buffer(out, inner);
  evbuffer_free(inner);
}

static struct timespec
pts_now(const struct raop_player *p)
{
  uint64_t sec = (uint64_t)p->pts_base.tv_sec + p->pts_samples / 44100;
  uint64_t nsec = (uint64_t)p->pts_base.tv_nsec
                + (p->pts_samples % 44100) * 1000000000ULL / 44100;
  struct timespec ts;

  ts.tv_sec = (time_t)(sec + nsec / 1000000000ULL);
  ts.tv_nsec = (long)(nsec % 1000000000ULL);
  return ts;
}

/* OwnTone event_play_start: after output_buffer_samples written, send
 * metadata with the live stream pts. That object is what keep-alive
 * progress then uses. */
static void
metadata_send_now(struct raop_player *p)
{
  struct output_metadata *md;
  struct raop_metadata_mirror *rmd;

  if (p->wanted_metadata == 0)
    return;

  md = calloc(1, sizeof(*md));
  rmd = calloc(1, sizeof(*rmd));
  if (!md || !rmd)
    {
      free(md);
      free(rmd);
      return;
    }
  rmd->metadata = evbuffer_new();
  rmd->artwork = NULL; /* skip artwork unless we have bytes (plan: optional) */
  rmd->artwork_fmt = -1;
  if (p->wanted_metadata & RAOP_MD_WANTS_TEXT)
    dmap_encode_text(rmd->metadata, p->title, p->artist);
  md->type = OUTPUT_TYPE_RAOP;
  md->pos_ms = p->pos_ms;
  md->len_ms = p->len_ms;
  md->pts = pts_now(p);
  md->startup = true;
  md->priv = rmd;
  output_raop.metadata_send(md);
  p->metadata_sent = true;
}

static uint64_t
output_buffer_samples(void)
{
  uint64_t ms = outputs_buffer_duration_ms_get();

  if (ms <= RAOP_AUDIO_LATENCY_MS)
    return 0;
  return (ms - RAOP_AUDIO_LATENCY_MS) * 44100 / 1000;
}

static int
pcm_peak(const uint8_t *pcm, size_t n)
{
  int peak = 0;
  size_t i;

  for (i = 0; i + 1 < n; i += 2)
    {
      int16_t s = (int16_t)(pcm[i] | ((uint16_t)pcm[i + 1] << 8));
      int a = s < 0 ? -(int)s : (int)s;
      if (a > peak)
        peak = a;
    }
  return peak;
}

/* The 10 ms playback tick (OwnTone playback_cb, player.c:1272-1372): read
 * the timer overrun, then write 1+overrun frames from the PCM buffer into
 * the RAOP sessions, advancing the stream clock per sample written. */
static void
playback_cb(evutil_socket_t fd, short what, void *arg)
{
  struct raop_player *p = arg;
  struct output_buffer obuf;
  uint8_t scratch[TICK_BYTES];
  uint64_t overrun = 0;
  uint64_t frames;
  ssize_t ret;

  (void)fd; (void)what;

  /* Check if we missed any timer expirations (OwnTone's overrun--: the
   * first expiration is the tick itself). */
  ret = read(p->timer_fd, &overrun, sizeof(overrun));
  if (ret <= 0)
    {
      helper_log_event(E_LOG, L_PLAYER, "timer_read_failed", NULL);
      overrun = 0;
    }
  else if (overrun > 0)
    overrun--;

  /* The timer is only armed between CONNECTED and teardown, but a queued
   * expiration can land right after disarm — never write then. */
  if (!p->streaming)
    return;

  for (frames = 1 + overrun; frames > 0; frames--)
    {
      size_t avail;
      size_t n;

      pthread_mutex_lock(&p->pcm_lock);
      avail = evbuffer_get_length(p->pcm);
      if (avail < 4)
        {
          pthread_mutex_unlock(&p->pcm_lock);
          break;
        }
      n = avail > TICK_BYTES ? TICK_BYTES : (avail & ~(size_t)3);
      if (evbuffer_remove(p->pcm, scratch, n) < 0)
        {
          pthread_mutex_unlock(&p->pcm_lock);
          break;
        }
      pthread_mutex_unlock(&p->pcm_lock);

      if (!p->clock_started)
        {
          /* OwnTone anchors start_ts on the first source_read — which is
           * after the timer starts, never during the handshake. */
          clock_gettime(CLOCK_MONOTONIC, &p->pts_base);
          p->pts_samples = 0;
          p->clock_started = true;
        }
      if (!p->peak_logged)
        {
          helper_log_event(E_LOG, L_RAOP, "pcm_peak", &(struct helper_log_fields){
            .value = pcm_peak(scratch, n), .value2 = (int64_t)(n / 4)
          });
          p->peak_logged = true;
        }

      memset(&obuf, 0, sizeof(obuf));
      obuf.data[0].buffer = scratch;
      obuf.data[0].bufsize = n;
      obuf.data[0].samples = (int)(n / 4);
      obuf.data[0].quality.sample_rate = 44100;
      obuf.data[0].quality.bits_per_sample = 16;
      obuf.data[0].quality.channels = 2;
      /* obuf.data[1].buffer = NULL terminates the quality array. */
      obuf.pts = pts_now(p);

      output_raop.write(&obuf);
      p->fed_in_epoch = true;

      p->fed_samples += (uint64_t)(n / 4);
      p->pts_samples += (uint64_t)(n / 4);
      if (!p->metadata_sent && p->pts_samples >= output_buffer_samples())
        metadata_send_now(p);
    }

  player_debug(p);
}

struct raop_player *
raop_player_new(struct event_base *evbase)
{
  struct raop_player *p;

  p = calloc(1, sizeof(*p));
  if (!p)
    return NULL;

  p->evbase = evbase;
  p->pcm = evbuffer_new();
  p->timer_fd = timerfd_create(CLOCK_MONOTONIC, TFD_CLOEXEC | TFD_NONBLOCK);
  if (!p->pcm || p->timer_fd < 0)
    {
      helper_log_event(E_LOG, L_PLAYER, "player_create_failed", NULL);
      if (p->pcm)
        evbuffer_free(p->pcm);
      if (p->timer_fd >= 0)
        close(p->timer_fd);
      free(p);
      return NULL;
    }
  p->timer_ev = event_new(evbase, p->timer_fd, EV_READ | EV_PERSIST,
                          playback_cb, p);
  if (!p->timer_ev)
    {
      helper_log_event(E_LOG, L_PLAYER, "timer_event_failed", NULL);
      close(p->timer_fd);
      evbuffer_free(p->pcm);
      free(p);
      return NULL;
    }
  pthread_mutex_init(&p->pcm_lock, NULL);

  return p;
}

/* Loop thread only (freed where no callback can be mid-flight on p). */
void
raop_player_free(struct raop_player *p)
{
  if (!p)
    return;

  if (p->timer_ev)
    {
      event_del(p->timer_ev);
      event_free(p->timer_ev);
    }
  if (p->timer_fd >= 0)
    close(p->timer_fd);
  evbuffer_free(p->pcm);
  pthread_mutex_destroy(&p->pcm_lock);
  free(p->title);
  free(p->artist);
  free(p);
}

/* API thread: append s16le/44100/stereo PCM to the read-ahead. Returns
 * bytes accepted; < len means the cap is reached (caller retries — that is
 * the backpressure). Accepted at any time; paced out only while streaming. */
int
raop_player_write(struct raop_player *p, const uint8_t *pcm, size_t len)
{
  size_t avail;
  size_t accept;

  pthread_mutex_lock(&p->pcm_lock);
  avail = evbuffer_get_length(p->pcm);
  accept = len;
  if (avail + accept > PCM_CAP)
    accept = avail >= PCM_CAP ? 0 : PCM_CAP - avail;
  accept &= ~(size_t)3; /* keep whole s16-stereo frames */
  if (accept > 0 && evbuffer_add(p->pcm, pcm, accept) < 0)
    accept = 0;
  pthread_mutex_unlock(&p->pcm_lock);

  return (int)accept;
}

/* Loop thread: drop buffered PCM (pause/seek/track-change semantics; the
 * stream clock continues — resume re-feeds from the engine position). */
void
raop_player_flush(struct raop_player *p)
{
  pthread_mutex_lock(&p->pcm_lock);
  evbuffer_drain(p->pcm, evbuffer_get_length(p->pcm));
  pthread_mutex_unlock(&p->pcm_lock);
}

/* Loop thread: the device reported CONNECTED — arm the 10 ms timer
 * (OwnTone pb_timer_start from device_activate_cb). The pts clock
 * re-anchors on the first write. Idempotent (STREAMING re-enters here). */
void
raop_player_session_started(struct raop_player *p)
{
  struct itimerspec tick;

  if (p->streaming)
    return;
  p->fed_in_epoch = false;
  p->streaming = true;
  p->clock_started = false;
  p->metadata_sent = false;
  p->peak_logged = false;

  memset(&tick, 0, sizeof(tick));
  tick.it_interval.tv_nsec = TICK_MS * 1000000;
  tick.it_value.tv_nsec = TICK_MS * 1000000;
  if (event_add(p->timer_ev, NULL) < 0
      || timerfd_settime(p->timer_fd, 0, &tick, NULL) < 0)
    helper_log_event(E_LOG, L_PLAYER, "timer_arm_failed", NULL);
}

/* Loop thread: teardown or failure — disarm. Idempotent. */
void
raop_player_session_stopped(struct raop_player *p)
{
  struct itimerspec zero;

  if (!p->streaming)
    return;
  p->streaming = false;

  /* A player that actually fed the shared backend in this epoch owns its
   * incomplete PCM block too. Do not splice it into a later current-position
   * feed while a surviving peer keeps the native master alive. Non-feeding
   * handles must not disturb the effective peer's partial input. Loop-only. */
  if (p->fed_in_epoch)
    raop_discard_pending_input();
  p->fed_in_epoch = false;

  memset(&zero, 0, sizeof(zero));
  timerfd_settime(p->timer_fd, 0, &zero, NULL);
  event_del(p->timer_ev);
}

/* Loop thread: the start command's item (title/artist/len) and the TXT
 * wanted_metadata bitmask. Called before the session connects so the
 * event_play_start send has them. */
void
raop_player_item_set(struct raop_player *p, const char *title,
                     const char *artist, uint32_t pos_ms, uint32_t len_ms,
                     uint16_t wanted_metadata)
{
  free(p->title);
  free(p->artist);
  p->title = title && *title ? strdup(title) : NULL;
  p->artist = artist && *artist ? strdup(artist) : NULL;
  p->pos_ms = pos_ms;
  p->len_ms = len_ms;
  p->wanted_metadata = wanted_metadata;
  p->metadata_sent = false;
}
