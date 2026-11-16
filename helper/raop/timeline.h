/* Shared value-only timeline ABI. Kept separate from public entry points:
 * vendor raop.c has private functions named like the public compatibility API. */
#ifndef MELOFON_RAOP_TIMELINE_H
#define MELOFON_RAOP_TIMELINE_H
#include <stdint.h>
enum raop_append_status {
  RAOP_APPEND_ACCEPTED = 0,
  RAOP_APPEND_BACKPRESSURE = 1,
  RAOP_APPEND_CANCELED = 2,
  RAOP_APPEND_ERROR = 3,
  RAOP_APPEND_NOT_READY = 4,
};
enum raop_append_error {
  RAOP_APPEND_ERROR_NONE = 0,
  RAOP_APPEND_ERROR_INVALID = 1,
  RAOP_APPEND_ERROR_BUSY = 2,
  RAOP_APPEND_ERROR_ALLOCATION = 3,
  RAOP_APPEND_ERROR_CLOSING = 4,
};
struct raop_source_append_result {
  uint64_t epoch, source, segment, accepted_frames, source_offset, input_offset;
  uint64_t status, error;
};
struct raop_marker_result {
  uint64_t epoch, source, target, input_end, status, error;
};
struct raop_source_snapshot {
  uint64_t epoch, source, accepted_frames, fed_frames, sealed, target, input_end;
};
enum raop_range_kind { RAOP_RANGE_REAL = 0, RAOP_RANGE_UNDERRUN = 1,
                       RAOP_RANGE_PADDING = 2, RAOP_RANGE_DRAIN = 3 };
struct raop_range_snapshot {
  uint64_t epoch, index, kind, source, segment, source_offset, transport_start, frames;
};
enum raop_progress_error { RAOP_PROGRESS_OK = 0, RAOP_PROGRESS_ALLOCATION = 1,
  RAOP_PROGRESS_ENCODER = 2, RAOP_PROGRESS_CIPHER = 3, RAOP_PROGRESS_SEND = 4,
  RAOP_PROGRESS_SYNC = 5, RAOP_PROGRESS_OVERDUE = 6, RAOP_PROGRESS_TRANSPORT = 7 };
/* Exclusive frame boundaries. attachment=0 selects the intersection of live
 * required sessions, never vacuous coverage. A late join covers a suffix only.
 * status: 0 waiting, 1 scheduled, 2 failed. This is not a completion receipt. */
struct raop_progress_snapshot {
  uint64_t epoch, source, attachment, captured_ns, status, error, participants;
  uint64_t coverage_start, submitted_frames, scheduled_frames, schedule_origin_ns;
  uint64_t fed_frames, real_frames, silence_frames, source_frames;
};
/* Retained terminal source receipt, independent of the device state ring.
 * status: pending/complete/canceled/failed. All identities/targets are exact.
 * A revision retains excluded outcomes; it never turns an excluded peer into
 * a successful participant. Acknowledgement ends this receipt's read lifetime. */
struct raop_completion_result {
  uint64_t stream, epoch, source, target, input_end, revision;
  uint64_t status, error, transport_end, captured_ns, attachments, required;
};
/* outcome: pending/complete/withdrawn/failed/canceled; excluded is explicit.
 * Boundaries are exclusive epoch transport frames, never arrival counts. */
struct raop_completion_attachment {
  uint64_t attachment, session, outcome, excluded, error;
  uint64_t coverage_start, submitted_frames, scheduled_frames;
};
#endif
