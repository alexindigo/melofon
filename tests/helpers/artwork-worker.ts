export function artworkStateFixture() {
  const values = new Map<string, number>();
  return {
    declare(key: string, schema: unknown) {
      if (!values.has(key)) {
        values.set(key, (schema as { default: number }).default);
      }
    },
    getTyped: (key: string) => Promise.resolve(values.get(key)),
    set(key: string, value: string) {
      values.set(key, Number(value));
    },
  };
}

/** A missing Worker transition fails the test and still reaches its cleanup. */
export async function waitForWorkerSignal(
  signal: Promise<void>,
  phase: string,
  milliseconds = 30_000,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      signal,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Artwork Worker did not report ${phase}`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
