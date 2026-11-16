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
#endif
