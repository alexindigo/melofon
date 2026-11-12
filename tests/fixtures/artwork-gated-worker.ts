// Keep the production handler and algorithms, but pause synchronously after its
// started message. An HTTP response must finish before the test releases it.
declare function postMessage(value: unknown): void;
let gate: Int32Array | undefined;
addEventListener('message', (event) => {
  const { data } = event as MessageEvent<{ gate?: SharedArrayBuffer }>;
  gate = data.gate ? new Int32Array(data.gate) : undefined;
});
const send = postMessage;
(globalThis as unknown as { postMessage: typeof postMessage }).postMessage = (
  value: unknown,
) => {
  send(value);
  if ((value as { started?: boolean })?.started && gate) {
    if (Atomics.wait(gate, 0, 0, 30_000) === 'timed-out') {
      throw new Error('Artwork Worker test barrier timed out');
    }
  }
};
await import('../../src/artwork/facts-worker.ts');
