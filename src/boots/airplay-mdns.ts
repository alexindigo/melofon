// src/boots/airplay-mdns.ts — AirPlay 1 discovery: browses _raop._tcp via
// src/mdns.ts (querier only — no Avahi, no daemon) and registers devices as
// outputs. Dedupe is by host: a manually-registered device (POST /_/outputs,
// MELOFON_AIRPLAY_HOST) wins over a discovered one at the same address.
//
// The toggle lives in internal state (app.state, /_/config): key
// airplay.mdns, unset ⇒ on (the default), 'off' ⇒ off. Flipping off closes
// the browser and unregisters every discovered output (a playing one tears
// down like any unregister); flipping on starts a fresh browse.
//
// TXT mapping (OwnTone's raop_device_cb): tp must contain "UDP"; am →
// devtype (helper start token); ek=1 → encrypt; sf bit 9 → needsAuthKey;
// pw → warn (passwords unsupported). The id is the mDNS instance's 64-bit
// id in decimal — stable across IP changes, digits for the OwnTone id regex.
import type { MdnsBrowser, MdnsService } from '../mdns.ts';
import { createMdnsBrowser } from '../mdns.ts';
import type { Outputs } from '../player.ts';
import type { State } from '../state.ts';

export const MDNS_KEY = 'airplay.mdns';

/** OwnTone's raop_device_cb model-string → the helper's devtype token. */
export function devtypeFromAm(am: string | undefined): string {
  if (am === undefined) return 'apex1'; // first-gen AirPort Express (no am)
  if (am.startsWith('AirPort4')) return 'apex2';
  if (am.startsWith('AirPort')) return 'apex3';
  if (am.startsWith('AppleTV5,3')) return 'appletv4';
  if (am.startsWith('AppleTV')) return 'appletv';
  if (am.startsWith('AudioAccessory')) return 'homepod';
  return 'other';
}

/** Parse the mDNS instance name: <64-bit hex id>@<pretty name>, with the
 * `._raop._tcp.local` domain suffix stripped (the label is `id@name`). */
function parseInstance(name: string): { id: string; name: string } | null {
  const label = name.replace(/\._raop\._tcp\.local\.?$/i, '');
  const at = label.indexOf('@');
  if (at < 1 || at + 1 >= label.length) return null;
  const hex = label.slice(0, at);
  if (!/^[0-9a-fA-F]+$/.test(hex)) return null;
  return { id: BigInt(`0x${hex}`).toString(10), name: label.slice(at + 1) };
}

/** sf flags: bit 9 means the device wants verification (OwnTone). */
function wantsAuth(sf: string | undefined): boolean {
  if (sf === undefined) return false;
  const hex = sf.startsWith('0x') ? sf.slice(2) : sf;
  if (!/^[0-9a-fA-F]+$/.test(hex)) return false;
  return ((BigInt(`0x${hex}`) >> 9n) & 1n) === 1n;
}

export interface AirplayDiscoveryDeps {
  outputs: Outputs;
  state: State;
  /** Injectable browser factory for tests; default browses _raop._tcp. */
  createBrowser?: (
    onService: (event: 'up' | 'down', service: MdnsService) => void,
  ) => MdnsBrowser;
  log?: (msg: string) => void;
}

export function createAirplayDiscovery(
  deps: AirplayDiscoveryDeps,
): { close(): void } {
  const { outputs, state } = deps;
  const log = deps.log ?? ((msg: string) => console.warn(`[melofon] ${msg}`));
  const createBrowser = deps.createBrowser ??
    ((onService: (event: 'up' | 'down', service: MdnsService) => void) =>
      createMdnsBrowser({
        type: '_raop._tcp',
        onService,
        onError: (err) =>
          log(
            `airplay discovery unavailable (no multicast?): ${err} — ` +
              'manual registration via POST /_/outputs still works',
          ),
      }));

  let browser: MdnsBrowser | null = null;
  const discovered = new Set<string>();
  let closed = false;

  const onService = (event: 'up' | 'down', svc: MdnsService) => {
    if (event === 'down') {
      const parsed = parseInstance(svc.name);
      if (parsed !== null && discovered.delete(parsed.id)) {
        outputs.unregister(parsed.id);
      }
      return;
    }
    // 'up'
    const parsed = parseInstance(svc.name);
    if (parsed === null) {
      log(`airplay discovery: skipping odd instance name '${svc.name}'`);
      return;
    }
    if (!(svc.txt.tp ?? '').includes('UDP')) return; // not AirTunes v2

    if (outputs.list().some((o) => o.host === svc.address)) {
      // Manual registration (or another output) already owns this address.
      return;
    }
    if (svc.txt.pw !== undefined && svc.txt.pw !== 'false') {
      log(
        `airplay discovery: '${parsed.name}' asks for a password — ` +
          'unsupported, registration may fail on play',
      );
    }
    outputs.register({
      id: parsed.id,
      name: parsed.name,
      type: 'AirPlay',
      selected: false,
      volume: 100,
      host: svc.address,
      port: svc.port,
      devtype: devtypeFromAm(svc.txt.am),
      encrypt: svc.txt.ek === '1',
      needsAuthKey: wantsAuth(svc.txt.sf),
    });
    discovered.add(parsed.id);
  };

  const start = () => {
    if (browser !== null || closed) return;
    browser = createBrowser(onService);
  };

  const stop = () => {
    browser?.close();
    browser = null;
    for (const id of discovered) outputs.unregister(id);
    discovered.clear();
  };

  void state.get(MDNS_KEY).then((value) => {
    if (value !== 'off') start();
  });
  const unsubscribe = state.onChange((key, value) => {
    if (key !== MDNS_KEY) return;
    if (value === 'off') stop();
    else start();
  });

  return {
    close() {
      closed = true;
      unsubscribe();
      stop();
    },
  };
}
