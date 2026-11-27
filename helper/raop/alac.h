#ifndef MELOFON_RAOP_ALAC_H
#define MELOFON_RAOP_ALAC_H
#include <stddef.h>
#include <stdint.h>

#define RAOP_SAMPLES_PER_PACKET 352
struct evbuffer;
/* Append one packet of stereo s16le as verbatim ALAC. Return its wire size. */
int raop_alac_encode(struct evbuffer *, const uint8_t *, size_t);
#endif
