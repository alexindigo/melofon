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
#include <errno.h>
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

/* Bounded retained marker storage, independent of the PCM byte cap. Input runs
 * reserve their dispatch record plus the possible following silence records, so
 * the loop never needs an allocation or drops a range after accepting bytes.
 * Terminal acknowledgement reclaims source/input/range observations. */
#define TIMELINE_MARKERS 256
#define TRANSPORT_RANGES (3 * TIMELINE_MARKERS + 3)
struct source_record {
  uint64_t id, accepted, fed, target, input_end;
  bool sealed;
};
struct input_range {
  uint64_t source, segment, source_offset, frames, fed;
};
struct timeline {
  bool enabled, ended, tail_reached, complete;
  uint64_t accepted, end_target, padding_left, transport_end;
  uint64_t compatibility_source, last_real_end;
  size_t sources, inputs, next_input, ranges;
  struct source_record source[TIMELINE_MARKERS];
  struct input_range input[TIMELINE_MARKERS];
  struct raop_range_snapshot range[TRANSPORT_RANGES];
  uint64_t range_owner[TRANSPORT_RANGES], last_source;
};

struct metadata_marker {
  uint64_t source, frame, origin, duration;
  char *title, *artist;
  struct metadata_marker *next;
};

struct raop_player
{
  uint64_t stream_id;
  struct event_base *evbase;     /* the runtime loop (ffi.c) */
  int timer_fd;                  /* timerfd, CLOCK_MONOTONIC */
  struct event *timer_ev;        /* EV_READ|EV_PERSIST on timer_fd */
  bool streaming;                /* between CONNECTED and teardown/failed */
  bool fed_in_epoch;             /* loop-owned actual backend write this epoch */
  bool fenced;                   /* pcm_lock; synchronous cancel admission */

  /* PCM read-ahead the 10 ms tick paces out; mutex-guarded (write is
   * called from the caller's thread, the tick from the loop thread). */
  struct evbuffer *pcm;
  pthread_mutex_t pcm_lock;
  struct timeline *timeline;     /* pcm_lock; allocated before first admission */
  struct raop_progress_snapshot failure; /* pcm_lock; first failure is retained */
  struct metadata_marker *metadata_head, *metadata_tail;
  size_t metadata_count;
  uint64_t metadata_source, metadata_origin, metadata_position;

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
static int
dmap_encode_text(struct evbuffer *out, const char *title, const char *artist)
{
  struct evbuffer *inner = evbuffer_new();
  size_t n;

  if (!inner)
    return -1;
  dmap_add_string(inner, "minm", title ? title : "");
  dmap_add_string(inner, "asar", artist ? artist : "");
  n = evbuffer_get_length(inner);
  dmap_add_container(out, "mlit", n);
  evbuffer_add_buffer(out, inner);
  evbuffer_free(inner);
  return 0;
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
  md->stream_id = p->stream_id;
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

static uint64_t monotonic_ns(void);

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
      if (errno != EAGAIN) {
        raop_player_failed(p, RAOP_PROGRESS_TRANSPORT);
        raop_ffi_progress_failed(p->stream_id, RAOP_PROGRESS_TRANSPORT);
      }
      return;
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
      struct timeline *t = p->timeline;
      bool timeline = t && t->enabled;
      if (p->fenced || p->failure.error || (avail < 4 && (!timeline || !p->clock_started)))
        {
          pthread_mutex_unlock(&p->pcm_lock);
          break;
        }
      n = avail > TICK_BYTES ? TICK_BYTES : (avail & ~(size_t)3);
      /* An empty producer queue is not a presentation underrun. Preserve the
       * backend's partial ALAC packet while the existing receiver lead still
       * permits a successor to continue it. Check the actual earliest packet
       * deadline, allowing the next timer interval to complete that packet.
       * Explicit compatibility silence and stream end intentionally pace zeros. */
      if (timeline && !n && !t->ended &&
          !(t->compatibility_source && t->last_source == t->compatibility_source)) {
        uint64_t deadline = raop_transport_input_deadline(p->stream_id);
        /* A tick may leave an incomplete 352-frame packet. Reserve that
         * packet's duration as well as the next timer interval, otherwise the
         * next tick could arrive after its first frame's deadline. */
        uint64_t dispatch_horizon = TICK_MS * 1000000ULL + 352 * 1000000000ULL / 44100;
        if (deadline && monotonic_ns() + dispatch_horizon < deadline) {
          pthread_mutex_unlock(&p->pcm_lock);
          break;
        }
      }
      if (evbuffer_remove(p->pcm, scratch, n) < 0)
        {
          pthread_mutex_unlock(&p->pcm_lock);
          break;
        }
      size_t real = n / 4;
      /* Establish the epoch coordinate before recording any transport range. */
      if (!p->clock_started) {
        clock_gettime(CLOCK_MONOTONIC, &p->pts_base);
        p->pts_samples = 0;
        p->clock_started = true;
      }
      if (timeline) {
        /* A short real read is not a padded tick. B continues A's partial
         * packet; only final EOF or an actual empty-input underrun adds zeros. */
        size_t output_frames = real && !t->ended ? real : TICK_SAMPLES;
        memset(scratch + n, 0, TICK_BYTES - n);
        uint64_t transport = p->pts_samples;
        size_t left = real;
        while (left) {
          struct input_range *in = &t->input[t->next_input];
          size_t take = in->frames - in->fed;
          if (take > left) take = left;
          struct raop_range_snapshot *r = t->ranges ? &t->range[t->ranges - 1] : NULL;
          if (!r || r->kind != RAOP_RANGE_REAL || r->source != in->source ||
              r->segment != in->segment || r->transport_start + r->frames != transport ||
              r->source_offset + r->frames != in->source_offset + in->fed) {
            t->range_owner[t->ranges] = in->source;
            r = &t->range[t->ranges++];
            *r = (struct raop_range_snapshot){ .kind = RAOP_RANGE_REAL,
              .source = in->source, .segment = in->segment,
              .source_offset = in->source_offset + in->fed, .transport_start = transport };
          }
          r->frames += take;
          t->last_source = in->source;
          for (size_t i = 0; i < t->sources; i++)
            if (t->source[i].id == in->source) { t->source[i].fed += take; break; }
          in->fed += take;
          if (in->fed == in->frames) t->next_input++;
          transport += take;
          t->last_real_end = transport;
          left -= take;
        }
        size_t silence = output_frames - real;
        if (t->ended && t->next_input == t->inputs && !t->tail_reached) {
          t->tail_reached = true;
          t->transport_end = t->last_real_end;
          t->padding_left = (352 - transport % 352) % 352;
        }
        size_t padding = t->padding_left;
        if (padding > silence) padding = silence;
        t->padding_left -= padding;
        for (int pass = 0; pass < 2; pass++) {
          size_t count = pass ? silence - padding : padding;
          if (!count) continue;
          uint64_t kind = pass ? (t->ended ? RAOP_RANGE_DRAIN :
            (t->compatibility_source && t->last_source == t->compatibility_source
              ? RAOP_RANGE_COMPATIBILITY : RAOP_RANGE_UNDERRUN))
                               : RAOP_RANGE_PADDING;
          struct raop_range_snapshot *r = t->ranges ? &t->range[t->ranges - 1] : NULL;
          if (!r || r->kind != kind || r->transport_start + r->frames != transport) {
            t->range_owner[t->ranges] = t->last_source;
            r = &t->range[t->ranges++];
            *r = (struct raop_range_snapshot){ .kind = kind, .transport_start = transport };
          }
          r->frames += count;
          transport += count;
        }
        n = output_frames * 4;
      }
      pthread_mutex_unlock(&p->pcm_lock);

      if (!p->peak_logged)
        {
          helper_log_event(E_LOG, L_RAOP, "pcm_peak", &(struct helper_log_fields){
            .value = pcm_peak(scratch, n), .value2 = (int64_t)(n / 4)
          });
          p->peak_logged = true;
        }

      memset(&obuf, 0, sizeof(obuf));
      obuf.stream_id = p->stream_id;
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
      if (!timeline && !p->metadata_sent && p->pts_samples >= output_buffer_samples())
        metadata_send_now(p);
    }

  player_debug(p);
  raop_player_metadata_update(p);
  raop_ffi_completion_update(p->stream_id);
}

static void
metadata_marker_free(struct metadata_marker *marker)
{
  free(marker->title); free(marker->artist); free(marker);
}

static void
metadata_clear(struct raop_player *p)
{
  while (p->metadata_head) {
    struct metadata_marker *next = p->metadata_head->next;
    metadata_marker_free(p->metadata_head);
    p->metadata_head = next;
  }
  p->metadata_tail = NULL; p->metadata_count = 0; p->metadata_source = 0;
}

int
raop_player_metadata(struct raop_player *p, uint64_t source, uint64_t frame,
  uint64_t origin, uint64_t duration, const char *title, const char *artist)
{
  pthread_mutex_lock(&p->pcm_lock);
  struct timeline *t = p->timeline;
  bool valid = false;
  if (t && !p->fenced) for (size_t i = 0; i < t->sources; i++)
    if (t->source[i].id == source && frame <= t->source[i].accepted) valid = true;
  if (!valid) { pthread_mutex_unlock(&p->pcm_lock); return -1; }
  struct metadata_marker *last = p->metadata_tail;
  bool replace = last && last->source == source && last->frame == frame;
  if (!replace && p->metadata_count == TIMELINE_MARKERS) {
    pthread_mutex_unlock(&p->pcm_lock); return 0;
  }
  struct metadata_marker *m = calloc(1, sizeof(*m));
  if (m) { m->title = strdup(title); m->artist = strdup(artist); }
  if (!m || !m->title || !m->artist) {
    if (m) metadata_marker_free(m);
    pthread_mutex_unlock(&p->pcm_lock); return -2;
  }
  m->source = source; m->frame = frame; m->origin = origin; m->duration = duration;
  if (replace) {
    free(last->title); free(last->artist);
    last->title = m->title; last->artist = m->artist;
    last->origin = origin; last->duration = duration; free(m);
  } else {
    if (last) last->next = m; else p->metadata_head = m;
    p->metadata_tail = m; p->metadata_count++;
  }
  pthread_mutex_unlock(&p->pcm_lock);
  return 1;
}

/* Loop-only: both pacing and retained poll observations cross this boundary
 * before completion can be returned/ACKed. Nothing publishes at decode time. */
void
raop_player_metadata_update(struct raop_player *p)
{
  for (;;) {
    pthread_mutex_lock(&p->pcm_lock);
    struct metadata_marker *m = p->metadata_head;
    struct raop_progress_snapshot progress;
    uint64_t transport = 0;
    bool mapped = false;
    if (!p->fenced && !p->failure.error && m && p->timeline) {
      for (size_t i = 0; i < p->timeline->ranges; i++) {
        struct raop_range_snapshot *r = &p->timeline->range[i];
        if (r->kind == RAOP_RANGE_REAL && r->source == m->source &&
            r->source_offset <= m->frame && m->frame < r->source_offset + r->frames) {
          transport = r->transport_start + m->frame - r->source_offset;
          mapped = true; break;
        }
      }
      raop_transport_progress(p->stream_id, 0, monotonic_ns(), &progress);
      mapped = mapped && progress.status == 1 && progress.scheduled_frames > transport;
    }
    if (!mapped) { pthread_mutex_unlock(&p->pcm_lock); break; }
    p->metadata_head = m->next;
    if (!p->metadata_head) p->metadata_tail = NULL;
    p->metadata_count--;
    p->metadata_source = m->source; p->metadata_origin = m->origin;
    p->metadata_position = m->origin + m->frame;
    pthread_mutex_unlock(&p->pcm_lock);

    struct output_metadata *md = calloc(1, sizeof(*md));
    struct raop_metadata_mirror *rmd = calloc(1, sizeof(*rmd));
    if (rmd) rmd->metadata = evbuffer_new();
    if (!md || !rmd || !rmd->metadata) {
      if (rmd) { if (rmd->metadata) evbuffer_free(rmd->metadata); free(rmd); }
      free(md); metadata_marker_free(m);
      raop_ffi_progress_failed(p->stream_id, RAOP_PROGRESS_ALLOCATION);
      return;
    }
    if (dmap_encode_text(rmd->metadata, m->title, m->artist) < 0) {
      evbuffer_free(rmd->metadata); free(rmd); free(md); metadata_marker_free(m);
      raop_ffi_progress_failed(p->stream_id, RAOP_PROGRESS_ALLOCATION);
      return;
    }
    rmd->artwork_fmt = -1;
    md->type = OUTPUT_TYPE_RAOP; md->stream_id = p->stream_id; md->timeline = true;
    md->timeline_frame = transport; md->media_frame = m->origin + m->frame;
    md->position_frames = md->media_frame; md->duration_frames = m->duration;
    md->priv = rmd;
    output_raop.metadata_send(md);
    metadata_marker_free(m);
  }
  if (p->metadata_source) {
    struct raop_progress_snapshot progress;
    raop_player_progress(p, p->metadata_source, 0, &progress);
    uint64_t position = p->metadata_origin + progress.source_frames;
    if (position > p->metadata_position) p->metadata_position = position;
    raop_timeline_metadata_progress(p->stream_id, p->metadata_position);
  }
}

struct raop_player *
raop_player_new(struct event_base *evbase, uint64_t stream_id)
{
  struct raop_player *p;

  p = calloc(1, sizeof(*p));
  if (!p)
    return NULL;

  p->stream_id = stream_id;
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
  metadata_clear(p);
  free(p->timeline);
  pthread_mutex_destroy(&p->pcm_lock);
  free(p->title);
  free(p->artist);
  free(p);
}

/* API thread: append s16le/44100/stereo PCM to the read-ahead. Returns
 * bytes accepted; < len means the cap is reached (caller retries — that is
 * the backpressure). Accepted at any time; paced out only while streaming. */
int
raop_player_append(struct raop_player *p, const uint8_t *pcm, size_t len)
{
  size_t avail;
  size_t accept;

  pthread_mutex_lock(&p->pcm_lock);
  if (p->failure.error) { pthread_mutex_unlock(&p->pcm_lock); return -1; }
  if (p->timeline && p->timeline->enabled) {
    pthread_mutex_unlock(&p->pcm_lock);
    return -2; /* unlabeled input cannot enter an accounted epoch */
  }
  avail = evbuffer_get_length(p->pcm);
  accept = avail >= PCM_CAP ? 0 : PCM_CAP - avail;
  if (accept > len) accept = len;
  accept &= ~(size_t)3; /* keep whole s16-stereo frames */
  if (accept > 0 && evbuffer_add(p->pcm, pcm, accept) < 0)
    {
      pthread_mutex_unlock(&p->pcm_lock);
      return -1; /* allocation failure is not bounded-ingress backpressure */
    }
  pthread_mutex_unlock(&p->pcm_lock);

  return (int)accept;
}

/* Transitional byte port preserves its existing zero-on-allocation-failure
 * behavior. New callers use exact admission and can distinguish the failure. */
int
raop_player_write(struct raop_player *p, const uint8_t *pcm, size_t len)
{
  int result = raop_player_append(p, pcm, len);
  return result == -2 ? -1 : (result < 0 ? 0 : result);
}

int
raop_player_timeline_active(struct raop_player *p)
{
  pthread_mutex_lock(&p->pcm_lock);
  int active = p->timeline && p->timeline->enabled;
  pthread_mutex_unlock(&p->pcm_lock);
  return active;
}

/* All timeline admission is called under the same outer rt.lock as cancel.
 * pcm_lock additionally serializes the loop's range dispatch and snapshots.
 * Refusals do not create a source, close input or consume marker capacity. */
static struct timeline *
timeline_get(struct raop_player *p)
{
  if (!p->timeline) p->timeline = calloc(1, sizeof(*p->timeline));
  return p->timeline;
}

int
raop_player_append_source(struct raop_player *p, uint64_t source, uint64_t segment,
                          const uint8_t *pcm, size_t len,
                          struct raop_source_append_result *result)
{
  pthread_mutex_lock(&p->pcm_lock);
  struct timeline *t = timeline_get(p);
  if (!t) { result->error = RAOP_APPEND_ERROR_ALLOCATION; goto out; }
  if (p->failure.error) goto out;
  if ((!t->enabled && (p->clock_started || evbuffer_get_length(p->pcm))) || t->ended)
    goto out;
  struct source_record *s = NULL;
  for (size_t i = 0; i < t->sources; i++)
    if (t->source[i].id == source) { s = &t->source[i]; break; }
  if (s && s->sealed) goto out;
  if (!s && t->sources && !t->source[t->sources - 1].sealed) goto out;
  result->input_offset = t->accepted;
  result->source_offset = s ? s->accepted : 0;
  struct input_range *in = t->inputs ? &t->input[t->inputs - 1] : NULL;
  /* Merge retries only while the same run still has queued input. Once fully
   * dispatched a later append gets a new run, since silence may intervene. */
  bool merge = in && in->source == source && in->segment == segment && in->fed < in->frames;
  if ((!s && t->sources == TIMELINE_MARKERS) ||
      (len && !merge && t->inputs == TIMELINE_MARKERS)) {
    result->status = RAOP_APPEND_BACKPRESSURE;
    result->error = RAOP_APPEND_ERROR_NONE;
    goto out;
  }
  size_t avail = evbuffer_get_length(p->pcm);
  size_t accept = avail >= PCM_CAP ? 0 : PCM_CAP - avail;
  if (accept > len) accept = len;
  accept &= ~(size_t)3;
  if (t->accepted > UINT64_MAX - accept / 4 ||
      (s && s->accepted > UINT64_MAX - accept / 4)) goto out;
  if (accept && evbuffer_add(p->pcm, pcm, accept) < 0) {
    result->error = RAOP_APPEND_ERROR_ALLOCATION;
    goto out;
  }
  if (!s && (!len || accept)) {
    s = &t->source[t->sources++];
    *s = (struct source_record){ .id = source };
  }
  if (accept) {
    if (!merge) {
      in = &t->input[t->inputs++];
      *in = (struct input_range){ .source = source, .segment = segment,
                                 .source_offset = s->accepted };
    }
    in->frames += accept / 4;
    s->accepted += accept / 4;
    t->accepted += accept / 4;
  }
  /* Empty explicit source input establishes identity but never anchors time. */
  if (s) t->enabled = true;
  result->accepted_frames = accept / 4;
  result->status = accept == len ? RAOP_APPEND_ACCEPTED : RAOP_APPEND_BACKPRESSURE;
  result->error = RAOP_APPEND_ERROR_NONE;
out:
  pthread_mutex_unlock(&p->pcm_lock);
  return 0;
}

void
raop_player_seal(struct raop_player *p, uint64_t source, uint64_t target,
                 struct raop_marker_result *result)
{
  pthread_mutex_lock(&p->pcm_lock);
  struct timeline *t = p->timeline;
  if (t) for (size_t i = 0; i < t->sources; i++) {
    struct source_record *s = &t->source[i];
    if (s->id != source || target != s->accepted) continue;
    if (!s->sealed) {
      s->sealed = true;
      s->target = target;
      s->input_end = t->accepted;
    }
    result->input_end = s->input_end;
    result->status = RAOP_APPEND_ACCEPTED;
    result->error = RAOP_APPEND_ERROR_NONE;
    break;
  }
  pthread_mutex_unlock(&p->pcm_lock);
}

void
raop_player_end(struct raop_player *p, uint64_t target, struct raop_marker_result *result)
{
  pthread_mutex_lock(&p->pcm_lock);
  struct timeline *t = timeline_get(p);
  if (!t) result->error = RAOP_APPEND_ERROR_ALLOCATION;
  else if (!t->enabled) {
    if (!p->clock_started && !evbuffer_get_length(p->pcm) && target == 0) {
      t->enabled = t->ended = true;
      result->status = RAOP_APPEND_ACCEPTED;
      result->error = RAOP_APPEND_ERROR_NONE;
    }
  } else if (t->enabled && target == t->accepted &&
             (!t->sources || t->source[t->sources - 1].sealed)) {
    t->ended = true;
    t->end_target = target;
    if (t->next_input == t->inputs) {
      /* A delayed end may follow already packetized compatibility/underrun
       * silence. Its exclusive real boundary never moves to that silence. */
      t->tail_reached = true;
      t->transport_end = t->last_real_end;
      t->padding_left = (352 - p->pts_samples % 352) % 352;
    }
    result->input_end = target;
    result->status = RAOP_APPEND_ACCEPTED;
    result->error = RAOP_APPEND_ERROR_NONE;
  }
  pthread_mutex_unlock(&p->pcm_lock);
}

int
raop_player_compatibility_silence(struct raop_player *p, uint64_t source)
{
  int rc = -1;
  pthread_mutex_lock(&p->pcm_lock);
  struct timeline *t = p->timeline;
  if (t && !t->ended && t->sources && t->source[t->sources - 1].id == source &&
      t->source[t->sources - 1].sealed) {
    t->compatibility_source = source;
    rc = 0;
  }
  pthread_mutex_unlock(&p->pcm_lock);
  return rc;
}

int
raop_player_source(struct raop_player *p, uint64_t source, struct raop_source_snapshot *result)
{
  int found = 0;
  pthread_mutex_lock(&p->pcm_lock);
  struct timeline *t = p->timeline;
  if (t) for (size_t i = 0; i < t->sources; i++) {
    struct source_record *s = &t->source[i];
    if (s->id != source) continue;
    result->source = source;
    result->accepted_frames = s->accepted;
    result->fed_frames = s->fed;
    result->sealed = s->sealed;
    result->target = s->target;
    result->input_end = s->input_end;
    found = 1;
    break;
  }
  pthread_mutex_unlock(&p->pcm_lock);
  return found;
}

int
raop_player_range(struct raop_player *p, uint64_t index, struct raop_range_snapshot *result)
{
  int found = 0;
  pthread_mutex_lock(&p->pcm_lock);
  if (p->timeline && index < p->timeline->ranges) {
    *result = p->timeline->range[index];
    result->index = index;
    found = 1;
  }
  pthread_mutex_unlock(&p->pcm_lock);
  return found;
}

/* Loop-only backend observations. The API dispatches the entire read onto this
 * loop so clock, successful coverage and ledger projection are one observation.
 * A failure freezes the proven prefix before a deferred session can disappear. */
static uint64_t
monotonic_ns(void)
{
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (uint64_t)ts.tv_sec * 1000000000ULL + ts.tv_nsec;
}

void
raop_player_failed(struct raop_player *p, uint64_t error)
{
  pthread_mutex_lock(&p->pcm_lock);
  if (!p->failure.error) {
    raop_transport_progress(p->stream_id, 0, monotonic_ns(), &p->failure);
    p->failure.status = 2;
    p->failure.error = error;
  }
  pthread_mutex_unlock(&p->pcm_lock);
}

int
raop_player_progress(struct raop_player *p, uint64_t source, uint64_t attachment,
                       struct raop_progress_snapshot *result)
{
  return raop_player_progress_at(p, source, attachment, monotonic_ns(), result);
}

/* Same range projection for polling and an admitted cancellation. The caller
 * supplies the original admission time, not the later FLUSH/readiness time. */
int
raop_player_progress_at(struct raop_player *p, uint64_t source, uint64_t attachment,
                        uint64_t captured_ns, struct raop_progress_snapshot *result)
{
  pthread_mutex_lock(&p->pcm_lock);
  if (p->failure.error) {
    *result = p->failure;
    /* A dependency may fail after cancel admission but before its loop callback.
     * Keep failure explicit, but never credit presentation after that cutoff. */
    if (captured_ns < result->captured_ns) {
      uint64_t elapsed = captured_ns > result->schedule_origin_ns && result->schedule_origin_ns
        ? captured_ns - result->schedule_origin_ns : 0;
      uint64_t frames = elapsed / 1000000000ULL * 44100 +
                        elapsed % 1000000000ULL * 44100 / 1000000000ULL;
      if (frames < result->scheduled_frames) result->scheduled_frames = frames;
    }
  }
  else raop_transport_progress(p->stream_id, attachment, captured_ns, result);
  result->source = source;
  result->attachment = attachment;
  result->fed_frames = p->pts_samples;
  struct timeline *t = p->timeline;
  if (t) for (size_t i = 0; i < t->ranges; i++) {
    const struct raop_range_snapshot *r = &t->range[i];
    uint64_t start = r->transport_start > result->coverage_start
      ? r->transport_start : result->coverage_start;
    uint64_t end = r->transport_start + r->frames;
    if (end > result->scheduled_frames) end = result->scheduled_frames;
    if (end <= start) continue;
    if (r->kind == RAOP_RANGE_REAL) {
      result->real_frames += end - start;
      if (r->source == source) result->source_frames += end - start;
    } else result->silence_frames += end - start;
  }
  pthread_mutex_unlock(&p->pcm_lock);
  return 1;
}

void
raop_player_failure(struct raop_player *p, struct raop_progress_snapshot *result)
{
  pthread_mutex_lock(&p->pcm_lock);
  *result = p->failure;
  pthread_mutex_unlock(&p->pcm_lock);
}

/* A captured barrier observes each attachment separately, not the mutable live
 * group or the frozen epoch-wide diagnostic failure. Shared failures settle
 * every attachment at their producer; exclusions cannot hide such a failure. */
int
raop_player_completion_progress(struct raop_player *p, uint64_t source,
  uint64_t attachment, struct raop_progress_snapshot *result, uint64_t *transport_end)
{
  int sealed = 0;
  pthread_mutex_lock(&p->pcm_lock);
  raop_transport_progress(p->stream_id, attachment, monotonic_ns(), result);
  struct timeline *t = p->timeline;
  if (t) {
    for (size_t i = 0; i < t->sources; i++)
      if (t->source[i].id == source)
        sealed = t->source[i].sealed && t->source[i].fed == t->source[i].target;
    for (size_t i = 0; i < t->ranges; i++) {
      const struct raop_range_snapshot *r = &t->range[i];
      if (r->kind != RAOP_RANGE_REAL || r->source != source) continue;
      *transport_end = r->transport_start + r->frames;
      uint64_t start = r->transport_start > result->coverage_start
        ? r->transport_start : result->coverage_start;
      uint64_t end = r->transport_start + r->frames;
      if (end > result->scheduled_frames) end = result->scheduled_frames;
      if (end > start) result->source_frames += end - start;
    }
  }
  pthread_mutex_unlock(&p->pcm_lock);
  return sealed;
}

int
raop_player_ended(struct raop_player *p)
{
  pthread_mutex_lock(&p->pcm_lock);
  int ended = p->timeline && p->timeline->ended;
  pthread_mutex_unlock(&p->pcm_lock);
  return ended;
}

int
raop_player_drained(struct raop_player *p)
{
  pthread_mutex_lock(&p->pcm_lock);
  int result = p->failure.error ? -1 :
    (p->timeline && p->timeline->complete ? 1 : 0);
  pthread_mutex_unlock(&p->pcm_lock);
  return result;
}

/* Ack ends source/range observation lifetime. Compact all three bounded ledgers
 * together, including already dispatched inputs. Never erase a queued suffix.
 * Remaining transport/source offsets stay absolute, not rebased after reclaim. */
void
raop_player_ack_source(struct raop_player *p, uint64_t source)
{
  pthread_mutex_lock(&p->pcm_lock);
  struct timeline *t = p->timeline;
  if (t) {
    struct metadata_marker **slot = &p->metadata_head;
    p->metadata_tail = NULL;
    while (*slot) {
      struct metadata_marker *m = *slot;
      if (m->source == source) { *slot = m->next; metadata_marker_free(m); p->metadata_count--; }
      else { p->metadata_tail = m; slot = &m->next; }
    }
    if (p->metadata_source == source) p->metadata_source = 0;
    for (size_t i = 0; i < t->sources; i++)
      if (t->source[i].id == source && t->source[i].fed != t->source[i].accepted) {
        pthread_mutex_unlock(&p->pcm_lock);
        return; /* failed queued input still owns PCM until ordered cancel */
      }
    size_t n = 0, next = 0;
    for (size_t i = 0; i < t->inputs; i++) {
      if (t->input[i].source == source) continue;
      if (i < t->next_input) next++;
      t->input[n++] = t->input[i];
    }
    t->inputs = n; t->next_input = next;
    n = 0;
    for (size_t i = 0; i < t->ranges; i++) {
      uint64_t owner = t->range_owner[i];
      bool retained = false;
      for (size_t j = 0; j < t->sources; j++)
        if (t->source[j].id == owner && owner != source) retained = true;
      if (retained) {
        t->range_owner[n] = owner;
        t->range[n++] = t->range[i];
      }
    }
    t->ranges = n;
    n = 0;
    for (size_t i = 0; i < t->sources; i++)
      if (t->source[i].id != source) t->source[n++] = t->source[i];
    t->sources = n;
  }
  pthread_mutex_unlock(&p->pcm_lock);
}

/* Loop thread: drop buffered PCM (pause/seek/track-change semantics; the
 * stream clock continues — resume re-feeds from the engine position). */
void
raop_player_flush(struct raop_player *p)
{
  pthread_mutex_lock(&p->pcm_lock);
  evbuffer_drain(p->pcm, evbuffer_get_length(p->pcm));
  metadata_clear(p);
  memset(&p->failure, 0, sizeof(p->failure));
  if (p->timeline && p->timeline->enabled) {
    memset(p->timeline, 0, sizeof(*p->timeline));
  }
  p->pts_samples = 0;
  p->clock_started = false;
  pthread_mutex_unlock(&p->pcm_lock);
}

/* Admission thread fences before cancel returns; loop reopens only after reset
 * and receiver readiness. A tick already removed from ingress belongs to the
 * old epoch; replacement input remains fenced until the loop joins that tick. */
void
raop_player_fence(struct raop_player *p, bool fenced)
{
  pthread_mutex_lock(&p->pcm_lock);
  p->fenced = fenced;
  pthread_mutex_unlock(&p->pcm_lock);
}

/* Loop thread: the device reported CONNECTED — arm the 10 ms timer
 * (OwnTone pb_timer_start from device_activate_cb). The pts clock
 * re-anchors on the first write. Idempotent (STREAMING re-enters here). */
void
raop_player_session_started(struct raop_player *p)
{
  struct itimerspec tick;

  pthread_mutex_lock(&p->pcm_lock);
  bool complete = p->timeline && p->timeline->complete;
  pthread_mutex_unlock(&p->pcm_lock);
  if (complete) return;
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
    raop_discard_pending_input(p->stream_id);
  p->fed_in_epoch = false;

  memset(&zero, 0, sizeof(zero));
  timerfd_settime(p->timer_fd, 0, &zero, NULL);
  event_del(p->timer_ev);
}

void
raop_player_drain_complete(struct raop_player *p)
{
  pthread_mutex_lock(&p->pcm_lock);
  struct timeline *t = p->timeline;
  struct raop_progress_snapshot progress;
  bool complete = t && t->ended && t->tail_reached && !t->padding_left &&
    !p->failure.error && !evbuffer_get_length(p->pcm);
  if (complete) {
    raop_transport_progress(p->stream_id, 0, monotonic_ns(), &progress);
    complete = progress.participants && progress.status == 1 &&
      progress.submitted_frames >= t->transport_end &&
      progress.scheduled_frames >= t->transport_end;
  }
  if (complete) t->complete = true;
  pthread_mutex_unlock(&p->pcm_lock);
  if (complete) raop_player_session_stopped(p);
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
