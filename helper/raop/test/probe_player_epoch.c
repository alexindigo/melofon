/* Standalone native API regression. Include the actual backend for on-loop
 * observations; compile the other helper sources directly, never raop.o/.so.
 * No copied handle/player layouts or production introspection exports. */
#include <poll.h>
#include <pthread.h>
#include <stdlib.h>
#include <string.h>
#include "../ffi.h"
#define raop_write raop_vendor_write
#include "../vendor/outputs/raop.c"
#undef raop_write

extern void raop_ffi_on_state(uint64_t, enum output_device_state);
extern struct output_device *raop_ffi_device_find(uint64_t);

/* These identities are captured, compared and used only on the loop thread. */
static struct raop_session *peer;
static struct raop_master_session *master;
static uint64_t a_id;

enum observation { PEER_READY, BOTH_READY, STOPPED, PENDING, SNAPSHOT,
                   REPLAY_START, REPLAY_STOP, FLUSH_DONE };
struct checkpoint {
  pthread_mutex_t lock;
  pthread_cond_t cond;
  enum observation kind;
  raop_t *a;
  const char *name;
  const uint8_t *expected;
  unsigned expected_frames;
  unsigned frames;
  size_t bytes;
  int bytes_match, stopped_seen, connected_seen, result, done;
  struct timespec deadline;
};

static struct raop_session *named_session(const char *name)
{
  struct raop_session *s;
  for (s = raop_sessions; s; s = s->next)
    if (strcmp(s->devname, name) == 0) return s;
  return NULL;
}

static int connected(struct raop_session *s)
{
  return s && !s->retiring && !s->failure_pending &&
    (s->state == RAOP_STATE_CONNECTED || s->state == RAOP_STATE_STREAMING);
}

static void observe_cb(evutil_socket_t fd, short what, void *arg)
{
  struct checkpoint *c = arg;
  struct raop_session *a = named_session("epoch-A");
  struct raop_session *b = named_session("epoch-B");
  struct timespec now;
  struct timeval retry = { 0, 1000 };
  uint8_t bytes[352 * 4];
  char message[128];
  int ready = 0, error = 0;
  (void)fd; (void)what;

  if (c->kind == PEER_READY) {
    if (connected(b)) { peer = b; master = b->master_session; ready = 1; }
  } else if (!connected(b) || b != peer || b->master_session != master) {
    error = 1;
  } else {
    if (c->kind == REPLAY_START) {
      /* Replay the existing internal state notification, not a fault switch. */
      raop_ffi_on_state(a_id, OUTPUT_STATE_CONNECTED);
      raop_ffi_on_state(a_id, OUTPUT_STATE_STREAMING);
      raop_ffi_on_state(a_id, OUTPUT_STATE_CONNECTED);
      raop_ffi_on_state(a_id, OUTPUT_STATE_STREAMING);
    } else if (c->kind == REPLAY_STOP) {
      raop_ffi_on_state(a_id, OUTPUT_STATE_STOPPED);
      raop_ffi_on_state(a_id, OUTPUT_STATE_STOPPED);
    }
    while (raop_poll(c->a, message, sizeof(message)) > 0) {
      printf("{\"eventA\":%s}\n", message);
      if (strstr(message, "\"value\":\"stopped\"")) c->stopped_seen = 1;
      if (strstr(message, "\"value\":\"connected\"")) c->connected_seen = 1;
      if (strstr(message, "\"value\":\"failed\"")) error = 1;
    }
    switch (c->kind) {
      case BOTH_READY:
        ready = connected(a) && c->connected_seen;
        if (ready) {
          if (a->master_session != master || (a_id && a_id != a->device_id)) error = 1;
          a_id = a->device_id;
        }
        break;
      case STOPPED:
        ready = !a && !raop_ffi_device_find(a_id) && c->stopped_seen;
        break;
      case FLUSH_DONE:
        ready = connected(a) && a->reqs_in_flight == 0 && c->connected_seen;
        break;
      default: ready = 1; break;
    }
  }

  if (master && b == peer) {
    c->frames = master->input_buffer_samples;
    c->bytes = evbuffer_get_length(master->input_buffer);
    c->bytes_match = c->bytes == c->expected_frames * 4 &&
      (c->bytes == 0 || (c->expected && c->bytes <= sizeof(bytes) &&
       evbuffer_copyout(master->input_buffer, bytes, c->bytes) == (ssize_t)c->bytes &&
       memcmp(bytes, c->expected, c->bytes) == 0));
    if (c->kind == PENDING)
      ready = ready && c->frames == c->expected_frames && c->bytes_match;
  }
  clock_gettime(CLOCK_MONOTONIC, &now);
  if (!ready && !error && (now.tv_sec < c->deadline.tv_sec ||
      (now.tv_sec == c->deadline.tv_sec && now.tv_nsec < c->deadline.tv_nsec))) {
    if (event_base_once(evbase_player, -1, EV_TIMEOUT, observe_cb, c, &retry) == 0) return;
    error = 1;
  }
  printf("{\"checkpoint\":\"%s\",\"pendingBytes\":%zu,\"pendingFrames\":%u,"
         "\"expectedFrames\":%u,\"bytesMatch\":%s,\"peerConnected\":%s,"
         "\"sameMaster\":%s,\"aLocalReleased\":%s,\"ok\":%s}\n",
         c->name, c->bytes, c->frames, c->expected_frames,
         c->bytes_match ? "true" : "false", connected(b) ? "true" : "false",
         b == peer && b && b->master_session == master ? "true" : "false",
         !a && a_id && !raop_ffi_device_find(a_id) ? "true" : "false",
         ready && !error ? "true" : "false");
  pthread_mutex_lock(&c->lock);
  c->result = ready && !error ? 0 : -1;
  c->done = 1;
  pthread_cond_signal(&c->cond);
  pthread_mutex_unlock(&c->lock);
}

static int checkpoint(raop_t *a, enum observation kind, const char *name,
                      const uint8_t *expected, unsigned frames, unsigned *observed)
{
  struct checkpoint c = { .kind = kind, .a = a, .name = name,
                          .expected = expected, .expected_frames = frames };
  struct timeval zero = { 0, 0 };
  int result;
  pthread_mutex_init(&c.lock, NULL);
  pthread_cond_init(&c.cond, NULL);
  clock_gettime(CLOCK_MONOTONIC, &c.deadline);
  c.deadline.tv_sec += 10;
  pthread_mutex_lock(&c.lock);
  result = event_base_once(evbase_player, -1, EV_TIMEOUT, observe_cb, &c, &zero);
  if (result == 0) {
    while (!c.done) pthread_cond_wait(&c.cond, &c.lock);
    result = c.result;
  }
  if (observed) *observed = c.frames;
  pthread_mutex_unlock(&c.lock);
  pthread_cond_destroy(&c.cond);
  pthread_mutex_destroy(&c.lock);
  return result;
}

static void pcm(uint8_t *out, unsigned frames, int source, unsigned offset)
{
  unsigned i;
  for (i = 0; i < frames; i++) {
    int16_t l = source ? 1000 + (i + offset) * 13 : -12000 + (i + offset) * 7;
    int16_t r = source ? -2000 - (i + offset) * 17 : 14000 - (i + offset) * 11;
    out[i * 4] = (uint16_t)l & 255; out[i * 4 + 1] = (uint16_t)l >> 8;
    out[i * 4 + 2] = (uint16_t)r & 255; out[i * 4 + 3] = (uint16_t)r >> 8;
  }
}

static int start(raop_t *h, int port, const char *name)
{
  return raop_start(h, "127.0.0.1", port, name, 100, 3, 0, 0, 0, 0, 0, 0, "", "");
}

#define CHECK(x) do { if (!(x)) { fprintf(stderr, "epoch setup/guard failure: %s\n", #x); \
                                  result = 2; goto cleanup; } } while (0)

int main(int argc, char **argv)
{
  raop_t *a = NULL, *b = NULL;
  uint8_t apcm[400], bpcm[452 * 4];
  unsigned post = 0, tail = 0;
  int result = 0, freed_a = -1, freed_b = -1;
  int reuse, successive, repeated, notifications, flush, read_ahead, never_fed;
  char captured[32];
  struct pollfd input = { .fd = STDIN_FILENO, .events = POLLIN };
  if (argc != 4) return 2;
  reuse = strcmp(argv[1], "reuse") == 0;
  successive = strcmp(argv[1], "successive") == 0;
  repeated = strcmp(argv[1], "repeated-stop") == 0;
  notifications = strcmp(argv[1], "notifications") == 0;
  flush = strcmp(argv[1], "flush") == 0;
  read_ahead = strcmp(argv[1], "read-ahead") == 0;
  never_fed = strcmp(argv[1], "never-fed") == 0;
  if (!(reuse || successive || repeated || notifications || flush || read_ahead || never_fed)) return 2;
  setvbuf(stdout, NULL, _IOLBF, 0);
  pcm(apcm, 100, 0, 0); pcm(bpcm, 452, 1, 0);
  CHECK((a = raop_new()) && (b = raop_new()));
  CHECK(start(b, atoi(argv[3]), "epoch-B") == 0);
  CHECK(checkpoint(a, PEER_READY, "B-connected", NULL, 0, NULL) == 0);
  if (read_ahead) {
    CHECK(raop_write(a, apcm, sizeof(apcm)) == sizeof(apcm));
    CHECK(checkpoint(a, PENDING, "read-ahead-not-backend-fed", NULL, 0, NULL) == 0);
  }
  CHECK(start(a, atoi(argv[2]), "epoch-A") == 0);
  CHECK(checkpoint(a, BOTH_READY, "A-B-shared-connected", NULL, 0, NULL) == 0);
  if (!never_fed) {
    if (!read_ahead) CHECK(raop_write(a, apcm, sizeof(apcm)) == sizeof(apcm));
    CHECK(checkpoint(a, PENDING, "A-first-tail", apcm, 100, NULL) == 0);
    if (notifications) {
      CHECK(checkpoint(a, REPLAY_START, "active-notifications", apcm, 100, NULL) == 0);
      CHECK(checkpoint(a, PENDING, "tail-after-notifications", apcm, 100, NULL) == 0);
    }
    if (flush) {
      CHECK(raop_flush(a) == 0);
      CHECK(checkpoint(a, FLUSH_DONE, "active-FLUSH-completed", apcm, 100, NULL) == 0);
      CHECK(checkpoint(a, PENDING, "tail-after-FLUSH", apcm, 100, NULL) == 0);
    }
    CHECK(raop_teardown(a) == 0);
    CHECK(checkpoint(a, STOPPED, "first-feeding-stop", NULL, 0, &tail) == 0);
    CHECK(tail == 0);
    if (successive) {
      CHECK(start(a, atoi(argv[2]), "epoch-A") == 0);
      CHECK(checkpoint(a, BOTH_READY, "second-feeding-epoch-connected", NULL, 0, NULL) == 0);
      pcm(apcm, 100, 0, 100);
      CHECK(raop_write(a, apcm, sizeof(apcm)) == sizeof(apcm));
      CHECK(checkpoint(a, PENDING, "A-second-tail", apcm, 100, NULL) == 0);
      CHECK(raop_teardown(a) == 0);
      CHECK(checkpoint(a, STOPPED, "second-feeding-stop", NULL, 0, &tail) == 0);
      CHECK(tail == 0);
    }
    if (reuse) {
      CHECK(start(a, atoi(argv[2]), "epoch-A") == 0);
      CHECK(checkpoint(a, BOTH_READY, "same-A-nonfeeding-epoch-connected", NULL, 0, NULL) == 0);
    }
  }
  CHECK(raop_write(b, bpcm, 400) == 400);
  CHECK(checkpoint(a, PENDING, "B-prefix-before-stop", bpcm, 100, NULL) == 0);
  if (reuse || never_fed) {
    CHECK(raop_teardown(a) == 0);
    CHECK(checkpoint(a, STOPPED, "B-prefix-after-stop", bpcm, 100, &post) == 0);
  } else if (repeated) {
    CHECK(raop_teardown(a) == 0);
    CHECK(checkpoint(a, REPLAY_STOP, "B-prefix-after-repeated-stop", bpcm, 100, &post) == 0);
  } else {
    CHECK(checkpoint(a, SNAPSHOT, "B-surviving-prefix", bpcm, 100, &post) == 0);
  }
  /* Keep the red loss observable but continue to the consumer. An extra
   * 100-frame continuation lets red form B[100..451], not just time out. */
  CHECK(post == 0 || post == 100);
  CHECK(raop_write(b, bpcm + 400, 252 * 4) == 252 * 4);
  tail = (post + 252) % 352;
  CHECK(checkpoint(a, PENDING, "B-following-252-paced", bpcm + (352 - tail) * 4, tail, NULL) == 0);
  CHECK(raop_write(b, bpcm + 352 * 4, 400) == 400);
  tail = (post + 352) % 352;
  CHECK(checkpoint(a, PENDING, "B-continuation-paced", bpcm + (452 - tail) * 4, tail, NULL) == 0);
  puts("{\"packetReady\":true}");
  CHECK(poll(&input, 1, 30000) == 1);
  CHECK(fgets(captured, sizeof(captured), stdin) && strcmp(captured, "captured\n") == 0);
cleanup:
  if (a) freed_a = raop_free(a);
  if (b) freed_b = raop_free(b);
  printf("{\"cleanup\":true,\"freeA\":%d,\"freeB\":%d}\n", freed_a, freed_b);
  return result ? result : (freed_a == 0 && freed_b == 0 ? 0 : 2);
}
