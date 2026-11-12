// Catch failures inside the isolate: Deno prints terminal errors before the
// parent's Worker.onerror runs. The host owns retirement and structured logging.
declare function postMessage(value: unknown): void;
function report(error: unknown) {
  postMessage({ error: String(error) });
}
addEventListener('error', (event) => {
  const failure = event as ErrorEvent;
  failure.preventDefault();
  report(failure.error ?? new Error(failure.message));
});
addEventListener('unhandledrejection', (event) => {
  const failure = event as PromiseRejectionEvent;
  failure.preventDefault();
  report(failure.reason);
});
addEventListener('message', async (event) => {
  const { data } = event as MessageEvent<{ module: string }>;
  try {
    await import(data.module);
  } catch (error) {
    report(error);
  }
}, { once: true });
