/* Loop-thread device-local completion bridge, no private layout mirror. */
#ifndef MELOFON_RAOP_BRIDGE_H
#define MELOFON_RAOP_BRIDGE_H
#include <stdint.h>
/* -1: cleanup could not start, retain ownership. 0: accepted. Callback after
 * all device-local sessions/sockets are destroyed, possibly inline. sent=0
 * all final requests wrote locally, -1 some unsent; neither means remote ACK. */
int raop_release_device(uint64_t id, void (*done)(uint64_t, int));
#endif
