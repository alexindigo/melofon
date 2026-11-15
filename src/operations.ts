/** An operation's identity and cancellation are separate from its settlement. */
export interface Operation {
  readonly id: symbol;
  readonly signal: AbortSignal;
  /** Always resolves, after the operation's work and cleanup have settled. */
  readonly settled: Promise<void>;
}

/** Own work at its entry point, before it can suspend. Domain scheduling,
 * failure handling and cancellation policy remain with the owning service. */
export function createOperationScope(name: string) {
  const pending = new Map<symbol, {
    abort: AbortController;
    settled: Promise<void>;
  }>();
  let closing: Promise<void> | undefined;
  // Some engine ports deliberately stay synchronous when no I/O is needed.
  // Use the same admission and finally-owned settlement without rescheduling
  // that publication or changing its result/throw channel.
  function run<T>(
    work: (operation: Operation) => T | Promise<T>,
    immediate: true,
  ): T | Promise<T>;
  function run<T>(
    work: (operation: Operation) => T | Promise<T>,
    immediate?: false,
  ): Promise<T>;
  function run<T>(
    work: (operation: Operation) => T | Promise<T>,
    immediate = false,
  ): T | Promise<T> {
    if (closing) {
      const error = new Error(`${name} is closed`);
      if (immediate) throw error;
      return Promise.reject(error);
    }
    const id = Symbol(name);
    const abort = new AbortController();
    const settlement = Promise.withResolvers<void>();
    const settled = settlement.promise;
    const finish = () => {
      pending.delete(id);
      settlement.resolve();
    };
    pending.set(id, { abort, settled });
    let result: T | Promise<T>;
    try {
      result = work({ id, signal: abort.signal, settled });
    } catch (error) {
      if (immediate) {
        finish();
        throw error;
      }
      result = Promise.reject(error);
    }
    if (immediate && !(result instanceof Promise)) {
      finish();
      return result;
    }
    return Promise.resolve(result).finally(finish);
  }
  return {
    get closed(): boolean {
      return closing !== undefined;
    },
    run<T>(work: (operation: Operation) => T | Promise<T>): Promise<T> {
      return run(work);
    },
    runImmediate<T>(work: (operation: Operation) => T | Promise<T>) {
      return run(work, true);
    },
    close(): Promise<void> {
      if (closing) return closing;
      // Install the receipt before abort listeners can reenter this owner.
      const completion = Promise.withResolvers<void>();
      closing = completion.promise;
      const admitted = [...pending.values()];
      for (const operation of admitted) operation.abort.abort();
      void Promise.all(admitted.map((operation) => operation.settled)).then(
        () => completion.resolve(),
      );
      return closing;
    },
  };
}
