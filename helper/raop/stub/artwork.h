/* artwork.h stub — the helper sends no artwork (the queue metadata lookup
 * always misses, so raop metadata falls back to progress-only). */
#ifndef __ARTWORK_H__
#define __ARTWORK_H__

#include <event2/buffer.h>

#define ART_FMT_PNG     1
#define ART_FMT_JPEG    2
#define ART_FMT_VP8     3

#define ART_DEFAULT_HEIGHT 600
#define ART_DEFAULT_WIDTH  600

int
artwork_get_by_queue_item_id(struct evbuffer *evbuf, int item_id, int max_w, int max_h, int format);

#endif /* __ARTWORK_H__ */
