import { PlaybackError } from './playback-errors.ts';

export interface CapacityOwner {
  id: number;
  name: string;
}

export interface PlaybackReservation {
  isCurrent(): boolean;
  release(): void;
}

/** Demand and retained resources for one fixed-player stream incarnation. */
export interface PlaybackCapacity {
  readonly protocol: string;
  reserve(): PlaybackReservation;
  /** Capture this demand lifetime, never a future reacquisition. */
  authority(): () => boolean;
  /** Retain before acquiring transport resources; release only after close. */
  retain(): { release(): void };
}

/** Intent and actual resource occupancy have separate lifetimes. A canceled
 * start can relinquish intent immediately without freeing a closing transport. */
export function createPlaybackCapacity(deps: {
  protocol: string;
}) {
  type Occupancy = {
    epoch: number;
    demands: Set<object>;
    resources: Set<object>;
  };
  return {
    forPlayer(_owner: () => CapacityOwner): PlaybackCapacity {
      // The port, not the durable id, owns this incarnation. A deleted/recreated
      // engine cannot revive an old demand or release its retained storage.
      let occupied: Occupancy | undefined;
      const collect = (slot: Occupancy) => {
        if (occupied === slot && !slot.demands.size && !slot.resources.size) {
          occupied = undefined;
        }
      };
      return {
        protocol: deps.protocol,
        reserve() {
          const slot = occupied ??= {
            epoch: 0,
            demands: new Set(),
            resources: new Set(),
          };
          if (!slot.demands.size) slot.epoch++;
          const token = {};
          slot.demands.add(token);
          return {
            isCurrent: () => occupied === slot && slot.demands.has(token),
            release() {
              slot.demands.delete(token);
              collect(slot);
            },
          };
        },
        authority() {
          const slot = occupied, epoch = slot?.epoch;
          return () =>
            slot !== undefined && occupied === slot &&
            slot.epoch === epoch &&
            slot.demands.size > 0;
        },
        retain() {
          const slot = occupied;
          if (!slot || !slot.demands.size) {
            throw new PlaybackError(
              'playback_cancelled',
              'Playback reservation expired',
            );
          }
          const token = {};
          slot.resources.add(token);
          return {
            release() {
              slot.resources.delete(token);
              collect(slot);
            },
          };
        },
      };
    },
  };
}
