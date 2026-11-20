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
  /** Control-only probe; never supplies PCM or starts the player. */
  probe?: boolean;
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
/** Explicit stream input, independent of device-control/retirement lifetimes.
 * PCM calls are supplied serially by the stream's single source owner. Producer
 * cancellation does not yet implement native ordered epoch cancellation. */
export interface AirplayStream {
  readonly id: bigint;
  attach(
    event: HelperEventFn,
    credential?: PairingCredentialConsumer,
  ): AirplayDriver & { readonly id: bigint; readonly streamId: bigint };
  pcm(chunk: Uint8Array): Promise<void>;
  cancelPcm(): void;
  /** Fence and join admitted writers, then discard local ingress/partial PCM.
   * Later writes wait for reset; earlier queued writes are canceled. This does
   * not await decoder acquisition or prove receiver FLUSH readiness. */
  reset(): Promise<void>;
  close(): Promise<void>;
}
export type AirplayAppendStatus =
  | 'accepted'
  | 'backpressure'
  | 'canceled'
  | 'error'
  | 'not-ready';
export type AirplayAppendError = 'invalid' | 'busy' | 'allocation' | 'closing';
export interface AirplayAppendInput {
  readonly epoch: bigint;
  readonly segment: bigint;
  readonly pcm: Uint8Array;
}
export type AirplayAppendResult = Readonly<
  & {
    streamId: bigint;
    epoch: bigint;
    segment: bigint;
    acceptedFrames: bigint;
  }
  & (
    | { status: Exclude<AirplayAppendStatus, 'error'>; error?: never }
    | { status: 'error'; error: AirplayAppendError }
  )
>;
/** Exact input port. One admission attempt, never an implicit retry or
 * drain wait. A receipt owns only its copied prefix; segment is an opaque core
 * identity, not queue policy. Compatibility pcm/reset callers remain separate
 * from production playback. No playout claim is implied. */
export interface AirplayExactStream extends AirplayStream {
  readonly epoch: bigint;
  append(input: AirplayAppendInput): Promise<AirplayAppendResult>;
  /** Synchronously fence/advance the captured epoch; resolve after local reset
   * and receiver readiness, or supersession/close. Listed attachment identities
   * retire instead of FLUSH; omitted attachments retain the FLUSH default.
   * Retained until explicit ack. */
  cancel(
    epoch: bigint,
    retire?: readonly bigint[],
  ): Promise<AirplayCancelResult>;
  ackCancel(epoch: bigint): Promise<void>;
}
export interface AirplayCancelResult {
  readonly streamId: bigint;
  readonly epoch: bigint;
  readonly nextEpoch: bigint;
  readonly status: 'ready' | 'canceled' | 'failed';
  /** Null only if close canceled the poll before the local cutoff was captured. */
  readonly cutoffFrames: bigint | null;
  readonly admittedNs: bigint;
}
/** Ordered transport timeline used by the production boot/core. Source targets
 * are exclusive source-local real frames; endStream targets epoch-wide accepted
 * real frames. Pacer snapshots are distinct from scheduled progress/completion. */
export interface AirplayTimelineStream extends AirplayExactStream {
  metadata(input: {
    epoch: bigint;
    source: bigint;
    sourceFrame: bigint;
    originFrame: bigint;
    durationFrames: bigint;
    title: string;
    artist: string;
  }): Promise<'accepted' | 'backpressure' | 'canceled'>;
  /** Same ordered cancellation, with the named old source's immutable native
   * projection captured before reset. Ack together through ackCancel(epoch). */
  cancelSource(
    epoch: bigint,
    source: bigint,
    retire?: readonly bigint[],
    capture?: (cutoff: AirplaySourceCutoff) => void,
  ): Promise<AirplaySourceCancelResult>;
  /** Legacy local reset is refused after timeline admission. Use cancel(epoch)
   * so identities and immutable targets cannot be erased within an epoch. */
  reset(): Promise<void>;
  appendSource(
    input: AirplayAppendInput & { readonly source: bigint },
  ): Promise<
    AirplayAppendResult & {
      readonly source: bigint;
      readonly sourceOffset: bigint;
      readonly inputOffset: bigint;
    }
  >;
  seal(
    epoch: bigint,
    source: bigint,
    target: bigint,
  ): Promise<AirplayMarkerResult>;
  endStream(epoch: bigint, target: bigint): Promise<AirplayMarkerResult>;
  /** Join native end/drain and pacer quiescence, not just input acceptance.
   * Reject on cancellation, transport failure or close. No release claim. */
  waitDrain(epoch: bigint): Promise<void>;
  compatibilitySilence(epoch: bigint, source: bigint): Promise<void>;
  source(epoch: bigint, source: bigint): Promise<AirplaySourceSnapshot | null>;
  range(epoch: bigint, index: bigint): Promise<AirplayRangeSnapshot | null>;
  progress(
    epoch: bigint,
    source?: bigint,
    attachment?: bigint,
  ): Promise<AirplayProgressSnapshot | null>;
  /** Retained poll, never an implicit ack. Serialize ack with readers of the
   * same receipt. Ack only after committing its matching core outcome. */
  pollCompletion(
    key: AirplayCompletionKey,
  ): Promise<AirplayCompletionResult | null>;
  waitCompletion(key: AirplayCompletionKey): Promise<AirplayCompletionResult>;
  /** Explicit exclusion creates revision + 1; old terminal outcomes survive. */
  reviseCompletion(
    key: AirplayCompletionKey,
    exclude: readonly bigint[],
  ): Promise<AirplayCompletionKey>;
  ackCompletion(key: AirplayCompletionKey): Promise<void>;
}
/** Immutable local cutoff, observed after admission applies but independently of
 * remote FLUSH/retirement readiness. Publishing it never permits input or ACK.
 * The optional capture runs once, asynchronously, inside the owned cancel poll. */
export interface AirplaySourceCutoff {
  readonly streamId: bigint;
  readonly epoch: bigint;
  readonly nextEpoch: bigint;
  readonly source: bigint;
  readonly admittedNs: bigint;
  readonly progress: AirplayProgressSnapshot;
}
export interface AirplaySourceCancelResult extends AirplayCancelResult {
  readonly source: bigint;
  /** Null only if supersession/close returned before local cutoff capture. */
  readonly progress: AirplayProgressSnapshot | null;
}
export interface AirplayCompletionKey {
  readonly epoch: bigint;
  readonly source: bigint;
  readonly target: bigint;
  readonly revision: bigint;
}
export interface AirplayCompletionResult extends AirplayCompletionKey {
  readonly streamId: bigint;
  readonly inputEnd: bigint;
  readonly status: 'pending' | 'complete' | 'canceled' | 'failed';
  readonly error: AirplayProgressSnapshot['error'];
  readonly transportEnd: bigint;
  readonly capturedNs: bigint;
  readonly required: bigint;
  readonly attachments: readonly Readonly<{
    attachment: bigint;
    session: bigint;
    outcome: 'pending' | 'complete' | 'withdrawn' | 'failed' | 'canceled';
    excluded: boolean;
    error: AirplayProgressSnapshot['error'];
    coverageStart: bigint;
    submittedFrames: bigint;
    scheduledFrames: bigint;
  }>[];
}
/** Coherent native fact, not a terminal completion receipt. All boundaries are
 * exclusive epoch transport frames. A join covers a suffix, never prior audio.
 * Failed snapshots freeze the last proven group prefix, even after session loss.
 * Acknowledged source/range observations are retired; real/silence/source counts
 * project retained ranges only. Transport boundaries remain epoch-absolute. */
export interface AirplayProgressSnapshot {
  readonly streamId: bigint;
  readonly epoch: bigint;
  readonly source: bigint;
  readonly attachment: bigint;
  readonly capturedNs: bigint;
  readonly status: 'waiting' | 'scheduled' | 'failed';
  readonly error:
    | 'none'
    | 'allocation'
    | 'encoder'
    | 'cipher'
    | 'send'
    | 'sync'
    | 'overdue'
    | 'transport';
  readonly participants: bigint;
  readonly coverageStart: bigint;
  readonly submittedFrames: bigint;
  readonly scheduledFrames: bigint;
  readonly scheduleOriginNs: bigint;
  readonly fedFrames: bigint;
  readonly realFrames: bigint;
  readonly silenceFrames: bigint;
  readonly sourceFrames: bigint;
}
export type AirplayMarkerResult = Readonly<
  & {
    streamId: bigint;
    epoch: bigint;
    source: bigint;
    target: bigint;
    inputEnd: bigint;
  }
  & (
    | { status: Exclude<AirplayAppendStatus, 'error'>; error?: never }
    | { status: 'error'; error: AirplayAppendError }
  )
>;
export interface AirplaySourceSnapshot {
  readonly streamId: bigint;
  readonly epoch: bigint;
  readonly source: bigint;
  readonly acceptedFrames: bigint;
  readonly fedFrames: bigint;
  readonly sealed: boolean;
  readonly target: bigint | null;
  readonly inputEnd: bigint | null;
}
export interface AirplayRangeSnapshot {
  readonly streamId: bigint;
  readonly epoch: bigint;
  readonly index: bigint;
  readonly kind: 'real' | 'underrun' | 'padding' | 'drain' | 'compatibility';
  readonly source: bigint;
  readonly segment: bigint;
  readonly sourceOffset: bigint;
  readonly transportStart: bigint;
  readonly frames: bigint;
}
/** A fixed player's lazily allocated stream. Device admission holds the private
 * attachment authority; producers cannot construct or rebind receiver handles.
 * Closing joins admitted preparation, activation and PCM before releasing native
 * storage and capacity. A failed close remains quarantined. */
export interface AirplayPlaybackStream extends
  Pick<
    AirplayTimelineStream,
    | 'appendSource'
    | 'metadata'
    | 'seal'
    | 'endStream'
    | 'waitDrain'
    | 'compatibilitySilence'
    | 'source'
    | 'range'
    | 'progress'
    | 'pollCompletion'
    | 'waitCompletion'
    | 'reviseCompletion'
    | 'ackCompletion'
  > {
  readonly id: bigint | null;
  /** Null until an attachment or input allocates the native stream. */
  readonly epoch: bigint | null;
  append(input: AirplayAppendInput): Promise<AirplayAppendResult>;
  cancel(
    epoch: bigint,
    retire?: readonly AirplayTransport[],
  ): Promise<AirplayCancelResult>;
  ackCancel(epoch: bigint): Promise<void>;
  cancelSource(
    epoch: bigint,
    source: bigint,
    retire?: readonly AirplayTransport[],
    capture?: (cutoff: AirplaySourceCutoff) => void,
  ): Promise<AirplaySourceCancelResult>;
  /** Transitional callers only; production uses source-labelled append/cancel. */
  pcm(chunk: Uint8Array): Promise<void>;
  cancelPcm(): void;
  /** Same writer-fenced local reset contract as AirplayStream. */
  reset(): Promise<void>;
  close(): Promise<void>;
}
/** Private start input, never part of normalized facts or diagnostics. */
export interface AirplayCredentials {
  password: string | null;
  pairingKey: string | null;
}
/** Private, acknowledged pairing-state receipt. Resolve only after accepting the
 * state; reject to retry the same revision. Never send through HelperEventFn.
 * The consumer must also fence its stable speaker/credential lifetime. */
export type PairingCredentialConsumer = (change: {
  revision: bigint;
  key: string | null;
  isCurrent(): boolean;
}) => Promise<void>;
export type AirplaySpawn = (
  event: HelperEventFn,
  credential?: PairingCredentialConsumer,
) => AirplayDriver;

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
