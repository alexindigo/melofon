/* mdns.h stub — the helper does no discovery: the device arrives via the
 * start command. mdns_browse claims success so raop_init completes. */
#ifndef __MDNS_H__
#define __MDNS_H__

enum mdns_options
{
  MDNS_CONNECTION_TEST = (1 << 1),
};

struct keyval;

typedef void (* mdns_browse_cb)(const char *name, const char *type, const char *domain, const char *hostname, int family, const char *address, int port, struct keyval *txt);

int
mdns_browse(char *type, mdns_browse_cb cb, enum mdns_options flags);

#endif /* __MDNS_H__ */
