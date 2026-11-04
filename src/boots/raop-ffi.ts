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
// One stream, many devices: raop.c is process-global (one master session
// per quality+encrypt), so N selected outputs share it — OwnTone's synced
// multi-speaker model. The boot pumps PCM per output; this module designates
// the first writer as THE FEED and silently accepts-and-drops the other
// handles' writes (their decode is wasted CPU, the wire stays sane). When
// the feed's handle closes, the next writer takes over — but only after the
// close PROVES native cleanup: a failed free keeps the token, so no bytes
// are optimistically routed through a broken native state (plan
// atv3-session-recycle).
import type {
  AirplayControl,
  AirplayCredentials,
  AirplayDriver,
  AirplayInput,
  AirplayProfile,
  AirplayTransport,
  HelperEventFn,
  PairingCredentialConsumer,
} from './airplay-profile.ts';
import { appLogger, type EventFacts, type Log, scopedLog } from '../logging.ts';

const SYMBOLS = {
  raop_log_consumer: { parameters: ['i32'], result: 'i32' },
  raop_log_poll: { parameters: ['buffer', 'usize'], result: 'i32' },
  raop_new: { parameters: [], result: 'pointer' },
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
  if (activeHandles !== 0) return; // A failed free retains ownership and ingress.
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
  ) {
    this.lib = lib;
    this.onEvent = onEvent;
    const handle = lib.symbols.raop_new();
    drainLogs();
    if (handle === null) {
      throw new Error('raop_new failed (out of memory or loop thread)');
    }
    this.handle = handle;
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
      }
    } catch {
      // Retain the lease for retry. Arbitrary consumer errors may contain the
      // key; neither those errors nor the credential become diagnostic events.
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
      rc = this.lib.symbols.raop_start_v2(
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
      ? Promise.reject(new Error('raop start enqueue failed'))
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
        rc = s.raop_pin(this.handle, cstr(cmd.pin));
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
    const gen = this.writeGen;
    if (this.closed || this.writeGen !== gen) return;
    // Feed election: the first writer owns the shared stream; every other
    // selected output's PCM is accepted and dropped (see the header).
    if (feed === null) feed = this.token;
    if (feed !== this.token) return;
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
