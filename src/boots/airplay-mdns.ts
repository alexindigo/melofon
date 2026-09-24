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

/** OwnTone raop.c:96-98 / raop_device_cb md tokens: 0=text 1=artwork 2=progress. */
export const RAOP_MD_TEXT = 1 << 0;
export const RAOP_MD_ARTWORK = 1 << 1;
export const RAOP_MD_PROGRESS = 1 << 2;

export function wantedMetadataFromMd(md: string | undefined): number {
  if (md === undefined || md === '') return 0;
  let bits = 0;
  for (const token of md.split(',')) {
    if (token === '0') bits |= RAOP_MD_TEXT;
    else if (token === '1') bits |= RAOP_MD_ARTWORK;
    else if (token === '2') bits |= RAOP_MD_PROGRESS;
  }
  return bits;
}

/** TXT `et` token 4: the device supports (does not require) auth-setup. */
export function supportsAuthSetupFromEt(et: string | undefined): boolean {
  if (et === undefined) return false;
  return et.split(',').includes('4');
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

/** OwnTone raop_device_cb session knobs from a device TXT. */
export function sessionFieldsFromTxt(txt: Record<string, string>): {
  devtype: string;
  encrypt: boolean;
  wantedMetadata: number;
  supportsAuthSetup: boolean;
  requiresAuth: boolean;
  needsAuthKey: boolean;
  sampleRate?: number;
  bitsPerSample?: number;
  channels?: number;
} {
  const requiresAuth = wantsAuth(txt.sf);
  const sampleRate = Number.parseInt(txt.sr ?? '', 10);
  const bitsPerSample = Number.parseInt(txt.ss ?? '', 10);
  const channels = Number.parseInt(txt.ch ?? '', 10);
  return {
    devtype: devtypeFromAm(txt.am),
    encrypt: txt.ek === '1',
    wantedMetadata: wantedMetadataFromMd(txt.md),
    supportsAuthSetup: supportsAuthSetupFromEt(txt.et),
    requiresAuth,
    needsAuthKey: requiresAuth,
    ...(Number.isFinite(sampleRate) && sampleRate > 0 && { sampleRate }),
    ...(Number.isFinite(bitsPerSample) && bitsPerSample > 0 &&
      { bitsPerSample }),
    ...(Number.isFinite(channels) && channels > 0 && { channels }),
  };
}

export interface AirplayDiscoveryDeps {
  outputs: Outputs;
  state: State;
  /** Injectable browser factory for tests; default browses _raop._tcp. */
  createBrowser?: (
    onService: (event: 'up' | 'down', service: MdnsService) => void,
  ) => MdnsBrowser;
  /** Persisted user state per output id (plan restart-transparency): a
   * device re-announcing while not registered (mDNS down→up, or a restart
   * before its row re-registers) gets its saved selection and volume back.
   * Absent ⇒ discovery defaults (selected: false, volume: 100). */
  savedOutput?: (
    id: string,
  ) => { selected: boolean; volume: number } | undefined;
  log?: (msg: string) => void;
}

export function createAirplayDiscovery(
  deps: AirplayDiscoveryDeps,
): {
  close(): void;
  resolve(address: string): Promise<MdnsService | null>;
} {
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
  const waiters = new Map<string, (svc: MdnsService) => void>();
  let closed = false;

  const onService = (event: 'up' | 'down', svc: MdnsService) => {
    if (event === 'up') {
      const waiter = waiters.get(svc.address);
      if (waiter !== undefined) waiter(svc);
    }
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
    if (!(svc.txt.tp ?? '').includes('UDP')) {
      log(
        `airplay discovery: skipping '${parsed.name}': no UDP in tp`,
      );
      return;
    }

    const fields = sessionFieldsFromTxt(svc.txt);
    const existing = outputs.get(parsed.id);
    // A device re-announcing while not registered (mDNS down→up, or a
    // restart before its row re-registers) gets its persisted user state
    // back — selection and volume survive the gap.
    const saved = existing === null ? deps.savedOutput?.(parsed.id) : undefined;
    // An identical re-announcement is a catalog no-op: same device, same
    // address, same session knobs. Skip the register so no outputs event
    // fires — chatty devices must not wake the session layer for nothing.
    if (
      existing !== null &&
      existing.host === svc.address &&
      existing.port === svc.port &&
      existing.devtype === fields.devtype &&
      (existing.encrypt ?? false) === fields.encrypt &&
      (existing.wantedMetadata ?? 0) === fields.wantedMetadata &&
      (existing.supportsAuthSetup ?? false) === fields.supportsAuthSetup &&
      (existing.requiresAuth ?? false) === fields.requiresAuth &&
      existing.sampleRate === fields.sampleRate &&
      existing.bitsPerSample === fields.bitsPerSample &&
      existing.channels === fields.channels
    ) {
      return;
    }

    // Host dedupe is for a DIFFERENT device claiming an owned address (a
    // manual registration wins over discovery). The same device updating
    // its own record is not a conflict.
    if (
      outputs.list().some((o) => o.id !== parsed.id && o.host === svc.address)
    ) {
      log(
        `airplay discovery: skipping '${parsed.name}': host already owned`,
      );
      return;
    }
    if (svc.txt.pw !== undefined && svc.txt.pw !== 'false') {
      log(
        `airplay discovery: '${parsed.name}' asks for a password — ` +
          'unsupported, registration may fail on play',
      );
    }
    // OwnTone raop_device_cb (raop.c:4463): one grep-able line vs the
    // registration log so a live session can be A/B'd against OwnTone.
    log(
      `airplay discovery: Adding AirPlay device '${parsed.name}': ` +
        `password: ${
          svc.txt.pw !== undefined && svc.txt.pw !== 'false' ? 1 : 0
        }, ` +
        `verification: ${fields.requiresAuth ? 1 : 0}, ` +
        `encrypt: ${fields.encrypt ? 1 : 0}, ` +
        `authsetup: ${fields.supportsAuthSetup ? 1 : 0}, ` +
        `metadata: ${fields.wantedMetadata}, ` +
        `type ${fields.devtype}, address ${svc.address}:${svc.port}`,
    );
    outputs.register({
      id: parsed.id,
      name: parsed.name,
      type: 'AirPlay',
      // Re-announcement must never wipe user state: an ethernet→wifi move
      // replaces the record (identity, address, TXT fields) but keeps
      // selection, volume, and PIN completion. A device that was gone gets
      // the persisted state back instead of the discovery defaults.
      selected: existing?.selected ?? saved?.selected ?? false,
      volume: existing?.volume ?? saved?.volume ?? 100,
      host: svc.address,
      port: svc.port,
      ...fields,
      ...(existing?.needsAuthKey !== undefined &&
        { needsAuthKey: existing.needsAuthKey }),
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

  const started = state.get(MDNS_KEY).then((value) => {
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
    async resolve(address: string) {
      await started;
      if (closed || browser === null) {
        log(
          `airplay discovery: resolve ${address} skipped (browser not running)`,
        );
        return null;
      }
      return await new Promise<MdnsService | null>((resolvePromise) => {
        const timer = setTimeout(() => {
          waiters.delete(address);
          log(
            `airplay discovery: resolve ${address} timed out ` +
              '(no TXT from the device)',
          );
          resolvePromise(null);
        }, 2000);
        waiters.set(address, (svc) => {
          clearTimeout(timer);
          waiters.delete(address);
          resolvePromise(svc);
        });
        browser!.resolve(address);
      });
    },
  };
}
