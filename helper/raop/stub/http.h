/* http.h stub — only the icy metadata surface transcode.c reads (and only
 * for internet-radio inputs the helper never has: it transcodes raw PCM). */
#ifndef __HTTP_H__
#define __HTTP_H__

#include <stdint.h>

struct http_icy_metadata
{
  uint32_t id;

  /* Static stream metadata from icy_metadata_headers */
  char *name;
  char *description;
  char *genre;

  /* Track specific, comes from icy_metadata_packet */
  char *title;
  char *artist;
  char *url;

  uint32_t hash;
};

struct AVFormatContext;

struct http_icy_metadata *
http_icy_metadata_get(struct AVFormatContext *fmtctx, int packet_only);

void
http_icy_metadata_free(struct http_icy_metadata *metadata, int content_only);

#endif /* __HTTP_H__ */
