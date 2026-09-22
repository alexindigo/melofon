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
// the feed's handle closes, the next writer takes over.
import type { AirplayTransport, HelperEventFn } from './airplay.ts';

const SYMBOLS = {
  raop_new: { parameters: [], result: 'pointer' },
  raop_start: {
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
    ],
    result: 'i32',
  },
  raop_write: { parameters: ['pointer', 'buffer', 'usize'], result: 'i32' },
  raop_volume: { parameters: ['pointer', 'i32'], result: 'i32' },
  raop_flush: { parameters: ['pointer'], result: 'i32' },
  raop_teardown: { parameters: ['pointer'], result: 'i32' },
  raop_pin: { parameters: ['pointer', 'buffer'], result: 'i32' },
  raop_poll: { parameters: ['pointer', 'buffer', 'usize'], result: 'i32' },
  raop_free: { parameters: ['pointer'], result: 'void' },
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

function loadLibrary(): RaopLibrary {
  if (loaded !== undefined) return loaded;
  const path = resolveLibPath();
  try {
    loaded = Deno.dlopen(path, SYMBOLS);
  } catch (err) {
    throw new Error(`RAOP library ${path} failed to load: ${err}`);
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

  constructor(lib: RaopLibrary, onEvent: HelperEventFn) {
    this.lib = lib;
    this.onEvent = onEvent;
    const handle = lib.symbols.raop_new();
    if (handle === null) {
      throw new Error('raop_new failed (out of memory or loop thread)');
    }
    this.handle = handle;
    // Events arrive at state-change rates; a light interval is plenty (and
    // avoids UnsafeCallback entirely — we poll).
    this.pollTimer = setInterval(() => this.drainEvents(), 25);
  }

  private drainEvents() {
    const buf = new Uint8Array(256);
    for (;;) {
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

  send(cmd: Record<string, unknown>): Promise<void> {
    if (this.closed) return Promise.resolve();
    const s = this.lib.symbols;
    switch (cmd.cmd) {
      case 'start':
        s.raop_start(
          this.handle,
          cstr(String(cmd.host)),
          Number(cmd.port) || 7000,
          cstr(String(cmd.name ?? cmd.host)),
          Number(cmd.volume) || 0,
          DEVTYPE[String(cmd.devtype)] ?? DEVTYPE.appletv,
          cmd.encrypt === true ? 1 : 0,
          Number(cmd.pos_ms) || 0,
          Number(cmd.len_ms) || 0,
          Number(cmd.wanted_metadata) || 0,
          Number(cmd.authsetup) || 0,
          Number(cmd.requires_auth) || 0,
          cstr(String(cmd.title ?? '')),
          cstr(String(cmd.artist ?? '')),
        );
        break;
      case 'volume':
        s.raop_volume(this.handle, Number(cmd.volume) || 0);
        break;
      case 'flush':
        s.raop_flush(this.handle);
        break;
      case 'teardown':
        s.raop_teardown(this.handle);
        break;
      case 'pin':
        s.raop_pin(this.handle, cstr(String(cmd.pin)));
        break;
    }
    return Promise.resolve();
  }

  async pcm(chunk: Uint8Array): Promise<void> {
    if (this.closed) return;
    // Feed election: the first writer owns the shared stream; every other
    // selected output's PCM is accepted and dropped (see the header).
    if (feed === null) feed = this.token;
    if (feed !== this.token) return;
    let offset = 0;
    while (offset < chunk.length) {
      if (this.closed) return;
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

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    clearInterval(this.pollTimer);
    if (feed === this.token) feed = null;
    try {
      this.lib.symbols.raop_teardown(this.handle);
      this.lib.symbols.raop_free(this.handle);
    } catch { /* the library is already gone */ }
    return Promise.resolve();
  }
}

/** The default transport factory for the AirPlay boot: FFI, in-process.
 * Resolves and loads the RAOP library EAGERLY so a missing build is a loud
 * startup error, not a surprise at play time. */
export function createFfiSpawn(): (
  onEvent: HelperEventFn,
) => AirplayTransport {
  let lib: RaopLibrary | null = null;
  try {
    lib = loadLibrary();
  } catch (err) {
    console.error(`[melofon] airplay: ${(err as Error).message}`);
  }
  return (onEvent) => {
    if (lib === null) {
      throw new Error(
        'RAOP library not available (see startup log; build helper/raop)',
      );
    }
    return new FfiTransport(lib, onEvent);
  };
}

/** Exported for the gated FFI smoke test only. */
export const raopFfiInternals = { resolveLibPath, loadLibrary };
