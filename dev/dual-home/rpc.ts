// Owned subprocess IPC; production logging is retained alongside RPC responses.
// Protocol writer is deliberately distinct from console and diagnostic logging.
export function writeReply(reply: unknown): void {
  const bytes = new TextEncoder().encode(
    'DUALHOME:' + JSON.stringify(reply) + '\n',
  );
  for (let offset = 0; offset < bytes.length;) {
    const n = Deno.stdout.writeSync(bytes.subarray(offset));
    if (n <= 0) throw new Error('RPC writer made no progress');
    offset += n;
  }
}
export async function* lines(stream: ReadableStream<Uint8Array>) {
  let pending = '';
  for await (const chunk of stream.pipeThrough(new TextDecoderStream())) {
    pending += chunk;
    for (;;) {
      const end = pending.indexOf('\n');
      if (end < 0) break;
      yield pending.slice(0, end);
      pending = pending.slice(end + 1);
    }
  }
  if (pending) yield pending;
}

export class Rpc {
  private sequence = 0;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private waiting = new Map<number, {
    resolve(value: unknown): void;
    reject(error: Error): void;
  }>();
  private pumps: Promise<void>[];
  constructor(readonly child: Deno.ChildProcess, log: string) {
    this.writer = child.stdin.getWriter();
    this.pumps = [child.stdout, child.stderr].map((stream) =>
      (async () => {
        for await (const line of lines(stream)) {
          await Deno.writeTextFile(log, `${line}\n`, { append: true });
          if (!line.startsWith('DUALHOME:')) continue;
          const reply = JSON.parse(line.slice(9));
          const pending = this.waiting.get(reply.id);
          this.waiting.delete(reply.id);
          if (reply.error) pending?.reject(new Error(reply.error));
          else pending?.resolve(reply.value);
        }
      })()
    );
    void child.status.then((status) => {
      for (const pending of this.waiting.values()) {
        pending.reject(new Error(`worker exited ${status.code}; see ${log}`));
      }
      this.waiting.clear();
    });
  }
  async call<T>(command: string, input: unknown = {}): Promise<T> {
    const id = ++this.sequence;
    const response = new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { resolve: (value) => resolve(value as T), reject });
    });
    await this.writer.write(new TextEncoder().encode(
      JSON.stringify({ id, command, input }) + '\n',
    ));
    return await response;
  }
  async close() {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failure: unknown;
    try {
      await Promise.race([
        this.call('close'),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('worker close timeout')),
            10000,
          );
        }),
      ]);
    } catch (error) {
      failure = error;
    } finally {
      clearTimeout(timer);
      const finished = await Promise.race([
        this.child.status,
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), 2000);
        }),
      ]);
      clearTimeout(timer);
      if (!finished) {
        this.child.kill('SIGKILL');
        await this.child.status;
        failure ??= new Error('owned worker required forced termination');
      }
      await Promise.all(this.pumps);
      if (finished && !finished.success) {
        failure ??= new Error(`worker cleanup exit ${finished.code}`);
      }
    }
    if (failure) throw failure;
  }
}

export async function serve(
  handle: (
    command: string,
    input: Record<string, unknown>,
  ) => unknown | Promise<unknown>,
) {
  for await (const line of lines(Deno.stdin.readable)) {
    const { id, command, input } = JSON.parse(line);
    try {
      const value = await handle(command, input);
      writeReply({ id, value });
    } catch (error) {
      writeReply({ id, error: String(error) });
    }
    if (command === 'close') break;
  }
}
