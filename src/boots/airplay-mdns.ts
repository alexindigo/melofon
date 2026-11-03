// src/boots/airplay-mdns.ts — AirPlay 1 discovery: browses _raop._tcp via
// src/mdns.ts (querier only — no Avahi, no daemon) and registers devices as
// outputs. Dedupe is by host: a manually-registered device (POST /_/outputs,
// MELOFON_AIRPLAY_HOST) wins over a discovered one at the same address.
//
// The toggle lives in internal state (app.state, /_/config): key
// airplay.mdns, unset ⇒ on (the default), 'off' ⇒ off. Flipping off closes
// the browser and withdraws every observation. Adopted configuration remains;
// observation-only rows are released. Flipping on starts a fresh browse.
//
// TXT mapping (OwnTone's raop_device_cb): tp must contain "UDP"; am →
// devtype (helper start token); ek=1 → encrypt; sf bit 9 → needsAuthKey;
// pw → warn (passwords unsupported). The id is the mDNS instance's 64-bit
// id in decimal — stable across IP changes, digits for the OwnTone id regex.
import type { MdnsBrowser, MdnsService } from '../mdns.ts';
import { type Log, scopedLog } from '../logging.ts';
import { createMdnsBrowser } from '../mdns.ts';
import type { Outputs } from '../player.ts';
import type { State } from '../state.ts';
import type { ConnectionStrategy } from '../connection-strategy.ts';
import type { AirplayDevices } from './airplay-device.ts';
import { profileFromService } from './airplay-profile.ts';
export {
  devtypeFromAm,
  sessionFieldsFromTxt,
  supportsAuthSetupFromEt,
  wantedMetadataFromMd,
} from './airplay-profile.ts';

export const MDNS_KEY = 'airplay.mdns';

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

export interface AirplayDiscoveryDeps {
  outputs: Outputs;
  state: State;
  devices: AirplayDevices;
  /** Injectable browser factory for tests; default browses _raop._tcp. */
  createBrowser?: (
    onService: (event: 'up' | 'down', service: MdnsService) => void,
  ) => MdnsBrowser;
  /** Persisted user state per output id (plan restart-transparency): a
   * device re-announcing while not registered (mDNS down→up, or a restart
   * before its row re-registers) gets its saved selection and volume back.
   * Absent ⇒ discovery defaults (selected: false, volume: 100). The saved
   * model is identity (plan atv3-session-recycle): a re-announcement whose
   * TXT omits `am` recovers it. */
  savedOutput?: (
    id: string,
  ) => {
    selected: boolean;
    volume: number;
    model?: string;
    connectionStrategy?: ConnectionStrategy;
  } | undefined;
  log?: Log;
}

export function createAirplayDiscovery(
  deps: AirplayDiscoveryDeps,
): {
  close(): void;
} {
  const { outputs, state } = deps;
  state.declare(MDNS_KEY, {
    type: 'string',
    enum: ['on', 'off'],
    default: 'on',
    description: 'Discover AirPlay outputs on the local network',
  });
  const log = deps.log ?? scopedLog('airplay-discovery');
  const createBrowser = deps.createBrowser ??
    ((onService: (event: 'up' | 'down', service: MdnsService) => void) =>
      createMdnsBrowser({
        type: '_raop._tcp',
        onService,
        onError: (err) => log.event('discovery_failed', { error: err }),
      }));

  let browser: MdnsBrowser | null = null;
  const discovered = new Set<string>();
  const signatures = new Map<string, string>();
  let closed = false;

  const onService = (event: 'up' | 'down', svc: MdnsService) => {
    if (event === 'down') {
      const parsed = parseInstance(svc.name);
      if (parsed !== null && discovered.delete(parsed.id)) {
        deps.devices.withdraw(parsed.id, {
          kind: 'internal',
          via: 'airplay-discovery',
        });
      }
      return;
    }
    // 'up'
    const parsed = parseInstance(svc.name);
    if (parsed === null) {
      log.event('discovery_skipped', { instance: svc.name, reason: 'name' });
      return;
    }
    if (!(svc.txt.tp ?? '').includes('UDP')) {
      log.event('discovery_skipped', {
        instance: parsed.name,
        reason: 'no_udp',
      });
      return;
    }

    if (svc.txt.pw !== undefined && svc.txt.pw !== 'false') {
      const existing = outputs.get(parsed.id);
      const saved = existing === null
        ? deps.savedOutput?.(parsed.id)
        : undefined;
      log.event('discovery_password', { instance: parsed.name });
      deps.devices.register(
        {
          id: parsed.id,
          name: parsed.name,
          type: 'AirPlay',
          host: svc.address,
          port: svc.port,
          selected: existing?.selected ?? saved?.selected ?? false,
          volume: existing?.volume ?? saved?.volume ?? 100,
          ...(svc.txt.am?.trim() ? { model: svc.txt.am.trim() } : {}),
        },
        { kind: 'internal', via: 'airplay-discovery' },
        svc,
      );
      discovered.add(parsed.id);
      return;
    }
    let profile: ReturnType<typeof profileFromService>;
    try {
      profile = profileFromService(svc);
    } catch (error) {
      log.event('discovery_invalid', { error });
      return;
    }
    const fields = {
      ...(profile.model === undefined ? {} : { model: profile.model }),
      requiresAuth: profile.requiresAuth,
      needsAuthKey: profile.requiresAuth,
    };
    const signature = JSON.stringify(profile);
    const existing = outputs.get(parsed.id);
    // A device re-announcing while not registered (mDNS down→up, or a
    // restart before its row re-registers) gets its persisted user state
    // back — selection and volume survive the gap.
    const saved = existing === null ? deps.savedOutput?.(parsed.id) : undefined;
    // An identical re-announcement is a catalog no-op: same device, same
    // address, same session knobs, same effective model. Skip the register
    // so no outputs event fires — chatty devices must not wake the session
    // layer for nothing. Model identity precedence is fresh `am` → existing
    // → saved: a TXT that newly carries `am` (or changes it) is a real
    // catalog update even when both models map to the same devtype, while a
    // TXT without `am` neither erases nor churns the known model.
    if (
      existing !== null &&
      outputs.lifetime(parsed.id).discovered &&
      existing.host === svc.address &&
      existing.port === svc.port &&
      signatures.get(parsed.id) === signature &&
      (fields.model === undefined || fields.model === existing.model)
    ) {
      deps.devices.observe(parsed.id, svc);
      return;
    }

    // Host dedupe is for a DIFFERENT device claiming an owned address (a
    // manual registration wins over discovery). The same device updating
    // its own record is not a conflict.
    if (
      outputs.list().some((o) => o.id !== parsed.id && o.host === svc.address)
    ) {
      log.event('discovery_skipped', {
        instance: parsed.name,
        reason: 'host_owned',
      });
      return;
    }
    if (svc.txt.pw !== undefined && svc.txt.pw !== 'false') {
      log.event('discovery_password', { instance: parsed.name });
    }
    // OwnTone raop_device_cb (raop.c:4463): one grep-able line vs the
    // registration log so a live session can be A/B'd against OwnTone.
    log.event('discovery_device', {
      instance: parsed.name,
      host: svc.address,
      port: svc.port,
      requiresAuth: fields.requiresAuth,
      encrypt: profile.encrypt,
      authsetup: profile.supportsAuthSetup,
      metadata: profile.wantedMetadata,
      devtype: profile.devtype,
    });
    deps.devices.register(
      {
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
        // Model identity: fresh `am` rides the ...fields spread; when the TXT
        // omits it, a live record's model survives inside register() and a
        // returning device's saved model is recovered here.
        ...(existing === null && fields.model === undefined &&
          saved?.model !== undefined && { model: saved.model }),
        ...(existing?.needsAuthKey !== undefined &&
          { needsAuthKey: existing.needsAuthKey }),
      },
      { kind: 'internal', via: 'airplay-discovery' },
      svc,
    );
    signatures.set(parsed.id, signature);
    discovered.add(parsed.id);
  };

  const start = () => {
    if (browser !== null || closed) return;
    browser = createBrowser(onService);
  };

  const stop = () => {
    browser?.close();
    browser = null;
    for (const id of discovered) {
      deps.devices.withdraw(id, { kind: 'internal', via: 'airplay-discovery' });
    }
    discovered.clear();
  };

  void state.getTyped(MDNS_KEY).then((value) => {
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
