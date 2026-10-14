/* Exercise the actual evrtsp serializer/writer/close boundary, no receiver.
 * Use the vendored internal header, never a copied private layout. */
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/queue.h>
#include <unistd.h>
#include <time.h>
#include <event2/event.h>
#include <event2/buffer.h>
#include "../vendor/evrtsp/evrtsp.h"
#include "../vendor/evrtsp/rtsp-internal.h"

struct observation {
  int fd, peer, done, sent, callbacks, cipher_calls, cipher_fail;
  unsigned char *wire;
  size_t bytes, cap;
};
static void *reader(void *arg)
{
  struct observation *o = arg;
  ssize_t n;
  while ((n = read(o->peer, o->wire + o->bytes, o->cap - o->bytes)) > 0) {
    o->bytes += n;
    assert(o->bytes < o->cap);
  }
  assert(n == 0);
  return NULL;
}
static void old_request(struct evrtsp_request *req, void *arg)
{
  ((struct observation *)arg)->callbacks++;
}
static void old_close(struct evrtsp_connection *con, void *arg)
{
  ((struct observation *)arg)->callbacks++;
}
static void done(void *arg, int sent)
{
  struct observation *o = arg;
  assert(++o->done == 1);
  assert(fcntl(o->fd, F_GETFD) == -1 && errno == EBADF);
  o->sent = sent;
}
static int cipher(struct evbuffer *out, struct evbuffer *in, void *arg, int encrypt)
{
  struct observation *o = arg;
  unsigned char data[1024];
  assert(encrypt);
  o->cipher_calls++;
  if (o->cipher_fail) return -1;
  size_t n;
  while ((n = evbuffer_remove(in, data, sizeof(data))) > 0) {
    for (size_t i = 0; i < n; i++) data[i] ^= 0x5a;
    if (evbuffer_add(out, data, n)) return -1;
  }
  return 0;
}
static double monotonic(void)
{
  struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts);
  return ts.tv_sec + ts.tv_nsec / 1e9;
}
static void scenario(const char *mode)
{
  int fds[2], sndbuf = 4096;
  assert(socketpair(AF_UNIX, SOCK_STREAM, 0, fds) == 0);
  assert(fcntl(fds[0], F_SETFL, O_NONBLOCK) == 0);
  assert(setsockopt(fds[0], SOL_SOCKET, SO_SNDBUF, &sndbuf, sizeof(sndbuf)) == 0);
  struct event_base *base = event_base_new(); assert(base);
  struct evrtsp_connection *con = evrtsp_connection_new("127.0.0.1", 1); assert(con);
  evrtsp_connection_set_base(con, base);
  con->fd = fds[0]; con->state = EVCON_WRITING;
  struct observation o = { .fd = fds[0], .peer = fds[1], .cap = 300000 };
  o.wire = calloc(1, o.cap); assert(o.wire);
  struct evrtsp_request *old = evrtsp_request_new(old_request, &o); assert(old);
  old->evcon = con;
  TAILQ_INSERT_TAIL(&con->requests, old, next);
  evrtsp_connection_set_closecb(con, old_close, &o);
  int encrypted = !strcmp(mode, "cipher") || !strcmp(mode, "cipher-fail");
  if (encrypted) evrtsp_connection_set_ciphercb(con, cipher, &o);
  o.cipher_fail = !strcmp(mode, "cipher-fail");
  const size_t body = 262144;
  const char *prefix = "SET_PARAMETER rtsp://fixture/old RTSP/1.0\r\nContent-Length: 262144\r\n\r\n";
  size_t before = strlen(prefix) + body;
  unsigned char *expected = malloc(before + 256); assert(expected);
  memcpy(expected, prefix, strlen(prefix)); memset(expected + strlen(prefix), 'x', body);
  for (size_t i = 0; i < before; i++) {
    unsigned char byte = expected[i] ^ (encrypted ? 0x5a : 0);
    assert(evbuffer_add(con->output_raw, &byte, 1) == 0);
  }
  int wrote = evbuffer_write(con->output_raw, fds[0]);
  assert(wrote > 0 && evbuffer_get_length(con->output_raw) > 0);
  struct evrtsp_request *last = evrtsp_request_new(NULL, NULL); assert(last);
  assert(evrtsp_add_header(last->output_headers, "Session", "fixture") == 0);
  assert(evrtsp_add_header(last->output_headers, "CSeq", "2") == 0);
  const char *final = "TEARDOWN rtsp://fixture/new RTSP/1.0\r\nSession: fixture\r\nCSeq: 2\r\n\r\n";
  memcpy(expected + before, final, strlen(final));
  int draining = !strcmp(mode, "partial") || !strcmp(mode, "cipher");
  pthread_t thread;
  if (draining) assert(pthread_create(&thread, NULL, reader, &o) == 0);
  if (!strcmp(mode, "dead")) { close(fds[1]); o.peer = -1; }
  if (!strcmp(mode, "connecting")) con->state = EVCON_CONNECTING;
  if (!strcmp(mode, "no-session")) { evrtsp_request_free(last); last = NULL; }
  double start = monotonic();
  evrtsp_connection_release(con, last, EVRTSP_REQ_TEARDOWN, "rtsp://fixture/new", done, &o);
  event_base_dispatch(base);
  double elapsed = monotonic() - start;
  assert(o.done == 1 && o.callbacks == 0);
  if (draining) {
    assert(pthread_join(thread, NULL) == 0);
    if (encrypted) for (size_t i = 0; i < o.bytes; i++) o.wire[i] ^= 0x5a;
    assert(o.sent == 0 && o.bytes == before + strlen(final));
    assert(memcmp(o.wire, expected, o.bytes) == 0);
    if (encrypted) assert(o.cipher_calls == 1);
  } else {
    assert(o.sent == -1);
    if (!strcmp(mode, "deadline")) assert(elapsed >= 4.8 && elapsed < 7.0);
    else assert(elapsed < 1.0);
  }
  if (o.peer >= 0) close(o.peer);
  event_base_free(base); free(o.wire); free(expected);
  printf("RTSP-RELEASE-OK mode=%s elapsed=%.3f callback-after-close=1 old-callbacks=0\n", mode, elapsed);
}
int main(void)
{
  signal(SIGPIPE, SIG_IGN);
  const char *modes[] = { "partial", "cipher", "cipher-fail", "deadline", "dead", "connecting", "no-session" };
  for (size_t i = 0; i < sizeof(modes)/sizeof(modes[0]); i++) scenario(modes[i]);
  return 0;
}
