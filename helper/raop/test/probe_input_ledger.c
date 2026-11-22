/* Long fragmented source through the public shipping ABI, with a real pacer.
 * Admission retry/timeout follows .test-tmp/listen-stall/diagnose.ts. */
#include <assert.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include "../ffi.h"

static uint64_t now_ms(void)
{
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (uint64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

static void append(raop_stream_t *s, uint64_t epoch, uint64_t source,
                   uint64_t segment, const uint8_t *pcm, size_t frames)
{
  size_t offset = 0;
  uint64_t deadline = now_ms() + 5000;
  while (offset < frames) {
    struct raop_source_append_result r;
    assert(raop_stream_append_source(s, epoch, source, segment, pcm + offset * 4,
                                   (frames - offset) * 4, &r) == 0);
    assert(r.status == RAOP_APPEND_ACCEPTED || r.status == RAOP_APPEND_BACKPRESSURE);
    offset += r.accepted_frames;
    if (offset < frames && now_ms() > deadline) {
      struct raop_source_snapshot snapshot;
      assert(raop_stream_source(s, epoch, source, &snapshot) == 1);
      fprintf(stderr, "stalled chunk=%llu accepted=%llu fed=%llu sealed=%llu\n",
        (unsigned long long)segment, (unsigned long long)snapshot.accepted_frames,
        (unsigned long long)snapshot.fed_frames, (unsigned long long)snapshot.sealed);
      exit(1);
    }
    if (offset < frames) usleep(5000);
  }
}

int main(int argc, char **argv)
{
  assert(argc == 4);
  size_t frames = strtoul(argv[2], NULL, 10), chunks = strtoul(argv[3], NULL, 10);
  int16_t *pcm = malloc(frames * 4);
  assert(pcm);
  for (size_t i = 0; i < frames * 2; i++) pcm[i] = 2000;
  raop_stream_t *s = raop_stream_new();
  assert(s);
  raop_t *a = raop_stream_attach(s);
  assert(a);
  uint64_t epoch = raop_stream_epoch(s);
  assert(raop_start(a, "127.0.0.1", atoi(argv[1]), "input-ledger", 100,
                   3, 0, 0, 0, 0, 0, 0, "", "") == 0);
  for (size_t i = 1; i <= chunks; i++) append(s, epoch, 1, i, (uint8_t *)pcm, frames);
  struct raop_marker_result marker;
  assert(raop_stream_seal(s, epoch, 1, frames * chunks, &marker) == 0);
  assert(marker.status == RAOP_APPEND_ACCEPTED);
  for (size_t i = 0; i < frames * 2; i++) pcm[i] = -3000;
  append(s, epoch, 2, chunks + 1, (uint8_t *)pcm, 353);
  assert(raop_stream_seal(s, epoch, 2, 353, &marker) == 0);
  assert(marker.status == RAOP_APPEND_ACCEPTED);
  assert(raop_stream_end(s, epoch, frames * chunks + 353, &marker) == 0);
  assert(marker.status == RAOP_APPEND_ACCEPTED);
  uint64_t deadline = now_ms() + 10000;
  while (raop_stream_drained(s, epoch) == 0) { assert(now_ms() < deadline); usleep(5000); }
  for (uint64_t source = 1; source <= 2; source++) {
    struct raop_completion_result result;
    assert(raop_stream_completion_poll(s, epoch, source, 1, &result) == 1);
    assert(result.status == 1 && result.target == (source == 1 ? frames * chunks : 353));
  }
  struct raop_range_snapshot range;
  uint64_t count = 0;
  while (raop_stream_range(s, epoch, count, &range) == 1) count++;
  assert(count <= 4); /* two real sources, final padding and drain, not chunks */
  printf("INPUT-LEDGER-READY frames=%zu chunks=%zu ranges=%llu completed=2\n",
         frames * chunks, chunks, (unsigned long long)count);
  fflush(stdout);
  /* The receiver observes the scheduled real tail before TEARDOWN legitimately
   * discards still-future drain silence. Join capture, then prove native cleanup. */
  struct pollfd input = { .fd = STDIN_FILENO, .events = POLLIN };
  char captured[32];
  assert(poll(&input, 1, 30000) == 1);
  assert(fgets(captured, sizeof(captured), stdin) && strcmp(captured, "captured\n") == 0);
  assert(raop_stream_completion_ack(s, epoch, 1, frames * chunks, 1) == 0);
  assert(raop_stream_completion_ack(s, epoch, 2, 353, 1) == 0);
  assert(raop_free(a) == 0);
  assert(raop_stream_free(s) == 0);
  free(pcm);
  printf("INPUT-LEDGER-OK frames=%zu chunks=%zu ranges=%llu completed=2\n",
         frames * chunks, chunks, (unsigned long long)count);
  return 0;
}
