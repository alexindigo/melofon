/* Verbatim ALAC packing adapted from OwnTone's raop.c and raop_play
 * (Copyright (C) 2005 Shiro Ninomiya <shiron@snino.com>, GPLv2+). */
#include <event2/buffer.h>
#include "alac.h"

int
raop_alac_encode(struct evbuffer *out, const uint8_t *pcm, size_t size)
{
  enum { PCM_BYTES = RAOP_SAMPLES_PER_PACKET * 4 };
  uint8_t packet[3 + PCM_BYTES];
  if (size != PCM_BYTES) return -1;

  /* 23-bit header: stereo pair, default frame size, uncompressed. Write
   * big-endian PCM one bit before the byte boundary. The last bit is zero
   * padding; the Audio Station wire format has no ALAC END element. */
  packet[0] = 0x20;
  packet[1] = 0;
  packet[2] = 2;
  for (size_t i = 0; i < PCM_BYTES; i++) {
    uint8_t byte = pcm[i ^ 1];
    packet[i + 2] |= byte >> 7;
    packet[i + 3] = byte << 1;
  }
  return evbuffer_add(out, packet, sizeof(packet)) < 0 ? -1 : sizeof(packet);
}
