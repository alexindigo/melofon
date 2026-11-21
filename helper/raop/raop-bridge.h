/* Loop-thread device-local completion bridge, no private layout mirror. */
#ifndef MELOFON_RAOP_BRIDGE_H
#define MELOFON_RAOP_BRIDGE_H
#include <stdint.h>
#include <stddef.h>
#include <time.h>
#include "timeline.h"
struct raop_player;
struct output_metadata;
/* Loop-owned backend state; independent of attachment/master lifetime. Send
 * takes ownership even on allocation failure. Free follows all device joins. */
int raop_metadata_send_stream(uint64_t stream_id, struct output_metadata *);
void raop_metadata_purge_stream(uint64_t stream_id);
void raop_metadata_anchor_stream(uint64_t stream_id, struct timespec pts);
void raop_backend_stream_free(uint64_t stream_id);
int raop_player_metadata(struct raop_player *, const char *, const char *, uint32_t, uint32_t);
int raop_player_timeline_active(struct raop_player *);
int raop_player_append_source(struct raop_player *, uint64_t source, uint64_t segment,
                              const uint8_t *, size_t, struct raop_source_append_result *);
void raop_player_seal(struct raop_player *, uint64_t source, uint64_t target,
                       struct raop_marker_result *);
void raop_player_end(struct raop_player *, uint64_t target, struct raop_marker_result *);
int raop_player_compatibility_silence(struct raop_player *, uint64_t source);
int raop_player_source(struct raop_player *, uint64_t source, struct raop_source_snapshot *);
int raop_player_range(struct raop_player *, uint64_t index, struct raop_range_snapshot *);
void raop_transport_progress(uint64_t stream_id, uint64_t attachment, uint64_t now_ns,
                               struct raop_progress_snapshot *);
/* Earliest input deadline of an incomplete/next packet, including receiver lead.
 * Zero means no established healthy schedule yet. Loop thread only. */
uint64_t raop_transport_input_deadline(uint64_t stream_id);
int raop_player_progress(struct raop_player *, uint64_t source, uint64_t attachment,
                           struct raop_progress_snapshot *);
int raop_player_progress_at(struct raop_player *, uint64_t source, uint64_t attachment,
                            uint64_t captured_ns, struct raop_progress_snapshot *);
void raop_player_failed(struct raop_player *, uint64_t error);
void raop_player_failure(struct raop_player *, struct raop_progress_snapshot *);
int raop_player_completion_progress(struct raop_player *, uint64_t source,
  uint64_t attachment, struct raop_progress_snapshot *, uint64_t *transport_end);
void raop_player_ack_source(struct raop_player *, uint64_t source);
int raop_player_ended(struct raop_player *);
int raop_player_drained(struct raop_player *);
void raop_player_drain_complete(struct raop_player *);
int raop_player_timeline_metadata(struct raop_player *, uint64_t source, uint64_t frame,
  uint64_t origin, uint64_t duration, const char *title, const char *artist);
void raop_player_metadata_update(struct raop_player *);
void raop_timeline_metadata_progress(uint64_t stream_id, uint64_t frames);
void raop_ffi_completion_update(uint64_t stream_id);
void raop_ffi_attachment_failed(uint64_t stream_id, uint64_t attachment, uint64_t error);
void raop_ffi_progress_failed(uint64_t stream_id, uint64_t error);
/* -1: cleanup could not start, retain ownership. 0: accepted. Callback after
 * all device-local sessions/sockets are destroyed, possibly inline. sent=0
 * all final requests wrote locally, -1 some unsent; neither means remote ACK. */
int raop_release_device(uint64_t id, void (*done)(uint64_t, int));
/* Loop-thread effective-feed discontinuity: discard partial raw ALAC input,
 * retaining peer sessions, RTP clocks and already encoded retransmit packets. */
void raop_discard_pending_input(uint64_t stream_id);
/* Compatibility local reset reanchors the pacer without FLUSH. Its next write
 * must establish a fresh wire sync too, not reuse the old presentation origin.
 * Accounted timeline epochs refuse this path and require ordered cancel. */
void raop_reanchor_stream(uint64_t stream_id);
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
