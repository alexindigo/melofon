// Separate process: Node proxy policy is initialized from startup environment.
import { createNetwork } from '../../src/lookups/net.ts';

const input = Deno.args[0];
const network = createNetwork({
  resolve: () => Promise.resolve(['127.0.0.1']),
  ca: input.startsWith('https:')
    ? await Deno.readTextFile(new URL('./net-tls/cert.pem', import.meta.url))
    : undefined,
  state: {
    declare() {},
    getTyped: (key) =>
      Promise.resolve(
        key === 'net.allowPrivateDestinations'
          ? true
          : key === 'lookups.requestAttempts'
          ? 1
          : undefined,
      ),
  },
});
const response = await network.fetch(
  {
    caller: 'core.proxy-test',
    hosts: () => true,
    ratePerMinute: 600000,
    signal: new AbortController().signal,
  },
  input,
  {},
  {
    timeoutMs: 2000,
    maxBytes: 1000,
  },
);
console.log('PROXY_CONSUMER', response.status, await response.text());
