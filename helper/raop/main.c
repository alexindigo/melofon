/* main.c — melofon-raop: AirPlay 1 (RAOP) sender helper for Melofon.
 *
 * Wraps OwnTone's raop.c (RTSP + RTP + ALAC, vendored under vendor/) as a
 * small single-device process so the Deno server never touches RTSP/RTP
 * itself. The helper never opens a database and never reads a config file;
 * it is driven entirely by its stdin:
 *
 *   frame  := [u32 BE length][u8 type][payload]
 *   type J := payload is a JSON command:
 *               {"cmd":"start","host":"192.0.2.10","port":7000,
 *                "name":"Kitchen ATV","volume":100,
 *                "devtype":"appletv","encrypt":false}
 *               {"cmd":"volume","volume":42}
 *               {"cmd":"flush"}        — drop buffered PCM, FLUSH the device
 *               {"cmd":"teardown"}     — TEARDOWN the session
 *               {"cmd":"pin","pin":"1234"} — device showed a PIN
 *   type P := payload is raw PCM (44100 Hz, s16le, stereo interleaved)
 *
 * Events are JSON lines on stdout, one per line:
 *   {"event":"state","value":"starting|connected|stopped|failed|password"}
 * ("password" = the device wants a password or shows a PIN — the server maps
 * it to OwnTone's needs_auth_key). Logs go to stderr (DPRINTF, --verbose).
 *
 * Pacing follows OwnTone's player: a 10 ms tick (PLAYER_TICK_INTERVAL) writes
 * up to 441 samples per tick to the RAOP session; the pts clock is the count
 * of samples written, so rtptime stays continuous across flush/resume. PCM is
 * buffered eagerly (a track is tens of MB) with a high-water mark that stops
 * stdin reads until the buffer drains.
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
#include <fcntl.h>
#include <netdb.h>
#include <arpa/inet.h>

#include <event2/event.h>
#include <event2/buffer.h>
#include <event2/util.h>
#include <gcrypt.h>
#include <json-c/json.h>

#include "logger.h"
#include "misc.h"
#include "outputs.h"

/* The RAOP output backend (raop.c). */
extern struct output_definition output_raop;

/* Globals the vendored code expects (see stubs.c). */
struct event_base *evbase_player;
struct output_device *helper_device;

/* stubs.c routes outputs_cb() here. */
void helper_on_state(enum output_device_state state);

void helper_logger_set_severity(int severity);

/* raop.c's private struct raop_extra, mirrored so the helper can attach one
 * to a manually-registered device (there is no mDNS in the helper). Layout
 * must match raop.c: enum devtype; uint16 wanted_metadata; bool encrypt;
 * bool supports_auth_setup. */
struct raop_extra_mirror
{
  int devtype;
  uint16_t wanted_metadata;
  bool encrypt;
  bool supports_auth_setup;
};

/* raop.c enum raop_devtype values. */
#define RDEV_APEX1   0
#define RDEV_APEX2   1
#define RDEV_APEX3   2
#define RDEV_APPLETV 3
#define RDEV_APPLETV4 4
#define RDEV_HOMEPOD 5
#define RDEV_OTHER   6

#define RAOP_PORT_DEFAULT 7000

/* OwnTone player's tick (player.c): 10 ms. */
#define TICK_MS        10
#define TICK_SAMPLES   441  /* 44100 Hz * 10 ms */
#define TICK_BYTES     (TICK_SAMPLES * 4) /* s16 stereo */

/* Frame length sanity cap — protocol desync guard, not a buffer limit. */
#define FRAME_MAX (512 * 1024 * 1024)

static struct event_base *base;
static struct event *tick_ev;

/* PCM frames are read eagerly (a track is tens of MB) so commands are never
 * stuck behind unread audio — flush/teardown stay instant. */
static struct evbuffer *stdin_buf;  /* unparsed framing bytes */
static struct evbuffer *pcm_buf;    /* decoded PCM awaiting pacing */

static uint64_t pts_samples;        /* stream clock: samples written */

static enum output_device_state helper_state = OUTPUT_STATE_STOPPED;

static void poll_stdin(void);
static void tick_cb(evutil_socket_t fd, short what, void *arg);

/* ------------------------------------------------------------------ events */

void
helper_on_state(enum output_device_state state)
{
  const char *value;

  helper_state = state;

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

  printf("{\"event\":\"state\",\"value\":\"%s\"}\n", value);
  fflush(stdout);

  if (state == OUTPUT_STATE_FAILED || state == OUTPUT_STATE_STOPPED)
    {
      /* A stop the device/raop initiated: drop anything buffered so a later
       * start resumes from the next start command's fresh decode. */
      if (state == OUTPUT_STATE_FAILED)
        evbuffer_drain(pcm_buf, evbuffer_get_length(pcm_buf));
    }
}

/* ------------------------------------------------------------------- pacing */

/* 10 ms tick: poll stdin, then feed up to one tick's worth of PCM to the
 * RAOP session, with the pts stream clock advancing by the samples actually
 * written. */
static void
tick_cb(evutil_socket_t fd, short what, void *arg)
{
  struct output_buffer obuf;
  uint8_t scratch[TICK_BYTES];
  size_t avail;
  size_t n;
  int samples;

  (void)fd; (void)what; (void)arg;

  poll_stdin();

  if (helper_state != OUTPUT_STATE_CONNECTED
      && helper_state != OUTPUT_STATE_STREAMING)
    return;

  avail = evbuffer_get_length(pcm_buf);
  if (avail < 4)
    return;

  n = avail > TICK_BYTES ? TICK_BYTES : (avail & ~(size_t)3);
  if (evbuffer_remove(pcm_buf, scratch, n) < 0)
    return;

  samples = (int)(n / 4);

  memset(&obuf, 0, sizeof(obuf));
  obuf.data[0].buffer = scratch;
  obuf.data[0].bufsize = n;
  obuf.data[0].samples = samples;
  obuf.data[0].quality.sample_rate = 44100;
  obuf.data[0].quality.bits_per_sample = 16;
  obuf.data[0].quality.channels = 2;
  /* obuf.data[1].buffer = NULL terminates the quality array (raop_write). */

  obuf.pts.tv_sec = (time_t)(pts_samples / 44100);
  obuf.pts.tv_nsec = (long)((pts_samples % 44100) * 1000000000ULL / 44100);

  output_raop.write(&obuf);

  pts_samples += (uint64_t)samples;
}

/* ------------------------------------------------------------------ commands */

static void
device_free(void)
{
  if (!helper_device)
    return;

  if (helper_device->extra_device_info)
    {
      free(helper_device->extra_device_info);
      helper_device->extra_device_info = NULL;
    }

  outputs_device_free(helper_device);
  helper_device = NULL;
}

/* Resolve host (name or numeric) to a numeric v4/v6 string for inet_pton. */
static char *
resolve_address(const char *host)
{
  struct addrinfo hints;
  struct addrinfo *res = NULL;
  struct addrinfo *ai;
  char *out = NULL;
  int ret;

  memset(&hints, 0, sizeof(hints));
  hints.ai_family = AF_UNSPEC;
  hints.ai_socktype = SOCK_STREAM;

  ret = getaddrinfo(host, NULL, &hints, &res);
  if (ret != 0)
    {
      DPRINTF(E_LOG, L_RAOP, "Cannot resolve '%s': %s\n", host, gai_strerror(ret));
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

static int
cmd_start(struct json_object *args)
{
  struct json_object *jval;
  const char *host = NULL;
  const char *name = NULL;
  const char *devtype = "appletv";
  struct output_device *dev;
  struct raop_extra_mirror *re;
  char *address;
  int port = RAOP_PORT_DEFAULT;
  int volume = 100;
  bool encrypt = false;
  int ret;

  if (!json_object_object_get_ex(args, "host", &jval))
    return -1;
  host = json_object_get_string(jval);
  if (!host || !*host)
    return -1;

  if (json_object_object_get_ex(args, "port", &jval))
    port = json_object_get_int(jval);
  if (port <= 0 || port > 65535)
    port = RAOP_PORT_DEFAULT;

  if (json_object_object_get_ex(args, "name", &jval))
    name = json_object_get_string(jval);
  if (!name || !*name)
    name = host;

  if (json_object_object_get_ex(args, "volume", &jval))
    volume = json_object_get_int(jval);

  if (json_object_object_get_ex(args, "encrypt", &jval))
    encrypt = json_object_get_boolean(jval);

  if (json_object_object_get_ex(args, "devtype", &jval))
    devtype = json_object_get_string(jval);

  address = resolve_address(host);
  if (!address)
    return -1;

  /* Re-start: drop the previous session and device first. */
  if (helper_device)
    {
      if (helper_device->session)
        output_raop.device_stop(helper_device, 0);
      device_free();
    }
  evbuffer_drain(pcm_buf, evbuffer_get_length(pcm_buf));
  pts_samples = 0;
  helper_state = OUTPUT_STATE_STARTUP;

  dev = calloc(1, sizeof(*dev));
  re = calloc(1, sizeof(*re));
  if (!dev || !re)
    {
      free(dev);
      free(re);
      free(address);
      return -1;
    }

  if (strcasecmp(devtype, "apex1") == 0)
    re->devtype = RDEV_APEX1;
  else if (strcasecmp(devtype, "apex2") == 0)
    re->devtype = RDEV_APEX2;
  else if (strcasecmp(devtype, "apex3") == 0)
    re->devtype = RDEV_APEX3;
  else if (strcasecmp(devtype, "appletv4") == 0)
    re->devtype = RDEV_APPLETV4;
  else if (strcasecmp(devtype, "homepod") == 0)
    re->devtype = RDEV_HOMEPOD;
  else if (strcasecmp(devtype, "other") == 0)
    re->devtype = RDEV_OTHER;
  else
    re->devtype = RDEV_APPLETV;

  re->wanted_metadata = 0;      /* the helper has no artwork/text source */
  re->encrypt = encrypt;
  re->supports_auth_setup = true; /* allow the PIN verification flow */

  dev->id = 1;
  dev->name = strdup(name);
  dev->type = OUTPUT_TYPE_RAOP;
  dev->type_name = "AirPlay 1";
  dev->selected = 1;
  dev->advertised = 1;
  dev->volume = volume;
  dev->relvol = volume;
  /* OwnTone's RAOP_CONFIG_MAX_VOLUME: pct 100 maps to 0 dB, pct 0 to -30 dB. */
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
      dev->v6_port = (short)port;
    }
  else
    {
      dev->v4_address = address;
      dev->v4_port = (short)port;
    }

  helper_device = dev;

  printf("{\"event\":\"state\",\"value\":\"starting\"}\n");
  fflush(stdout);

  ret = output_raop.device_start(dev, 0);
  if (ret < 0)
    {
      device_free();
      helper_state = OUTPUT_STATE_FAILED;
      printf("{\"event\":\"state\",\"value\":\"failed\"}\n");
      fflush(stdout);
      return -1;
    }

  return 0;
}

static void
cmd_volume(struct json_object *args)
{
  struct json_object *jval;
  int volume;

  if (!helper_device)
    return;

  if (!json_object_object_get_ex(args, "volume", &jval))
    return;

  volume = json_object_get_int(jval);
  if (volume < 0)
    volume = 0;
  if (volume > 100)
    volume = 100;

  helper_device->volume = volume;
  output_raop.device_volume_set(helper_device, 0);
}

static void
cmd_flush(void)
{
  /* Drop the read-ahead; the pts stream clock is untouched so the resumed
   * stream keeps rtptime continuity (OwnTone pause semantics). */
  evbuffer_drain(pcm_buf, evbuffer_get_length(pcm_buf));

  if (helper_device && helper_device->session)
    output_raop.device_flush(helper_device, 0);
}

static void
cmd_teardown(void)
{
  if (!helper_device)
    return;

  if (helper_device->session)
    output_raop.device_stop(helper_device, 0);
  device_free();
  evbuffer_drain(pcm_buf, evbuffer_get_length(pcm_buf));
  pts_samples = 0;
  helper_state = OUTPUT_STATE_STOPPED;

  printf("{\"event\":\"state\",\"value\":\"stopped\"}\n");
  fflush(stdout);
}

static void
cmd_pin(struct json_object *args)
{
  struct json_object *jval;
  const char *pin;

  if (!helper_device)
    return;

  if (!json_object_object_get_ex(args, "pin", &jval))
    return;

  pin = json_object_get_string(jval);
  if (!pin || !*pin)
    return;

  output_raop.device_authorize(helper_device, pin, 0);
}

static void
handle_command(const char *json, size_t len)
{
  struct json_object *obj;
  struct json_object *jcmd;
  const char *cmd;

  obj = json_tokener_parse(json);
  if (!obj)
    {
      DPRINTF(E_LOG, L_RAOP, "Bad JSON command: %.*s\n", (int)len, json);
      return;
    }

  if (!json_object_object_get_ex(obj, "cmd", &jcmd))
    {
      json_object_put(obj);
      return;
    }
  cmd = json_object_get_string(jcmd);

  if (cmd && strcmp(cmd, "start") == 0)
    cmd_start(obj);
  else if (cmd && strcmp(cmd, "volume") == 0)
    cmd_volume(obj);
  else if (cmd && strcmp(cmd, "flush") == 0)
    cmd_flush();
  else if (cmd && strcmp(cmd, "teardown") == 0)
    cmd_teardown();
  else if (cmd && strcmp(cmd, "pin") == 0)
    cmd_pin(obj);
  else
    DPRINTF(E_WARN, L_RAOP, "Unknown command: %s\n", cmd ? cmd : "(null)");

  json_object_put(obj);
}

/* --------------------------------------------------------------------- stdin */

/* Non-blocking read+parse of stdin frames, called from the tick (epoll cannot
 * watch a regular-file stdin, so no EV_READ on fd 0). EOF breaks the loop. */
static void
poll_stdin(void)
{
  unsigned char header[5];
  uint8_t scratch[65536];
  ssize_t n;

  for (;;)
    {
      n = read(STDIN_FILENO, scratch, sizeof(scratch));
      if (n > 0)
        evbuffer_add(stdin_buf, scratch, (size_t)n);
      else if (n == 0)
        {
          /* EOF: the server closed our stdin — shut down. */
          event_base_loopbreak(base);
          return;
        }
      else
        break; /* EAGAIN: nothing more this tick */
    }

  for (;;)
    {
      uint32_t len;
      uint8_t type;

      if (evbuffer_get_length(stdin_buf) < sizeof(header))
        return;

      evbuffer_copyout(stdin_buf, header, sizeof(header));
      len = ((uint32_t)header[0] << 24) | ((uint32_t)header[1] << 16)
          | ((uint32_t)header[2] << 8) | (uint32_t)header[3];
      type = header[4];

      if (len > FRAME_MAX)
        {
          DPRINTF(E_LOG, L_RAOP, "Frame length %u over the cap — protocol desync, exiting\n", len);
          event_base_loopbreak(base);
          return;
        }

      if (evbuffer_get_length(stdin_buf) < sizeof(header) + len)
        return; /* wait for the rest of the frame */

      evbuffer_drain(stdin_buf, sizeof(header));

      if (type == 'P')
        {
          /* PCM: move onto the pacing buffer without a copy. */
          evbuffer_remove_buffer(stdin_buf, pcm_buf, len);
        }
      else if (type == 'J')
        {
          char *json = malloc(len + 1);
          if (!json)
            {
              evbuffer_drain(stdin_buf, len);
              return;
            }
          evbuffer_remove(stdin_buf, json, len);
          json[len] = '\0';
          handle_command(json, len);
          free(json);
        }
      else
        {
          DPRINTF(E_WARN, L_RAOP, "Unknown frame type 0x%02x — protocol desync, exiting\n", type);
          event_base_loopbreak(base);
          return;
        }
    }
}

/* ---------------------------------------------------------------------- main */

int
main(int argc, char **argv)
{
  struct timeval tick;
  int i;

  for (i = 1; i < argc; i++)
    {
      if (strcmp(argv[i], "--verbose") == 0 || strcmp(argv[i], "-v") == 0)
        helper_logger_set_severity(E_DBG);
    }

  gcry_check_version(NULL);

  base = event_base_new();
  if (!base)
    {
      fprintf(stderr, "[raop] event_base_new failed\n");
      return 1;
    }
  evbase_player = base;

  stdin_buf = evbuffer_new();
  pcm_buf = evbuffer_new();
  if (!stdin_buf || !pcm_buf)
    return 1;

  if (output_raop.init() < 0)
    {
      fprintf(stderr, "[raop] raop init failed\n");
      return 1;
    }

  /* stdin is polled non-blocking from the tick (epoll cannot watch a
   * regular-file stdin). */
  fcntl(STDIN_FILENO, F_SETFL, fcntl(STDIN_FILENO, F_GETFL) | O_NONBLOCK);

  tick_ev = event_new(base, -1, EV_TIMEOUT | EV_PERSIST, tick_cb, NULL);
  tick.tv_sec = 0;
  tick.tv_usec = TICK_MS * 1000;
  evtimer_add(tick_ev, &tick);

  printf("{\"event\":\"ready\"}\n");
  fflush(stdout);

  event_base_dispatch(base);

  /* Shutdown: teardown whatever is left. */
  if (helper_device)
    {
      if (helper_device->session)
        output_raop.device_stop(helper_device, 0);
      device_free();
    }
  output_raop.deinit();

  event_free(tick_ev);
  evbuffer_free(stdin_buf);
  evbuffer_free(pcm_buf);
  event_base_free(base);

  return 0;
}
