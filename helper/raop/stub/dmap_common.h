/* dmap_common.h stub — metadata text for the device screen. The helper
 * reports failure so raop.c skips the text/artwork records (progress
 * metadata still flows). */
#ifndef __DMAP_COMMON_H__
#define __DMAP_COMMON_H__

#include <event2/buffer.h>

struct db_queue_item;

int
dmap_encode_queue_metadata(struct evbuffer *songlist, struct evbuffer *song, struct db_queue_item *queue_item);

#endif /* __DMAP_COMMON_H__ */
