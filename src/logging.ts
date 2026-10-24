// One presentation owner. Owned producers never render lines or select output streams.
import { fstatSync } from 'node:fs';
import { types } from 'node:util';
import {
  type EventFacts,
  type EventId,
  events,
  nativePresentation,
  nativeProjection,
  priorities,
  severity,
} from './logging-events.ts';
export type { EventFacts, EventId, Level } from './logging-events.ts';
export interface Log {
  event<E extends EventId>(event: E, facts: EventFacts[E]): void;
}
export interface Logger extends Log {
  scope(source: string): Log;
  registerSecrets(values: readonly (string | undefined)[]): void;
  flush(): Promise<void>;
  stats(): {
    failures: number;
    dropped: number;
    sinkFailures: number;
    normalizationFailures: number;
  };
}
type Sink = (line: string) => void | Promise<void>;
export interface LoggerOptions {
  clock?: () => Date;
  sinks?: { stdout: Sink; stderr: Sink };
  journal?: { stdout: boolean; stderr: boolean };
  maxQueued?: number;
}
const SENSITIVE =
  /^(?:u|p|t|s|user|username|password|passwd|pwd|pin|secret|token|transcodeparams|accesstoken|refreshtoken|apikey|key|privatekey|authorization|proxyauthorization|cookie|setcookie|xapikey|xpin)$/;
function sensitive(key: string): boolean {
  let name = key;
  for (let i = 0; i < 3; i++) {
    try {
      const decoded = decodeURIComponent(name);
      if (decoded === name) break;
      name = decoded;
    } catch {
      break;
    }
  }
  return SENSITIVE.test(name.toLowerCase().replace(/[^a-z0-9]/g, '')) ||
    /(?:password|passwd|passphrase|secret|token|authorization|cookie|key|pin(?:code)?)(?:hash|value|data)?$/
      .test(
        name.toLowerCase().replace(/[^a-z0-9]/g, ''),
      );
}
const REDACTED = '[redacted]';
const MAX_STRING = 4096, MAX_DEPTH = 6, MAX_ITEMS = 64, MAX_NODES = 256;
type Value = null | string | number | boolean | Value[] | {
  [key: string]: Value;
};
interface Metadata {
  truncated: number;
  normalization_failures: number;
  cycles: number;
  accessors_omitted: number;
}
const NativeError = Error;
const nativeStackGetter = Object.getOwnPropertyDescriptor(
  new NativeError(),
  'stack',
)?.get;
type DescriptorLookup =
  | { state: 'found'; descriptor: PropertyDescriptor }
  | { state: 'absent' }
  | { state: 'uninspectable'; reason: 'limit' | 'proxy' | 'inspection_failed' };
function propertyDescriptor(
  object: object,
  key: string,
): DescriptorLookup {
  let cursor: object | null = object;
  try {
    for (let i = 0; cursor && i < 8; i++) {
      if (types.isProxy(cursor)) {
        return { state: 'uninspectable', reason: 'proxy' };
      }
      const descriptor = Object.getOwnPropertyDescriptor(cursor, key);
      if (descriptor) return { state: 'found', descriptor };
      cursor = Object.getPrototypeOf(cursor);
    }
  } catch {
    return { state: 'uninspectable', reason: 'inspection_failed' };
  }
  return cursor === null
    ? { state: 'absent' }
    : { state: 'uninspectable', reason: 'limit' };
}
function errorStack(
  error: object,
  descriptor?: PropertyDescriptor,
): { stack?: string; stack_unavailable?: string } {
  if (!descriptor) return { stack_unavailable: 'absent' };
  if ('value' in descriptor) {
    return typeof descriptor.value === 'string'
      ? { stack: descriptor.value }
      : { stack_unavailable: 'non_string' };
  }
  if (!nativeStackGetter || descriptor.get !== nativeStackGetter) {
    return { stack_unavailable: 'custom_accessor' };
  }
  const globalError = Object.getOwnPropertyDescriptor(globalThis, 'Error');
  const formatter = propertyDescriptor(NativeError, 'prepareStackTrace');
  if (formatter.state === 'uninspectable') {
    return { stack_unavailable: `formatter_${formatter.reason}` };
  }
  if (
    globalError?.value !== NativeError ||
    (formatter.state === 'found' &&
      (!('value' in formatter.descriptor) ||
        typeof formatter.descriptor.value === 'function'))
  ) return { stack_unavailable: 'custom_formatter' };
  for (const key of ['name', 'message']) {
    const property = propertyDescriptor(error, key);
    if (property.state === 'uninspectable') {
      return { stack_unavailable: `${key}_${property.reason}` };
    }
    if (
      property.state === 'found' &&
      (!('value' in property.descriptor) ||
        (property.descriptor.value !== undefined &&
          typeof property.descriptor.value !== 'string'))
    ) return { stack_unavailable: 'unsafe_error_field' };
  }
  try {
    const value = nativeStackGetter.call(error);
    return typeof value === 'string'
      ? { stack: value }
      : { stack_unavailable: 'non_string' };
  } catch {
    return { stack_unavailable: 'native_failure' };
  }
}
// SQL strings/comments/quoted identifiers never become diagnostics, even in trace mode.
function sqlFacts(sql: string): Record<string, string> {
  // Only executable word tokens carry text. Opaque regions are barriers, not
  // erased substrings that can be reinterpreted by a second lexical pass.
  type Token = { kind: 'word' | 'symbol' | 'opaque'; text: string };
  const tokens: Token[] = [];
  const unknown = { operation: 'unknown' };
  if (sql.length > 65536) return unknown;
  for (let i = 0; i < sql.length;) {
    if (tokens.length >= 4096) return unknown;
    if (/\s/.test(sql[i])) {
      i++;
      continue;
    }
    if (sql.startsWith('--', i)) {
      i += 2;
      while (i < sql.length && sql[i] !== '\n' && sql[i] !== '\r') i++;
      continue;
    }
    if (sql.startsWith('/*', i)) {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth) {
        if (sql.startsWith('/*', i)) {
          if (++depth > 64) return unknown;
          i += 2;
        } else if (sql.startsWith('*/', i)) {
          depth--;
          i += 2;
        } else i++;
      }
      if (depth) return unknown;
      continue;
    }
    if (sql.startsWith('*/', i)) return unknown;
    const escaped = (sql[i] === 'E' || sql[i] === 'e') && sql[i + 1] === "'";
    if (escaped) i++;
    const char = sql[i];
    if (char === "'" || char === '"') {
      const quote = char;
      let closed = false;
      i++;
      while (i < sql.length) {
        if (escaped && sql[i] === '\\') {
          i += 2;
          continue;
        }
        if (sql[i++] !== quote) continue;
        if (sql[i] === quote) {
          i++;
          continue;
        }
        closed = true;
        break;
      }
      if (!closed) return unknown;
      tokens.push({ kind: 'opaque', text: '' });
      continue;
    }
    if (char === '$') {
      const dollar = sql.slice(i).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)
        ?.[0];
      if (!dollar) return unknown;
      const end = sql.indexOf(dollar, i + dollar.length);
      if (end < 0) return unknown;
      i = end + dollar.length;
      tokens.push({ kind: 'opaque', text: '' });
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      const start = i++;
      while (i < sql.length && /[A-Za-z0-9_]/.test(sql[i])) i++;
      // Unrecognized string/identifier prefixes cannot license a guessed quote
      // policy (e.g. U&'', N'', or a delimiter attached to an identifier).
      if (sql[i] === "'" || sql[i] === '"' || sql[i] === '$') return unknown;
      const word = sql.slice(start, i);
      if (/^U$/i.test(word) && sql[i] === '&') return unknown;
      tokens.push({ kind: 'word', text: word });
      continue;
    }
    if (/[0-9]/.test(char)) {
      i++;
      while (i < sql.length && /[0-9.]/.test(sql[i])) i++;
      if (i < sql.length && /[A-Za-z_$]/.test(sql[i])) return unknown;
      tokens.push({ kind: 'opaque', text: '' });
      continue;
    }
    if (!/[.,;()?=+\-*/%<>!|:&]/.test(char)) return unknown;
    tokens.push({ kind: 'symbol', text: char });
    i++;
  }
  const wordAt = (index: number) =>
    tokens[index]?.kind === 'word' ? tokens[index].text : undefined;
  const operation = wordAt(0)?.toUpperCase() ?? 'unknown';
  if (
    !/^(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|PRAGMA|CHECKPOINT|BEGIN|COMMIT|ROLLBACK|WITH)$/
      .test(operation)
  ) return unknown;
  let identifier: string | undefined;
  for (let i = 0; i < tokens.length && tokens[i].text !== ';'; i++) {
    const keyword = wordAt(i)?.toUpperCase();
    if (!keyword || !['FROM', 'INTO', 'UPDATE', 'TABLE'].includes(keyword)) {
      continue;
    }
    let next = i + 1;
    if (keyword === 'TABLE' && wordAt(next)?.toUpperCase() === 'IF') {
      next++;
      if (wordAt(next)?.toUpperCase() === 'NOT') next++;
      if (wordAt(next)?.toUpperCase() !== 'EXISTS') continue;
      next++;
    }
    const name = wordAt(next);
    if (!name) continue;
    if (tokens[next + 1]?.text === '.') {
      const relation = wordAt(next + 2);
      if (!relation || tokens[next + 3]?.text === '.') continue;
      identifier = `${name}.${relation}`;
    } else identifier = name;
    break;
  }
  return { operation, ...(identifier ? { identifier } : {}) };
}
export function journalDestination(
  stream: string | undefined,
  identity: { dev: number | bigint; ino: number | bigint },
): boolean {
  const match = stream?.match(/^(\d+):(\d+)$/);
  return !!match && BigInt(match[1]) === BigInt(identity.dev) &&
    BigInt(match[2]) === BigInt(identity.ino);
}
function journalDescriptors(): { stdout: boolean; stderr: boolean } {
  const result = { stdout: false, stderr: false };
  try {
    const stream = Deno.env.get('JOURNAL_STREAM');
    result.stdout = journalDestination(stream, fstatSync(1, { bigint: true }));
    result.stderr = journalDestination(stream, fstatSync(2, { bigint: true }));
  } catch { /* Unavailable descriptor proof means plain logfmt. */ }
  return result;
}
const encoder = new TextEncoder();
function write(
  writer: { writeSync(bytes: Uint8Array): number },
  line: string,
): void {
  const bytes = encoder.encode(line);
  for (let offset = 0; offset < bytes.length;) {
    const n = writer.writeSync(bytes.subarray(offset));
    if (n <= 0) throw new Error('Log sink made no progress');
    offset += n;
  }
}
export function createLogger(options: LoggerOptions = {}): Logger {
  const clock = options.clock ?? (() => new Date());
  const sinks = options.sinks ??
    {
      stdout: (line: string) => write(Deno.stdout, line),
      stderr: (line: string) => write(Deno.stderr, line),
    };
  const journal = options.journal ??
    (options.sinks ? { stdout: false, stderr: false } : journalDescriptors());
  const secrets = new Set<string>();
  let sequence = 0, sinkFailures = 0, normalizationFailures = 0, dropped = 0;
  const queues = { stdout: [] as string[], stderr: [] as string[] };
  const busy = { stdout: false, stderr: false };
  const waiters = new Set<() => void>();
  const drain = (destination: 'stdout' | 'stderr'): void => {
    if (busy[destination]) return;
    while (queues[destination].length) {
      const line = queues[destination].shift()!;
      busy[destination] = true;
      try {
        const result = sinks[destination](line);
        if (result) {
          void Promise.resolve(result).catch(() => {
            sinkFailures++;
          }).finally(() => {
            busy[destination] = false;
            drain(destination);
          });
          return;
        }
      } catch {
        sinkFailures++;
      }
      busy[destination] = false;
    }
    if (
      !busy.stdout && !busy.stderr && !queues.stdout.length &&
      !queues.stderr.length
    ) {
      for (const resolve of waiters) resolve();
      waiters.clear();
    }
  };
  function intake(id: EventId, input: unknown, source?: string): void {
    const metadata: Metadata = {
      truncated: 0,
      normalization_failures: 0,
      cycles: 0,
      accessors_omitted: 0,
    };
    const seen = new Set<object>();
    let nodes = 0;
    const scrub = (raw: string, maskKnownValues = true): string => {
      let value = raw.toWellFormed();
      // Terminal sequences are transported as escaped data, never executable bytes.
      // deno-lint-ignore no-control-regex -- Intentional ANSI-neutralization boundary.
      value = value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '[ansi]');
      if (maskKnownValues) {
        for (const secret of secrets) {
          value = value.split(secret).join(REDACTED);
        }
      }
      // Recognizable authentication URL/query and key/value syntax in opaque messages.
      value = value.replace(
        /([?&]|\b)([A-Za-z0-9_%.-]+)=([^\s&#]*)/g,
        (_all, prefix, key, content) =>
          sensitive(key)
            ? `${prefix}${key}=${REDACTED}`
            : `${prefix}${key}=${content}`,
      );
      value = value.replace(
        /\b(authorization(?: header)?|(?:set-)?cookie|password|pin|secret|api[_-]?key|token)\s*:\s*[^\n]+/gi,
        `$1: ${REDACTED}`,
      );
      if (value.length > MAX_STRING) {
        metadata.truncated++;
        value = value.slice(0, MAX_STRING).toWellFormed();
      }
      return value;
    };
    const normalize = (value: unknown, depth = 0): Value | undefined => {
      if (value === undefined) return undefined;
      if (++nodes > MAX_NODES || depth > MAX_DEPTH) {
        metadata.truncated++;
        return '[bounded]';
      }
      if (value === null || typeof value === 'boolean') return value;
      if (typeof value === 'string') return scrub(value);
      if (typeof value === 'number') {
        if (Number.isFinite(value)) return value;
        metadata.normalization_failures++;
        return { non_finite_number: String(value) };
      }
      if (typeof value === 'bigint') return value.toString();
      if (typeof value !== 'object') return `[${typeof value}]`;
      if (types.isProxy(value)) {
        metadata.normalization_failures++;
        return '[proxy omitted]';
      }
      if (seen.has(value)) {
        metadata.cycles++;
        return '[cycle]';
      }
      seen.add(value);
      try {
        // Native Error branding does not traverse user-controlled prototypes.
        // Do it before instanceof, which could execute a proxy ancestor's trap.
        const error = types.isNativeError(value);
        if (!error && value instanceof URL) {
          return safeUrl(URL.prototype.toString.call(value));
        }
        if (!error && value instanceof Request) {
          return requestFacts(value, true);
        }
        if (!error && value instanceof Headers) return headerFacts(value);
        const descriptors = Object.getOwnPropertyDescriptors(value);
        const result: Record<string, Value> = Object.create(null);
        const stack = error ? errorStack(value, descriptors.stack) : {};
        for (const [key, item] of Object.entries(stack)) {
          result[key] = scrub(item);
        }
        const keys = error
          ? [
            'name',
            'message',
            'code',
            'cause',
            'stack',
            ...Object.keys(descriptors),
          ]
          : Object.keys(descriptors);
        if (keys.length > MAX_ITEMS) metadata.truncated++;
        for (const key of [...new Set(keys)].slice(0, MAX_ITEMS)) {
          if (error && key === 'stack') continue;
          if (Array.isArray(value) && key === 'length') continue;
          const lookup: DescriptorLookup = descriptors[key]
            ? { state: 'found', descriptor: descriptors[key] }
            : error
            ? propertyDescriptor(value, key)
            : { state: 'absent' };
          if (lookup.state === 'uninspectable') {
            metadata.normalization_failures++;
            continue;
          }
          const desc = lookup.state === 'found' ? lookup.descriptor : undefined;
          if (desc && !('value' in desc)) {
            metadata.accessors_omitted++;
            continue;
          }
          const raw = desc?.value;
          const normalized = sensitive(key)
            ? REDACTED
            : normalize(raw, depth + 1);
          if (normalized !== undefined) result[scrub(key)] = normalized;
        }
        if (Array.isArray(value)) return Object.values(result);
        return result;
      } catch {
        metadata.normalization_failures++;
        return '[normalization failed]';
      } finally {
        seen.delete(value);
      }
    };
    function safeUrl(raw: string): Value {
      try {
        const url = new URL(raw);
        if (url.username) url.username = REDACTED;
        if (url.password) url.password = REDACTED;
        const params = new URLSearchParams();
        for (const [key, value] of url.searchParams) {
          params.append(scrub(key), sensitive(key) ? REDACTED : scrub(value));
        }
        url.search = params.toString();
        url.hash = '';
        return scrub(url.toString());
      } catch {
        metadata.normalization_failures++;
        return '[invalid URL]';
      }
    }
    function headerFacts(headers: Headers): Value {
      const result: Record<string, Value> = Object.create(null);
      let count = 0;
      for (const [key, value] of Headers.prototype.entries.call(headers)) {
        if (++count > MAX_ITEMS) {
          metadata.truncated++;
          break;
        }
        result[scrub(key)] = sensitive(key) ? REDACTED : scrub(value);
      }
      return result;
    }
    function requestFacts(
      request: Request,
      trace: boolean,
    ): Record<string, Value> {
      const get = (key: string) =>
        Object.getOwnPropertyDescriptor(Request.prototype, key)!.get!.call(
          request,
        );
      const url = new URL(get('url'));
      return {
        method: scrub(get('method')),
        path: scrub(url.pathname),
        ...(trace
          ? {
            url: safeUrl(url.toString()),
            headers: headerFacts(get('headers')),
          }
          : {}),
      };
    }
    try {
      if (input === null || typeof input !== 'object' || types.isProxy(input)) {
        throw new Error('Invalid raw event facts');
      }
      const descriptors = Object.getOwnPropertyDescriptors(input);
      const raw: Record<string, unknown> = Object.create(null);
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if ('value' in descriptor) raw[key] = descriptor.value;
        else metadata.accessors_omitted++;
      }
      const schema = events[id];
      const level = severity(id, raw);
      const fields: Record<string, Value> = Object.create(null);
      for (const key of schema.fields) {
        const descriptor = Object.getOwnPropertyDescriptor(raw, key);
        if (descriptor && !('value' in descriptor)) {
          metadata.accessors_omitted++;
          continue;
        }
        const result = normalize(descriptor?.value);
        if (result !== undefined) fields[key] = result;
      }
      let message = schema.message;
      if (id === 'native_record') {
        message = nativePresentation(
          typeof raw.nativeEvent === 'string' ? raw.nativeEvent : 'unknown',
        );
        fields.source_severity = normalize(raw.severity) ?? 'unknown';
        const payload = fields.payload;
        if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
          const projected = nativeProjection(
            typeof raw.nativeEvent === 'string' ? raw.nativeEvent : 'unknown',
            payload,
          );
          if (projected) {
            delete fields.payload;
            Object.assign(fields, normalize(projected));
          }
        }
      }
      if (id.startsWith('http_')) {
        Object.assign(
          fields,
          requestFacts(
            raw.request as Request,
            id === 'http_accept' && raw.traceHeaders === true,
          ),
        );
      }
      if (id === 'db_begin' || id === 'db_end') {
        if (typeof raw.sql !== 'string') metadata.normalization_failures++;
        Object.assign(
          fields,
          normalize(sqlFacts(typeof raw.sql === 'string' ? raw.sql : '')),
        );
      }
      if (
        id === 'command' || id === 'config_changed' ||
        id === 'libraries_changed'
      ) {
        // Attribution is an explicit contract; user here is not an auth query credential.
        const src = raw.source !== null && typeof raw.source === 'object' &&
            !types.isProxy(raw.source)
          ? raw.source
          : {};
        for (
          const key of ['kind', 'via', 'peer', 'user', 'client', 'userAgent']
        ) {
          const descriptor = Object.getOwnPropertyDescriptor(src, key);
          if (descriptor && !('value' in descriptor)) {
            metadata.accessors_omitted++;
            continue;
          }
          const value = descriptor?.value;
          // The schema identifies public command attribution. A username/client
          // identity is not an authentication value even when spellings overlap.
          // Keep opaque User-Agent text under known-value masking; all values
          // still get framing, bounds and recognizable credential-syntax cleanup.
          const result = typeof value === 'string' && key !== 'userAgent'
            ? scrub(value, false)
            : normalize(value);
          if (result !== undefined) {
            fields[key === 'user' ? 'username' : key] = result;
          }
        }
      }
      const observed = clock();
      const captured = id === 'native_record' && Number.isFinite(raw.timeMs)
        ? new Date(Number(raw.timeMs))
        : observed;
      const time = captured.toISOString();
      if (id === 'native_record') fields.time_basis = 'captured';
      if (id === 'dependency_ffmpeg') fields.time_basis = 'observed';
      if (source) fields.source = scrub(source);
      fields.sequence = ++sequence;
      if (sinkFailures) fields.sink_failures = sinkFailures;
      if (normalizationFailures) {
        fields.normalization_failed_events = normalizationFailures;
      }
      if (dropped) fields.sink_dropped = dropped;
      for (const [key, value] of Object.entries(metadata)) {
        if (value) fields[key] = value;
      }
      const quote = (value: Value): string => {
        if (value === null) return 'null';
        if (typeof value === 'boolean' || typeof value === 'number') {
          return String(value);
        }
        const text = typeof value === 'string' ? value : JSON.stringify(value);
        return typeof value === 'string' && text !== '' &&
            !/[\s"\\=/]|\p{Cc}/u.test(text)
          ? text
          : JSON.stringify(text).replace(
            /[\x7f-\x9f\u2028\u2029]/g,
            (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
          );
      };
      const leading: [string, Value][] = [
        ['time', time],
        ['level', level],
        ['component', schema.component],
        ['event', id],
        ['message', message],
      ];
      const parts = leading.map(([key, value]) => `${key}=${quote(value)}`);
      let bytes = encoder.encode(parts.join(' ')).length;
      const recordTruncated: string[] = [];
      // Bound the serialized UTF-8 record too, including nested JSON's escaping
      // expansion. Keep framing valid instead of slicing a quoted record in half.
      for (const [key, value] of Object.entries(fields)) {
        let part = `${key}=${quote(value)}`;
        if (bytes + encoder.encode(part).length > 11000) {
          recordTruncated.push(key);
          part = `${key}=${
            quote(
              typeof value === 'object' && value !== null
                ? { truncated: 'record_size_bound' }
                : '[record size bound]',
            )
          }`;
        }
        parts.push(part);
        bytes += encoder.encode(part).length + 1;
      }
      if (recordTruncated.length) {
        parts.push(`record_truncated_fields=${quote(recordTruncated)}`);
      }
      const line = parts.join(' ') + '\n';
      const destination = level === 'error' || level === 'fatal'
        ? 'stderr'
        : 'stdout';
      if (queues[destination].length >= (options.maxQueued ?? 1024)) {
        dropped++;
        return;
      }
      queues[destination].push(
        (journal[destination] ? `<${priorities[level]}>` : '') + line,
      );
      drain(destination);
    } catch {
      normalizationFailures++;
      // Last-resort schema-independent diagnostic. No original object is
      // inspected here, no recursive logger call and no application exception.
      const failedEvent = Object.hasOwn(events, id) ? id : 'unknown';
      const line = `time=${
        new Date().toISOString()
      } level=error component=logging event=normalization_failed message="Event normalization failed" failedEvent=${failedEvent} normalization_failures=1 sequence=${++sequence}\n`;
      if (queues.stderr.length >= (options.maxQueued ?? 1024)) {
        dropped++;
        return;
      }
      queues.stderr.push(
        (journal.stderr ? `<${priorities.error}>` : '') + line,
      );
      drain('stderr');
    }
  }
  return {
    event: (id, facts) => intake(id, facts),
    scope: (source) => ({ event: (id, facts) => intake(id, facts, source) }),
    registerSecrets(values) {
      for (const value of values) {
        if (value) {
          const normalized = value.toWellFormed();
          secrets.add(normalized);
          secrets.add(encodeURIComponent(normalized));
          const hex = Array.from(
            encoder.encode(normalized),
            (byte) => byte.toString(16).padStart(2, '0'),
          ).join('');
          secrets.add(hex);
          secrets.add(hex.toUpperCase());
        }
      }
    },
    flush() {
      if (
        !busy.stdout && !busy.stderr && !queues.stdout.length &&
        !queues.stderr.length
      ) return Promise.resolve();
      return new Promise((resolve) => waiters.add(resolve));
    },
    stats: () => ({
      failures: sinkFailures + normalizationFailures,
      dropped,
      sinkFailures,
      normalizationFailures,
    }),
  };
}
let production = createLogger();
export function installLogger(logger: Logger): void {
  production = logger;
}
export function appLogger(): Logger {
  return production;
}
// Defaults resolve the installed instance at emission time, including late native callbacks.
export function scopedLog(source: string): Log {
  return { event: (id, facts) => production.scope(source).event(id, facts) };
}
