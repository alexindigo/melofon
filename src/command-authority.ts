/** Latest-intent authority, separate from operation settlement and FIFO work.
 * A continuation owns its captured handle, never the lane's newest occupant. */
export interface CommandHandle {
  readonly signal: AbortSignal;
  isCurrent(): boolean;
  cancel(): void;
}

export function createCommandLane() {
  let current: CommandHandle | undefined;
  return {
    capture: () => current,
    submit(): CommandHandle {
      const previous = current;
      const controller = new AbortController();
      const handle: CommandHandle = {
        signal: controller.signal,
        isCurrent: () => current === handle && !controller.signal.aborted,
        cancel() {
          if (current === handle) current = undefined;
          controller.abort();
        },
      };
      // Publish the successor before abort callbacks can reenter submission.
      current = handle;
      previous?.cancel();
      return handle;
    },
  };
}
