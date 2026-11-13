let owners = 0;
let timer: ReturnType<typeof setInterval> | undefined;

/** Native completions can lose their Deno wake-up; a tick makes the loop poll.
 * See ~/Documents/melofon/todos/store-query-stall.md. */
export function acquireHeartbeat(): Disposable {
  if (owners === 0) {
    timer = setInterval(() => {}, 50);
    Deno.unrefTimer(timer);
  }
  owners++;
  let released = false;
  return {
    [Symbol.dispose]() {
      if (released) return;
      released = true;
      if (--owners === 0) {
        clearInterval(timer);
        timer = undefined;
      }
    },
  };
}
