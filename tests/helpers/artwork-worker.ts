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
