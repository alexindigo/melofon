// src/boots/raop-ffi.ts — the RAOP FFI transport: OwnTone's RAOP C loaded
// IN-PROCESS via Deno.dlopen (helper/raop/libmelofon_raop.so — same class as
// DuckDB / node-av loading as addons; no helper binary, no process spawn,
// users never compile). This module is the only file that touches
// Deno.dlopen. The C API is flat and callback-free (helper/raop/ffi.h):
// commands in, events drained by raop_poll — no UnsafeCallback hazard.
//
// Library resolution order: MELOFON_RAOP_LIB → the repo's helper/raop build
// → /usr/lib/melofon/ (packaging). A missing or unloadable library is a loud
// error at boot creation — never a half-spawned thing at play time.
//
// Transitional device-oriented path, retained until boot adoption: one master
// stream, many devices. The additive createFfiStream port below has one native
// PCM/pacer owner with immutable attachments and no receiver-writer election.
// Both paths share the native active-stream guard. Compatibility masters match
// per stream+quality+encrypt, so N selected outputs share OwnTone's synced
// multi-speaker model. The boot pumps PCM per output; this module designates
// the first writer as THE FEED and silently accepts-and-drops the other
// handles' writes (their decode is wasted CPU, the wire stays sane). When
// the feed's handle closes, the next writer takes over — but only after the
// close PROVES native cleanup: a failed free keeps the token, so no bytes
// are optimistically routed through a broken native state (plan
// atv3-session-recycle).
import type {
  AirplayAppendError,
  AirplayAppendResult,
  AirplayAppendStatus,
  AirplayCancelResult,
  AirplayControl,
  AirplayCredentials,
  AirplayDriver,
  AirplayExactStream,
  AirplayInput,
  AirplayProfile,
  AirplayTransport,
  HelperEventFn,
  PairingCredentialConsumer,
} from './airplay-profile.ts';
import { appLogger, type EventFacts, type Log, scopedLog } from '../logging.ts';
import { createOperationScope } from '../operations.ts';
import { createReleaseSet, releaseOrThrow } from '../releases.ts';

const SYMBOLS = {
  raop_log_consumer: { parameters: ['i32'], result: 'i32' },
  raop_log_poll: { parameters: ['buffer', 'usize'], result: 'i32' },
  raop_new: { parameters: [], result: 'pointer' },
  raop_stream_new: { parameters: [], result: 'pointer' },
  raop_stream_id: { parameters: ['pointer'], result: 'u64' },
  raop_stream_epoch: { parameters: ['pointer'], result: 'u64' },
  raop_stream_append: {
    parameters: ['pointer', 'u64', 'u64', 'buffer', 'usize', 'buffer'],
    result: 'i32',
  },
  raop_stream_cancel: { parameters: ['pointer', 'u64'], result: 'i32' },
  raop_stream_cancel_poll: {
    parameters: ['pointer', 'u64', 'buffer'],
    result: 'i32',
  },
  raop_stream_cancel_ack: { parameters: ['pointer', 'u64'], result: 'i32' },
  raop_stream_attach: { parameters: ['pointer'], result: 'pointer' },
  raop_attachment_id: { parameters: ['pointer'], result: 'u64' },
  raop_stream_write: {
    parameters: ['pointer', 'buffer', 'usize'],
    result: 'i32',
  },
  raop_stream_reset: {
    parameters: ['pointer'],
    result: 'i32',
    nonblocking: true,
  },
  raop_stream_free: {
    parameters: ['pointer'],
    result: 'i32',
    nonblocking: true,
  },
  raop_start_v2: {
    parameters: [
      'pointer',
      'buffer',
      'i32',
      'buffer',
      'i32',
      'i32',
      'i32',
      'u32',
      'u32',
      'u16',
      'i32',
      'i32',
      'buffer',
      'buffer',
      'i32',
      'buffer',
      'usize',
      'buffer',
      'usize',
    ],
    result: 'i32',
  },
  raop_probe_v2: {
    parameters: [
      'pointer',
      'buffer',
      'i32',
      'buffer',
      'i32',
      'i32',
      'i32',
      'u32',
      'u32',
      'u16',
      'i32',
      'i32',
      'buffer',
      'buffer',
      'i32',
      'buffer',
      'usize',
      'buffer',
      'usize',
    ],
    result: 'i32',
  },
  raop_write: { parameters: ['pointer', 'buffer', 'usize'], result: 'i32' },
  raop_volume: { parameters: ['pointer', 'i32'], result: 'i32' },
  raop_flush: { parameters: ['pointer'], result: 'i32' },
  raop_teardown: { parameters: ['pointer'], result: 'i32' },
  raop_pin: { parameters: ['pointer', 'buffer'], result: 'i32' },
  raop_poll: { parameters: ['pointer', 'buffer', 'usize'], result: 'i32' },
  raop_credential_poll: {
    parameters: ['pointer', 'buffer', 'buffer', 'usize'],
    result: 'i32',
  },
  raop_credential_ack: { parameters: ['pointer', 'u64'], result: 'i32' },
  // -1 = the native free could not be queued; the handle is leaked by design
  // and close() must report failure, not retirement success (ffi.h).
  raop_free: { parameters: ['pointer'], result: 'i32', nonblocking: true },
} as const;

type RaopLibrary = Deno.DynamicLibrary<typeof SYMBOLS>;

const REPO_LIB_PATH = decodeURIComponent(
  new URL('../../helper/raop/libmelofon_raop.so', import.meta.url).pathname,
);
const SYSTEM_LIB_PATH = '/usr/lib/melofon/libmelofon_raop.so';

function resolveLibPath(): string {
  const env = Deno.env.get('MELOFON_RAOP_LIB')?.trim();
  if (env) return env;
  for (const path of [REPO_LIB_PATH, SYSTEM_LIB_PATH]) {
    try {
      Deno.statSync(path);
      return path;
    } catch { /* try the next */ }
  }
  throw new Error(
    'RAOP library not found — build it with: make -C helper/raop ' +
      `(or set MELOFON_RAOP_LIB; tried ${REPO_LIB_PATH}, ${SYSTEM_LIB_PATH})`,
  );
}

let loaded: RaopLibrary | undefined;
let logDrain: ReturnType<typeof setInterval> | undefined;
let diagnosticLog: Log = scopedLog('raop-native');
let activeHandles = 0;
let activeStreams = 0;
function startLogDrain(): void {
  if (logDrain !== undefined) return;
  logDrain = setInterval(drainLogs, 25);
  Deno.unrefTimer(logDrain);
}
function drainLogs(): void {
  if (!loaded) return;
  const buffer = new Uint8Array(32768);
  for (let i = 0; i < 512; i++) {
    const n = loaded.symbols.raop_log_poll(buffer, BigInt(buffer.length));
    if (n <= 0) return;
    diagnosticLog.event(
      'native_record',
      JSON.parse(
        new TextDecoder().decode(buffer.subarray(0, n)),
      ) as EventFacts['native_record'],
    );
  }
}
/** Quiesce/free owned transports first. Keep the shared consumer through last free. */
export function shutdownNativeLogging(): void {
  if (!loaded) return;
  drainLogs();
  if (activeHandles !== 0 || activeStreams !== 0) return;
  if (logDrain !== undefined) clearInterval(logDrain);
  logDrain = undefined;
  loaded.symbols.raop_log_consumer(0);
  loaded.close();
  loaded = undefined;
}

function loadLibrary(log: Log = scopedLog('raop-native')): RaopLibrary {
  if (loaded !== undefined) return loaded;
  const path = resolveLibPath();
  diagnosticLog = log;
  try {
    const library = Deno.dlopen(path, SYMBOLS);
    if (library.symbols.raop_log_consumer(1) < 0) {
      library.close();
      throw new Error('RAOP diagnostic consumer already owned');
    }
    loaded = library;
    startLogDrain();
    drainLogs();
    addEventListener('unload', shutdownNativeLogging, { once: true });
  } catch (err) {
    throw new Error(`RAOP library ${path} failed to load`, { cause: err });
  }
  return loaded;
}

const text = new TextEncoder();
const decode = new TextDecoder();

/** raop.c enum raop_devtype values for raop_start's devtype param. */
const DEVTYPE: Record<string, number> = {
  apex1: 0,
  apex2: 1,
  apex3: 2,
  appletv: 3,
  appletv4: 4,
  homepod: 5,
  other: 6,
};

function cstr(value: string): Uint8Array {
  const out = new Uint8Array(text.encode(value).length + 1);
  out.set(text.encode(value));
  return out; // NUL-terminated (Uint8Array is zero-filled)
}

// ---------------------------------------------------------------------------
// Feed election: exactly one handle writes into the shared RAOP stream.

let feed: symbol | null = null;

// ---------------------------------------------------------------------------

class FfiTransport implements AirplayTransport {
  readonly attachmentId: bigint;
  private readonly lib: RaopLibrary;
  private readonly handle: Deno.PointerObject;
  private readonly token = Symbol('raop');
  private readonly onEvent: HelperEventFn;
  private readonly pollTimer: ReturnType<typeof setInterval>;
  private closed = false;
  private closePromise: Promise<void> | null = null;
  private credentialPending = false;
  /** PCM write generation (plan atv3-session-recycle): bumped synchronously
   * before every FLUSH/TEARDOWN/close, so a pcm() call already parked in
   * backpressure from BEFORE the discontinuity abandons its remaining
   * bytes instead of letting an old chunk cross into the new state. */
  private writeGen = 0;

  constructor(
    lib: RaopLibrary,
    onEvent: HelperEventFn,
    private readonly onCredential?: PairingCredentialConsumer,
    private readonly stream?: Deno.PointerObject,
  ) {
    this.lib = lib;
    this.onEvent = onEvent;
    const handle = stream
      ? lib.symbols.raop_stream_attach(stream)
      : lib.symbols.raop_new();
    drainLogs();
    if (handle === null) {
      throw new Error('raop_new failed (out of memory or loop thread)');
    }
    this.handle = handle;
    this.attachmentId = lib.symbols.raop_attachment_id(handle);
    activeHandles++;
    // Events arrive at state-change rates; a light interval is plenty (and
    // avoids UnsafeCallback entirely — we poll).
    this.pollTimer = setInterval(() => {
      void this.drainCredential();
      this.drainEvents();
    }, 25);
  }

  private async drainCredential(): Promise<void> {
    if (this.closed || this.credentialPending || !this.onCredential) return;
    this.credentialPending = true;
    const bytes = new Uint8Array(129);
    const revision = new BigUint64Array(1);
    try {
      const kind = this.lib.symbols.raop_credential_poll(
        this.handle,
        revision,
        bytes,
        BigInt(bytes.length),
      );
      if (kind === 0) return;
      if (kind !== 1 && kind !== 2) {
        throw new Error('RAOP credential copy failed');
      }
      const key = kind === 2 ? null : decode.decode(bytes.subarray(0, 128));
      if (key !== null) {
        appLogger().registerSecrets([key]);
        if (!/^[0-9a-fA-F]{128}$/.test(key) || bytes[128] !== 0) {
          throw new Error('Invalid RAOP credential output');
        }
      }
      await this.onCredential({
        revision: revision[0],
        key,
        isCurrent: () => !this.closed,
      });
      // close fences synchronously, before its asynchronous native free. Never
      // touch that pointer from a late private consumer completion.
      if (!this.closed) {
        if (
          this.lib.symbols.raop_credential_ack(this.handle, revision[0]) !== 1
        ) {
          throw new Error('RAOP credential acknowledgement failed');
        }
        this.onEvent('credential', key === null ? 'cleared' : 'saved');
      }
    } catch {
      // Retain the lease for retry. Arbitrary consumer errors may contain the
      // key; neither those errors nor the credential become diagnostic events.
      if (!this.closed) this.onEvent('credential', 'unavailable');
    } finally {
      bytes.fill(0);
      revision.fill(0n);
      this.credentialPending = false;
    }
  }

  private drainEvents() {
    const buf = new Uint8Array(256);
    for (;;) {
      // An event handler may have closed (and natively freed) this
      // transport on the previous iteration — never poll the freed handle.
      if (this.closed) return;
      let n: number;
      try {
        n = this.lib.symbols.raop_poll(this.handle, buf, BigInt(buf.length));
      } catch {
        return; // handle already freed
      }
      if (n <= 0) return;
      try {
        const ev = JSON.parse(decode.decode(buf.subarray(0, n))) as {
          event?: string;
          value?: string;
        };
        if (typeof ev.event === 'string') this.onEvent(ev.event, ev.value);
      } catch { /* not JSON — drop */ }
    }
  }

  start(
    profile: Readonly<AirplayProfile>,
    input: AirplayInput,
    credentials?: AirplayCredentials,
  ): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error('raop start on a closed transport'));
    }
    const password = credentials?.password ?? null;
    const pairingKey = credentials?.pairingKey ?? null;
    appLogger().registerSecrets([
      password ?? undefined,
      pairingKey ?? undefined,
    ]);
    // Keep a non-NULL buffer even for an empty password, distinct from absent.
    const passwordBytes = password === null ? null : cstr(password);
    const keyBytes = pairingKey === null ? null : text.encode(pairingKey);
    // Validate before calling C. Native length-delimited validation is
    // independent, including callers that do not use this adapter.
    if (
      (password !== null &&
        (password.includes('\0') || passwordBytes!.length - 1 > 4096)) ||
      (pairingKey !== null && !/^[0-9a-fA-F]{128}$/.test(pairingKey))
    ) {
      passwordBytes?.fill(0);
      keyBytes?.fill(0);
      return Promise.reject(new Error('Invalid RAOP credential input'));
    }
    let rc: number;
    try {
      const open = input.probe
        ? this.lib.symbols.raop_probe_v2
        : this.lib.symbols.raop_start_v2;
      rc = open(
        this.handle,
        cstr(profile.host),
        profile.port,
        cstr(profile.name),
        input.volume,
        DEVTYPE[profile.devtype],
        profile.encrypt ? 1 : 0,
        input.positionMs,
        input.lengthMs,
        profile.wantedMetadata,
        profile.supportsAuthSetup ? 1 : 0,
        profile.requiresAuth ? 1 : 0,
        cstr(input.title),
        cstr(input.artist),
        profile.hasPassword ? 1 : 0,
        passwordBytes,
        BigInt(passwordBytes === null ? 0 : passwordBytes.length - 1),
        keyBytes,
        BigInt(keyBytes?.length ?? 0),
      );
    } finally {
      passwordBytes?.fill(0);
      keyBytes?.fill(0);
    }
    return rc < 0
      ? Promise.reject(
        new Error(
          rc === -2 ? 'RAOP active stream busy' : 'raop start enqueue failed',
        ),
      )
      : Promise.resolve();
  }

  send(cmd: AirplayControl): Promise<void> {
    // A send on a closed transport must not silently report a successful
    // start — the caller learns the enqueue never happened.
    if (this.closed) {
      return Promise.reject(
        new Error(`raop ${String(cmd.cmd)} on a closed transport`),
      );
    }
    const s = this.lib.symbols;
    let rc = 0;
    switch (cmd.cmd) {
      case 'volume':
        rc = s.raop_volume(this.handle, cmd.volume);
        break;
      case 'flush':
        this.writeGen++; // before the native call — stale writers stop now
        rc = s.raop_flush(this.handle);
        break;
      case 'teardown':
        this.writeGen++;
        rc = s.raop_teardown(this.handle);
        break;
      case 'pin':
        appLogger().registerSecrets([cmd.pin]);
        if (!/^[0-9]{4}$/.test(cmd.pin)) {
          return Promise.reject(new Error('Invalid speaker PIN'));
        }
        {
          const pin = cstr(cmd.pin);
          try {
            rc = s.raop_pin(this.handle, pin);
          } finally {
            pin.fill(0);
          }
        }
        break;
      default:
        return Promise.resolve();
    }
    // Native contract: 0 = enqueued onto the loop; < 0 = rejected (the
    // queue stays consistent — the promise rejects, never a silent lie).
    if (rc < 0) {
      return Promise.reject(
        new Error(`raop ${String(cmd.cmd)} enqueue failed`),
      );
    }
    return Promise.resolve();
  }

  async pcm(chunk: Uint8Array): Promise<void> {
    if (this.stream) {
      throw new Error('PCM belongs to the RAOP stream, not its attachment');
    }
    const gen = this.writeGen;
    if (this.closed || this.writeGen !== gen) return;
    // Transitional device input is exclusive too: never report dropped PCM as
    // accepted. Production playback uses the fixed-player stream input instead.
    if (feed === null) feed = this.token;
    if (feed !== this.token) throw new Error('RAOP compatibility input busy');
    let offset = 0;
    while (offset < chunk.length) {
      // Abandon the remaining bytes when a FLUSH/TEARDOWN/close landed
      // while this call was parked in backpressure (plan
      // atv3-session-recycle: no old chunk crosses the discontinuity).
      if (this.closed || this.writeGen !== gen) return;
      const accepted = this.lib.symbols.raop_write(
        this.handle,
        chunk.subarray(offset),
        BigInt(chunk.length - offset),
      );
      if (accepted < 0) throw new Error('raop_write failed');
      if (accepted === 0) {
        // High-water mark in the library: backpressure, retry shortly.
        await new Promise((resolve) => setTimeout(resolve, 10));
        continue;
      }
      offset += accepted;
    }
  }

  ownsSharedFeed(): boolean {
    return feed === this.token;
  }

  cancelPcm(): void {
    this.writeGen++;
  }

  close(): Promise<void> {
    // Memoized, including rejection: a repeated close must not turn a
    // failed retirement into a success.
    if (this.closePromise !== null) return this.closePromise;
    this.closed = true;
    this.writeGen++; // cancel in-flight stale PCM writes before native free
    clearInterval(this.pollTimer);
    this.closePromise = (async () => {
      try {
        this.lib.symbols.raop_teardown(this.handle);
      } catch { /* the library is already gone */ }
      let rc: number;
      try {
        rc = await this.lib.symbols.raop_free(this.handle);
      } catch {
        rc = -1;
      }
      if (rc < 0) {
        // The handle is leaked by design (never a UAF). The feed token is
        // NOT released: no optimistic rerouting through broken native
        // state — the boot's blocked lifecycle record keeps this loud.
        throw new Error('raop_free failed: native cleanup not proven');
      }
      // The feed token releases only at proven native cleanup.
      if (feed === this.token) feed = null;
      drainLogs();
      activeHandles--;
    })();
    return this.closePromise;
  }
}

/** Additive fixed-owner port. The existing boot adopts it in b02b; compatibility
 * transports and explicit streams share the native single-active-stream guard.
 * A failed native free retains ownership/logging and cannot become success on
 * another close call. Attachments release before their shared stream storage. */
export function createFfiStream(
  log: Log = scopedLog('raop-native'),
): AirplayExactStream {
  const lib = loadLibrary(log);
  const handle = lib.symbols.raop_stream_new();
  if (!handle) throw new Error('raop_stream_new failed');
  activeStreams++;
  const id = lib.symbols.raop_stream_id(handle);
  let epoch = lib.symbols.raop_stream_epoch(handle);
  const operations = createOperationScope('RAOP stream');
  const releases = createReleaseSet();
  let closing: Promise<void> | undefined;
  let generation = 0;
  const writers = new Set<Promise<void>>();
  let resetting: Promise<void> | undefined;
  releases.add('stream', async () => {
    const rc = await lib.symbols.raop_stream_free(handle);
    if (rc < 0) {
      throw new Error('raop_stream_free failed: native cleanup not proven');
    }
    activeStreams--;
    drainLogs();
  }, 1);
  return {
    id,
    get epoch() {
      return epoch;
    },
    cancel(captured) {
      return operations.run(async ({ signal }) => {
        if (
          typeof captured !== 'bigint' || captured <= 0n ||
          captured > 0xffffffffffffffffn
        ) {
          throw new RangeError(
            'RAOP cancel requires an unsigned nonzero epoch',
          );
        }
        if (lib.symbols.raop_stream_cancel(handle, captured) !== 0) {
          throw new Error(
            'raop_stream_cancel refused stale or unavailable epoch',
          );
        }
        epoch = captured + 1n;
        generation++; // promptly settle transitional blocked writers too
        const receipt = new BigUint64Array(6);
        for (;;) {
          const rc = lib.symbols.raop_stream_cancel_poll(
            handle,
            captured,
            receipt,
          );
          if (
            rc !== 1 || receipt[0] !== captured ||
            receipt[1] !== captured + 1n ||
            receipt[2] > 3n || receipt[5] > 1n
          ) {
            throw new Error('Invalid RAOP cancel receipt ABI');
          }
          if (receipt[2] !== 0n || signal.aborted) {
            return Object.freeze({
              streamId: id,
              epoch: receipt[0],
              nextEpoch: receipt[1],
              status: signal.aborted
                ? 'canceled'
                : (['ready', 'canceled', 'failed'] as const)[
                  Number(receipt[2]) - 1
                ],
              cutoffFrames: receipt[5] === 1n ? receipt[3] : null,
              admittedNs: receipt[4],
            }) as AirplayCancelResult;
          }
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      });
    },
    ackCancel(captured) {
      return operations.run(() => {
        if (
          typeof captured !== 'bigint' || captured <= 0n ||
          captured > 0xffffffffffffffffn ||
          lib.symbols.raop_stream_cancel_ack(handle, captured) !== 0
        ) {
          throw new Error(
            'raop_stream_cancel_ack refused pending or absent result',
          );
        }
      });
    },
    append(input) {
      return operations.run(() => {
        for (const value of [input.epoch, input.segment]) {
          if (
            typeof value !== 'bigint' || value < 0n ||
            value > 0xffffffffffffffffn
          ) {
            throw new RangeError(
              'RAOP identity requires an unsigned 64-bit bigint',
            );
          }
        }
        // Match native precedence: malformed/stale requests still receive their
        // own receipt; a valid current request cannot overtake a submitted reset
        // while it joins the previously admitted transitional writers.
        if (
          resetting && input.epoch === epoch && input.segment !== 0n &&
          input.pcm.length % 4 === 0
        ) {
          return Object.freeze(
            {
              streamId: id,
              epoch: input.epoch,
              segment: input.segment,
              acceptedFrames: 0n,
              status: 'not-ready',
            } as const,
          );
        }
        const receipt = new BigUint64Array(5);
        const rc = lib.symbols.raop_stream_append(
          handle,
          input.epoch,
          input.segment,
          input.pcm,
          BigInt(input.pcm.length),
          receipt,
        );
        const statuses: AirplayAppendStatus[] = [
          'accepted',
          'backpressure',
          'canceled',
          'error',
          'not-ready',
        ];
        const errors: AirplayAppendError[] = [
          'invalid',
          'busy',
          'allocation',
          'closing',
        ];
        const status = statuses[Number(receipt[3])];
        const error = errors[Number(receipt[4]) - 1];
        const frames = BigInt(Math.floor(input.pcm.length / 4));
        if (
          rc !== 0 || receipt[0] !== input.epoch ||
          receipt[1] !== input.segment ||
          !status || receipt[2] > frames ||
          (status === 'accepted' && receipt[2] !== frames) ||
          (status === 'backpressure' && receipt[2] >= frames) ||
          (!['accepted', 'backpressure'].includes(status) &&
            receipt[2] !== 0n) ||
          (status === 'error' ? !error : receipt[4] !== 0n)
        ) throw new Error('Invalid RAOP append receipt ABI');
        return Object.freeze({
          streamId: id,
          epoch: receipt[0],
          segment: receipt[1],
          acceptedFrames: receipt[2],
          status,
          ...(status === 'error' ? { error } : {}),
        }) as AirplayAppendResult;
      });
    },
    attach(onEvent, onCredential) {
      if (operations.closed) throw new Error('RAOP stream is closed');
      const transport = new FfiTransport(lib, onEvent, onCredential, handle);
      releases.add(
        `attachment:${transport.attachmentId}`,
        () => transport.close(),
      );
      return {
        id: transport.attachmentId,
        streamId: id,
        transport,
        start: (profile, input, credentials) =>
          transport.start(profile, input, credentials),
      };
    },
    pcm(chunk) {
      const current = generation;
      const barrier = resetting;
      const writing = operations.run(async ({ signal }) => {
        // Capture admission before waiting: a later reset cancels queued input
        // too. Only replacement input admitted after that reset may survive it.
        await barrier;
        if (chunk.length % 4) {
          throw new Error('RAOP PCM requires whole stereo frames');
        }
        let offset = 0;
        while (offset < chunk.length) {
          if (signal.aborted || generation !== current) {
            throw new Error('RAOP PCM producer canceled');
          }
          const accepted = lib.symbols.raop_stream_write(
            handle,
            chunk.subarray(offset),
            BigInt(chunk.length - offset),
          );
          if (accepted < 0) {
            throw new Error(
              accepted === -2
                ? 'RAOP active stream busy'
                : 'raop_stream_write failed',
            );
          }
          offset += accepted;
          if (accepted === 0) {
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        }
      });
      writers.add(writing);
      void writing.then(
        () => writers.delete(writing),
        () => writers.delete(writing),
      );
      return writing;
    },
    cancelPcm() {
      generation++;
    },
    reset() {
      // Fence at submission, not when the event-loop callback eventually runs.
      // Join admitted native writers only; decoder acquisition/cleanup belongs
      // to the source owner and must not hold this transport control boundary.
      generation++;
      const previous = resetting;
      const admitted = [...writers];
      const work = operations.run(async () => {
        await previous;
        await Promise.allSettled(admitted);
        if (await lib.symbols.raop_stream_reset(handle) < 0) {
          throw new Error('raop_stream_reset failed');
        }
      });
      resetting = work;
      // A failed reset remains a rejected admission barrier until close. Never
      // accept replacement PCM after an unproven local reset.
      void work.then(() => {
        if (resetting === work) resetting = undefined;
      }, () => {});
      return work;
    },
    close() {
      if (!closing) {
        const settled = operations.close();
        closing = settled.then(() =>
          releaseOrThrow(releases, 'RAOP stream release failed')
        ).then(() => {});
      }
      return closing;
    },
  };
}

/** The default transport factory for the AirPlay boot: FFI, in-process.
 * Resolves and loads the RAOP library EAGERLY so a missing build is a loud
 * startup error, not a surprise at play time. */
export function createFfiSpawn(log: Log = scopedLog('raop-native')): (
  onEvent: HelperEventFn,
  onCredential?: PairingCredentialConsumer,
) => AirplayDriver {
  let lib: RaopLibrary | null = null;
  try {
    lib = loadLibrary(log);
  } catch (err) {
    log.event('ffi_load_failed', { error: err });
  }
  return (onEvent, onCredential) => {
    if (lib === null) {
      throw new Error(
        'RAOP library not available (see startup log; build helper/raop)',
      );
    }
    const transport = new FfiTransport(lib, onEvent, onCredential);
    return {
      transport,
      start: (profile, input, credentials) =>
        transport.start(profile, input, credentials),
    };
  };
}

/** Exported for the gated FFI smoke test only. */
export const raopFfiInternals = { resolveLibPath, loadLibrary, drainLogs };
