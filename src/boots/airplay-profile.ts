// Leaf protocol types/normalization; no discovery or playback dependencies.
import { isIPv4 } from 'node:net';
import type { MdnsService } from '../mdns.ts';
import { type OutputEndpoint, PreparationError } from '../output-admission.ts';
import type { SpeakerAbilities } from '../speakers.ts';

export type AirplayControl =
  | { cmd: 'volume'; volume: number }
  | { cmd: 'flush' }
  | { cmd: 'teardown' }
  | { cmd: 'pin'; pin: string };
export type HelperEventFn = (event: string, value?: string) => void;
export interface AirplayTransport {
  send(cmd: AirplayControl): Promise<void>;
  pcm(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
  ownsSharedFeed(): boolean;
  cancelPcm(): void;
}
export interface AirplayInput {
  volume: number;
  positionMs: number;
  lengthMs: number;
  title: string;
  artist: string;
}
export interface AirplayProfile {
  requestedHost: string;
  host: string;
  port: number;
  name: string;
  service: string;
  model?: string;
  devtype: string;
  encrypt: boolean;
  wantedMetadata: number;
  supportsAuthSetup: boolean;
  requiresAuth: boolean;
  hasPassword: boolean;
  sampleRate: number;
  bitsPerSample: number;
  channels: number;
}
export interface AirplayDriver {
  transport: AirplayTransport;
  start(
    profile: Readonly<AirplayProfile>,
    input: AirplayInput,
    credentials?: AirplayCredentials,
  ): Promise<void>;
}
/** Private start input, never part of normalized facts or diagnostics. */
export interface AirplayCredentials {
  password: string | null;
  pairingKey: string | null;
}
export type AirplaySpawn = (event: HelperEventFn) => AirplayDriver;

/** Bridge input format, not the ALAC packet encoding or an AAC promise. */
export function airplayAbilities(
  profile: Readonly<AirplayProfile>,
): SpeakerAbilities {
  return {
    volume: true,
    seek: true,
    pin: profile.requiresAuth,
    password: profile.hasPassword,
    formats: ['pcm'],
  };
}

export function passwordRequiredFromTxt(txt: Record<string, string>): boolean {
  return txt.pw !== undefined && txt.pw !== 'false';
}

export function airplayOutputId(host: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(host)) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  }
  return hash.toString(10);
}

export function devtypeFromAm(am: string | undefined): string {
  if (am === undefined) return 'apex1';
  if (am.startsWith('AirPort4')) return 'apex2';
  if (am.startsWith('AirPort')) return 'apex3';
  if (am.startsWith('AppleTV5,3')) return 'appletv4';
  if (am.startsWith('AppleTV')) return 'appletv';
  if (am.startsWith('AudioAccessory')) return 'homepod';
  return 'other';
}
export const RAOP_MD_TEXT = 1, RAOP_MD_ARTWORK = 2, RAOP_MD_PROGRESS = 4;
export function wantedMetadataFromMd(md: string | undefined): number {
  return (md ?? '').split(',').reduce(
    (bits, token) =>
      bits | (token === '0' ? 1 : token === '1' ? 2 : token === '2' ? 4 : 0),
    0,
  );
}
export function supportsAuthSetupFromEt(et: string | undefined): boolean {
  return (et ?? '').split(',').includes('4');
}
function wantsAuth(sf: string | undefined): boolean {
  if (sf === undefined) return false;
  const hex = sf.startsWith('0x') ? sf.slice(2) : sf;
  if (!/^[0-9a-fA-F]+$/.test(hex)) {
    throw new PreparationError(
      'invalid',
      'invalid receiver verification flags',
    );
  }
  return ((BigInt(`0x${hex}`) >> 9n) & 1n) === 1n;
}
function quality(
  txt: Record<string, string>,
  key: string,
  expected: number,
): number {
  if (txt[key] === undefined) return expected;
  if (!/^\d+$/.test(txt[key]) || Number(txt[key]) !== expected) {
    throw new PreparationError('unsupported', `unsupported receiver ${key}`);
  }
  return expected;
}
export function sessionFieldsFromTxt(txt: Record<string, string>) {
  const requiresAuth = wantsAuth(txt.sf);
  const model = txt.am?.trim();
  return {
    devtype: devtypeFromAm(txt.am),
    ...(model ? { model } : {}),
    encrypt: txt.ek === '1',
    wantedMetadata: wantedMetadataFromMd(txt.md),
    supportsAuthSetup: supportsAuthSetupFromEt(txt.et),
    requiresAuth,
    hasPassword: passwordRequiredFromTxt(txt),
    sampleRate: quality(txt, 'sr', 44100),
    bitsPerSample: quality(txt, 'ss', 16),
    channels: quality(txt, 'ch', 2),
  };
}
export function profileFromService(
  service: MdnsService,
  requestedHost = service.address,
): AirplayProfile {
  if (!(service.txt.tp ?? '').split(',').includes('UDP')) {
    throw new PreparationError(
      'unsupported',
      'receiver does not advertise UDP',
    );
  }
  const label = service.name.replace(/\._raop\._tcp\.local\.?$/i, '');
  const profile = {
    requestedHost,
    host: service.address,
    port: service.port,
    name: label.includes('@') ? label.slice(label.indexOf('@') + 1) : label,
    service: service.name,
    ...sessionFieldsFromTxt(service.txt),
  };
  validateAirplayProfile(profile, {
    id: '',
    protocol: 'AirPlay',
    address: requestedHost,
  });
  return Object.freeze(profile);
}
export function validateAirplayProfile(
  profile: Readonly<AirplayProfile>,
  endpoint: OutputEndpoint,
): void {
  if (
    profile.requestedHost !== endpoint.address ||
    (isIPv4(endpoint.address) && profile.host !== endpoint.address) ||
    (endpoint.port !== undefined && profile.port !== endpoint.port)
  ) throw new PreparationError('stale', 'receiver endpoint mismatch');
  if (
    !isIPv4(profile.host) || !Number.isInteger(profile.port) ||
    profile.port < 1 || profile.port > 65535 || !profile.service
  ) throw new PreparationError('invalid', 'invalid receiver endpoint');
  if (
    !['apex1', 'apex2', 'apex3', 'appletv', 'appletv4', 'homepod', 'other']
      .includes(profile.devtype) ||
    typeof profile.encrypt !== 'boolean' ||
    typeof profile.supportsAuthSetup !== 'boolean' ||
    typeof profile.requiresAuth !== 'boolean' ||
    typeof profile.hasPassword !== 'boolean' ||
    !Number.isInteger(profile.wantedMetadata) || profile.wantedMetadata < 0 ||
    profile.wantedMetadata > 7
  ) throw new PreparationError('invalid', 'incomplete receiver configuration');
  if (
    profile.sampleRate !== 44100 || profile.bitsPerSample !== 16 ||
    profile.channels !== 2
  ) throw new PreparationError('unsupported', 'unsupported PCM quality');
}

/** Diagnostic/test representation only; it cannot start a transport. */
export function airplayStartFields(
  profile: Readonly<AirplayProfile>,
  input: AirplayInput,
) {
  return {
    cmd: 'start',
    host: profile.host,
    port: profile.port,
    name: profile.name,
    volume: input.volume,
    devtype: profile.devtype,
    encrypt: profile.encrypt,
    wanted_metadata: profile.wantedMetadata,
    authsetup: profile.supportsAuthSetup ? 1 : 0,
    requires_auth: profile.requiresAuth ? 1 : 0,
    pos_ms: input.positionMs,
    len_ms: input.lengthMs,
    title: input.title,
    artist: input.artist,
  };
}
