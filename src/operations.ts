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
  return {
    get closed(): boolean {
      return closing !== undefined;
    },
    run<T>(work: (operation: Operation) => T | Promise<T>): Promise<T> {
      if (closing) return Promise.reject(new Error(`${name} is closed`));
      const id = Symbol(name);
      const abort = new AbortController();
      const settlement = Promise.withResolvers<void>();
      const settled = settlement.promise;
      pending.set(id, { abort, settled });
      let result: T | Promise<T>;
      try {
        result = work({ id, signal: abort.signal, settled });
      } catch (error) {
        result = Promise.reject(error);
      }
      return Promise.resolve(result).finally(() => {
        pending.delete(id);
        settlement.resolve();
      });
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
