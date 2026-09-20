/* conffile.h stub — the helper is configured by JSON commands on stdin, not
 * an OwnTone .conf file. cfg_t is opaque; every getter is NULL-safe and
 * returns the OwnTone default the vendored code expects when no config
 * exists. */
#ifndef __CONFFILE_H__
#define __CONFFILE_H__

#include <stdbool.h>
#include <stdint.h>

typedef struct cfg_t cfg_t;
typedef struct cfg_opt_t { int nvalues; } cfg_opt_t;

/* The one global config the vendored code reads — always NULL in the helper,
 * which every stub getter below tolerates. */
extern cfg_t *cfg;

/* Library name hash used in RTSP/DACP headers (conffile.c in OwnTone). */
extern uint64_t libhash;

/* All stubs: NULL in, default out. Implementations in stubs.c. */
cfg_t *cfg_getsec(cfg_t *cfg, const char *name);
cfg_t *cfg_gettsec(cfg_t *cfg, const char *name, const char *title);
const char *cfg_getstr(cfg_t *cfg, const char *name);
const char *cfg_getnstr(cfg_t *cfg, const char *name, unsigned int index);
bool cfg_getbool(cfg_t *cfg, const char *name);
int cfg_getint(cfg_t *cfg, const char *name);
cfg_opt_t *cfg_getopt(cfg_t *cfg, const char *name);
int cfg_size(cfg_t *cfg, const char *name);
const char *cfg_name(cfg_t *cfg);
bool cfg_opt_getnbool(cfg_opt_t *opt, unsigned int index);

#endif /* __CONFFILE_H__ */
