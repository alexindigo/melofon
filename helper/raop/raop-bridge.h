/* Loop-thread device-local completion bridge, no private layout mirror. */
#ifndef MELOFON_RAOP_BRIDGE_H
#define MELOFON_RAOP_BRIDGE_H
#include <stdint.h>
#include <stddef.h>
/* -1: cleanup could not start, retain ownership. 0: accepted. Callback after
 * all device-local sessions/sockets are destroyed, possibly inline. sent=0
 * all final requests wrote locally, -1 some unsent; neither means remote ACK. */
int raop_release_device(uint64_t id, void (*done)(uint64_t, int));
/* Loop-thread effective-feed discontinuity: discard partial raw ALAC input,
 * retaining peer sessions, RTP clocks and already encoded retransmit packets. */
void raop_discard_pending_input(uint64_t stream_id);
/* Loop-owned epoch reset. Clear input/cache, FLUSH established sessions and
 * destroy old startup sessions. Repeated calls cannot admit PCM between ACKs.
 * Returns the slowest healthy scheduled cutoff at the captured monotonic time. */
uint64_t raop_cancel_stream(uint64_t stream_id, uint64_t admitted_ns,
                            const uint64_t *retire_ids, size_t retire_count);
int raop_cancel_pending(uint64_t stream_id);
void raop_ffi_cancel_changed(uint64_t stream_id);
int raop_ffi_stream_fenced(uint64_t stream_id);
/* Copy pairing state into the owning handle's reliable mailbox. NULL is an
 * explicit invalidation, never ordinary device cleanup. No SQL or diagnostics.
 * Returns 0 only when copied; callable from the native producer thread. */
int raop_ffi_credential_changed(uint64_t id, const char *key);
#endif
