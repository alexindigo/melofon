/* Test-only producer/inspection surface over the ACTUAL bridge and native key
 * clear helper. Never compiled into the product library. No credential output. */
#include "../ffi.c"
/* The public bridge and static backend writer share a name in separate TUs. */
#define raop_write probe_backend_write
#include "../vendor/outputs/raop.c"
#undef raop_write

/* The test owns all handles in this independently built library. No device or
 * protocol session is required to drive the real db_speaker_save export hook. */
int probe_pairing_change(const char *key)
{
  struct output_device device = {0};
  pthread_mutex_lock(&rt.lock);
  if (rt.handles_list) device.id = rt.handles_list->id;
  pthread_mutex_unlock(&rt.lock);
  device.auth_key = (char *)key;
  return db_speaker_save(&device);
}

/* Native path shared by both verification callbacks and malformed-input reset.
 * Only private stack data is changed; production callbacks stay on their loop. */
int probe_pairing_clear(int code)
{
  struct output_device device = {0};
  struct evrtsp_request request = { .response_code = code };
  pthread_mutex_lock(&rt.lock);
  if (rt.handles_list) device.id = rt.handles_list->id;
  pthread_mutex_unlock(&rt.lock);
  device.auth_key = malloc(129);
  if (!device.auth_key) return -1;
  memset(device.auth_key, 'a', 128); device.auth_key[128] = 0;
  raop_pair_key_clear(&device, code ? &request : NULL);
  int cleared = device.auth_key == NULL;
  if (device.auth_key) {
    explicit_bzero(device.auth_key, 128); free(device.auth_key);
  }
  return cleared;
}

int probe_pairing_overflow_events(void)
{
  pthread_mutex_lock(&rt.lock);
  raop_t *h = rt.handles_list;
  if (h) for (int i = 0; i < 100; i++) event_push(h, "stopped");
  pthread_mutex_unlock(&rt.lock);
  return h ? 0 : -1;
}

uint64_t probe_pairing_pending(void)
{
  uint64_t result = 0;
  pthread_mutex_lock(&rt.lock);
  if (rt.handles_list) {
    pthread_mutex_lock(&rt.handles_list->credential_lock);
    result = rt.handles_list->credential_pending;
    pthread_mutex_unlock(&rt.handles_list->credential_lock);
  }
  pthread_mutex_unlock(&rt.lock);
  return result;
}

struct verify_probe {
  pthread_mutex_t lock;
  pthread_cond_t done;
  int step, code, result, completed;
};

static void probe_verify_cb(evutil_socket_t fd, short what, void *arg)
{
  (void)fd; (void)what;
  struct verify_probe *p = arg;
  raop_t *h = rt.handles_list;
  struct raop_session *rs = calloc(1, sizeof(*rs));
  struct evrtsp_request req = { .response_code = p->code,
                              .response_code_line = "Probe" };
  if (!h || h->device || !rs) abort();
  h->device = calloc(1, sizeof(*h->device));
  if (!h->device) abort();
  h->device->id = h->id;
  h->device->auth_key = malloc(129);
  if (!h->device->auth_key) abort();
  memset(h->device->auth_key, 'a', 128); h->device->auth_key[128] = 0;
  rs->device_id = h->id; rs->server_fd = -1; rs->reqs_in_flight = 1;
  rs->devname = strdup("Pairing probe");
  rs->next = raop_sessions; raop_sessions = rs;
  if (p->step == 1) raop_cb_pair_verify_step1(p->code ? &req : NULL, rs);
  else if (p->step == 2) raop_cb_pair_verify_step2(p->code ? &req : NULL, rs);
  else {
    explicit_bzero(h->device->auth_key, 128);
    strcpy(h->device->auth_key, "invalid");
    if (raop_pair_verify(rs) != -1) abort();
    session_cleanup(rs);
  }
  p->result = h->device->auth_key == NULL;
  device_free(h);
  pthread_mutex_lock(&p->lock); p->completed = 1;
  pthread_cond_signal(&p->done); pthread_mutex_unlock(&p->lock);
}

int probe_pairing_verify(int step, int code)
{
  struct verify_probe p = { .lock = PTHREAD_MUTEX_INITIALIZER,
    .done = PTHREAD_COND_INITIALIZER, .step = step, .code = code };
  struct timeval zero = {0};
  pthread_mutex_lock(&p.lock);
  if (event_base_once(evbase_player, -1, EV_TIMEOUT, probe_verify_cb, &p, &zero)) abort();
  while (!p.completed) pthread_cond_wait(&p.done, &p.lock);
  pthread_mutex_unlock(&p.lock);
  pthread_mutex_destroy(&p.lock); pthread_cond_destroy(&p.done);
  return p.result;
}
