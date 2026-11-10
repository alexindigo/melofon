import { PlaybackError } from './playback-errors.ts';

export interface CapacityOwner {
  id: number;
  name: string;
}

export interface PlaybackReservation {
  isCurrent(): boolean;
  release(): void;
}

/** A fixed player's port into a boot-declared, single-stream resource. */
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
  busy(owner: CapacityOwner): PlaybackError;
}) {
  type Occupancy = {
    owner: () => CapacityOwner;
    epoch: number;
    demands: Set<object>;
    resources: Set<object>;
  };
  let occupied: Occupancy | undefined;
  const collect = (slot: Occupancy) => {
    if (occupied === slot && !slot.demands.size && !slot.resources.size) {
      occupied = undefined;
    }
  };
  return {
    forPlayer(owner: () => CapacityOwner): PlaybackCapacity {
      const id = owner().id;
      const owns = (slot: Occupancy | undefined): boolean =>
        slot !== undefined && slot.owner().id === id;
      return {
        protocol: deps.protocol,
        reserve() {
          if (occupied && !owns(occupied)) throw deps.busy(occupied.owner());
          const slot = occupied ??= {
            owner,
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
            slot !== undefined && owns(slot) && occupied === slot &&
            slot.epoch === epoch &&
            slot.demands.size > 0;
        },
        retain() {
          const slot = occupied;
          if (!slot || !owns(slot) || !slot.demands.size) {
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
