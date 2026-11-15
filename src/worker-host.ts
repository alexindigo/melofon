import { createOperationScope, type Operation } from './operations.ts';

/** Intake includes preparation, not just messages sent to the isolate. */
export function createWorkerIntake(name: string, busy = `${name} busy`) {
  const operations = createOperationScope(name);
  let inFlight = false;
  return {
    get closed() {
      return operations.closed;
    },
    track: operations.run,
    run<T>(work: (operation: Operation) => Promise<T>): Promise<T> {
      return operations.run(async (operation) => {
        if (inFlight) throw new Error(busy);
        inFlight = true;
        try {
          return await work(operation);
        } finally {
          inFlight = false;
        }
      });
    },
    close: operations.close,
  };
}

interface Deadline {
  milliseconds: number;
  error: Error;
}
export interface WorkerCall {
  readonly id: string;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}
export interface WorkerSession {
  readonly worker: Worker;
  readonly ready: Promise<void>;
  readonly retired: boolean;
  readonly call: WorkerCall | undefined;
  markReady(): void;
  retire(error: Error): void;
  request<T>(send: (call: WorkerCall) => void, deadline?: Deadline): Promise<T>;
}

/** One isolate incarnation owns readiness and at most one correlated call.
 * Adapters own wire formats, permissions, heartbeat and recovery policy. */
export function createWorkerSession(worker: Worker, options: {
  startup?: Deadline;
  invalidMessage: string;
  onMessage(data: MessageEvent['data'], session: WorkerSession): void;
  onRetire?(error: Error): void;
}): WorkerSession {
  const readiness = Promise.withResolvers<void>();
  // Readiness may fail while idle, before a caller starts awaiting it.
  void readiness.promise.catch(() => {});
  let starting = true;
  let retired = false;
  let current: WorkerCall | undefined;
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  const session = {
    worker,
    ready: readiness.promise,
    get retired() {
      return retired;
    },
    get call() {
      return current;
    },
    markReady() {
      if (retired || !starting) return;
      starting = false;
      clearTimeout(startupTimer);
      readiness.resolve();
    },
    retire(error: Error) {
      if (retired) return;
      retired = true;
      clearTimeout(startupTimer);
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      readiness.reject(error);
      current?.reject(error);
      // Reject before termination; every waiter has one settlement path.
      worker.terminate();
      options.onRetire?.(error);
    },
    request<T>(
      send: (call: WorkerCall) => void,
      deadline?: Deadline,
    ): Promise<T> {
      if (retired) return Promise.reject(new Error('Worker retired'));
      if (starting) return Promise.reject(new Error('Worker is not ready'));
      if (current) return Promise.reject(new Error('Worker busy'));
      const result = Promise.withResolvers<unknown>();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (error: boolean, value: unknown) => {
        if (current !== call) return;
        current = undefined;
        clearTimeout(timer);
        if (error) result.reject(value);
        else result.resolve(value);
      };
      const call: WorkerCall = {
        id: crypto.randomUUID(),
        resolve: (value) => finish(false, value),
        reject: (error) => finish(true, error),
      };
      current = call;
      if (deadline) {
        timer = setTimeout(
          () => session.retire(deadline.error),
          deadline.milliseconds,
        );
      }
      try {
        send(call);
      } catch (error) {
        session.retire(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
      return result.promise as Promise<T>;
    },
  };
  worker.onmessage = ({ data }) => {
    if (retired) return;
    try {
      options.onMessage(data, session);
    } catch (error) {
      session.retire(error instanceof Error ? error : new Error(String(error)));
    }
  };
  worker.onerror = (event) => {
    event.preventDefault();
    session.retire(new Error(event.message));
  };
  worker.onmessageerror = () =>
    session.retire(new Error(options.invalidMessage));
  if (options.startup) {
    startupTimer = setTimeout(
      () => session.retire(options.startup!.error),
      options.startup.milliseconds,
    );
  }
  return session;
}
