/* logger.h stub — OwnTone log domains/severities, helper implementation in
 * stubs.c logs to stderr. */
#ifndef __LOGGER_H__
#define __LOGGER_H__

#include <stdarg.h>
#include <stdint.h>

struct helper_log_fields {
  uint64_t device;
  int64_t value, value2;
  const char *name, *host;
  int flags;
};
void helper_log_event(int severity, int domain, const char *event,
                      const struct helper_log_fields *fields);

/* Log domains */
#define L_CONF        0
#define L_DAAP        1
#define L_DB          2
#define L_HTTPD       3
#define L_HTTP        4
#define L_MAIN        5
#define L_MDNS        6
#define L_MISC        7
#define L_RSP         8
#define L_SCAN        9
#define L_XCODE       10
#define L_EVENT       11
#define L_REMOTE      12
#define L_DACP        13
#define L_FFMPEG      14
#define L_ART         15
#define L_PLAYER      16
#define L_RAOP        17
#define L_LAUDIO      18
#define L_DMAP        19
#define L_DBPERF      20
#define L_SPOTIFY     21
#define L_SCROBBLE    22
#define L_CACHE       23
#define L_MPD         24
#define L_STREAMING   25
#define L_CAST        26
#define L_FIFO        27
#define L_LIB         28
#define L_WEB         29
#define L_AIRPLAY     30
#define L_RCP         31

#define N_LOGDOMAINS  32

/* Severities */
#define E_FATAL   0
#define E_LOG     1
#define E_WARN    2
#define E_INFO    3
#define E_DBG     4
#define E_SPAM    5

void
DPRINTF(int severity, int domain, const char *fmt, ...) __attribute__((format(printf, 3, 4)));

void
DVPRINTF(int severity, int domain, const char *fmt, va_list ap);

void
DHEXDUMP(int severity, int domain, const unsigned char *data, int data_len, const char *heading);

void
logger_ffmpeg(void *ptr, int level, const char *fmt, va_list ap);

void
logger_libevent(int severity, const char *msg);

void
logger_reinit(void);

int
logger_severity(void);

void
log_fatal_err(int domain, const char *func, int line, int err) __attribute__((__noreturn__));

void
log_fatal_errno(int domain, const char *func, int line) __attribute__((__noreturn__));

void
log_fatal_null(int domain, const char *func, int line) __attribute__((__noreturn__));

#endif /* __LOGGER_H__ */
