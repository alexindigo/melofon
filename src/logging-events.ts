// Core owns the event vocabulary, projections, severity and readable presentation.
// Producers supply facts; adapters explicitly identify opaque external payloads.
export type Level = 'debug' | 'info' | 'notice' | 'warn' | 'error' | 'fatal';
export interface Provenance {
  kind: 'http' | 'internal';
  via?: string;
  peer?: string;
  user?: string;
  client?: string;
  userAgent?: string;
}
type ErrorFacts = { error: unknown };
type OutputFacts = { output: string; generation?: number };
export interface EventFacts {
  http_accept: {
    request: Request;
    req: number;
    inflight: number;
    peer: string;
    traceHeaders: boolean;
  };
  http_headers: {
    request: Request;
    req: number;
    inflight: number;
    status: number;
    waitMs: number;
  };
  http_done: {
    request: Request;
    req: number;
    inflight: number;
    bodyMs: number;
    aborted: boolean;
  };
  db_begin: { sql: string; qinflight: number };
  db_end: { sql: string; waitMs: number };
  db_overlap: { qinflight: number };
  command: {
    command: string;
    facts?: Record<string, unknown>;
    source: Provenance;
    intent?: string;
    queueCleared?: boolean;
  };
  config_changed: { key: string; source: Provenance };
  scan_complete: {
    files: number;
    skipped: number;
    artists: number;
    albums: number;
  };
  scan_skipped: { path: string } & ErrorFacts;
  scan_fingerprint_failed: { path: string } & ErrorFacts;
  scan_tags_failed: { path: string } & ErrorFacts;
  scan_failed: ErrorFacts;
  lookup_request: { plugin: string; host: string; status: string | number };
  lookup_lifecycle: {
    plugin: string;
    state: string;
    generation?: string;
    error?: string;
  };
  lookup_plugin_log: { plugin: string; payload: unknown };
  lookup_failed: { plugin: string } & ErrorFacts;
  podcast_failed: ErrorFacts;
  restore_complete: {
    queued: number;
    state: string;
    currentIndex: number | null;
    positionMs: number;
  };
  restore_missing: { track: string };
  address_registered: { host: string; preparation: string };
  listening: { hostname: string; port: number; kind: 'default' | 'extra' };
  server_error: ErrorFacts;
  server_finished: { port: number };
  server_failed: { port: number } & ErrorFacts;
  startup_failed: ErrorFacts;
  persistence_failed: ErrorFacts;
  state_listener_failed: ErrorFacts;
  notify_listener_failed: ErrorFacts;
  output_listener_failed: ErrorFacts;
  media_failed: {
    operation: string;
    phase?: string;
    path: string;
    format?: string;
  } & ErrorFacts;
  stream_empty: { path: string; format: string; offset: number };
  mdns_no_v4: { instance: string };
  discovery_failed: ErrorFacts;
  discovery_skipped: {
    instance: string;
    reason: 'name' | 'no_udp' | 'host_owned';
  };
  discovery_password: { instance: string };
  discovery_invalid: ErrorFacts;
  discovery_device: {
    instance: string;
    host: string;
    port: number;
    requiresAuth: boolean;
    encrypt: boolean;
    authsetup: boolean;
    metadata: number;
    devtype: string;
  };
  airplay_policy: { policy: string; default: string };
  pump_first: OutputFacts & { path: string; bytes: number };
  pump_end: OutputFacts & { path: string; bytes: number };
  content_failed: OutputFacts & ErrorFacts;
  session_retire: OutputFacts & { reason: string };
  session_retired: OutputFacts;
  retirement_failed: OutputFacts & ErrorFacts;
  retry_exhausted: OutputFacts & { attempts: number };
  retry_scheduled: OutputFacts & {
    attempt: number;
    limit: number;
    waitMs: number;
  };
  session_failed: OutputFacts & { reason: string; error?: unknown };
  preparation_failed: OutputFacts & ErrorFacts;
  session_start: OutputFacts & { strategy: string; grant: string };
  preparation_error: OutputFacts & ErrorFacts;
  retry_settings_failed: ErrorFacts;
  ffi_load_failed: ErrorFacts;
  native_record: {
    severity: number;
    domain: number;
    timeMs: number;
    nativeSequence: number;
    nativeEvent: string;
    device?: string;
    value?: number;
    payload?: unknown;
    truncated?: number;
    dropped?: number;
  };
  dependency_console: { method: string; args: unknown[] };
  dependency_debug: { namespace: string; args: unknown[] };
  dependency_ffmpeg: { sourceLevel: number; payload: string };
  sink_failed: { failures: number; dropped: number };
  fixture_info: { payload?: unknown };
  fixture_warn: { payload?: unknown };
  fixture_error: { payload?: unknown };
}
export type EventId = keyof EventFacts;
export interface EventDefinition {
  component: string;
  level: Level;
  message: string;
  fields: readonly string[];
}
const definition = (
  component: string,
  level: Level,
  message: string,
  fields: string,
): EventDefinition => ({
  component,
  level,
  message,
  fields: fields ? fields.split(' ') : [],
});
export const events: Record<EventId, EventDefinition> = {
  stream_empty: definition(
    'stream',
    'warn',
    'Transcode offset is beyond the end of the media',
    'path format offset',
  ),
  http_accept: definition(
    'http',
    'info',
    'Request accepted',
    'req inflight peer',
  ),
  http_headers: definition(
    'http',
    'info',
    'Response headers ready',
    'req inflight status waitMs',
  ),
  http_done: definition(
    'http',
    'info',
    'Response completed',
    'req inflight bodyMs aborted',
  ),
  db_begin: definition('db', 'info', 'Query started', 'qinflight'),
  db_end: definition('db', 'info', 'Query completed', 'waitMs'),
  db_overlap: definition(
    'db',
    'info',
    'Queries overlap on the shared connection',
    'qinflight',
  ),
  command: definition(
    'command',
    'info',
    'Engine or output command',
    'command facts intent queueCleared',
  ),
  config_changed: definition('config', 'info', 'Configuration changed', 'key'),
  scan_complete: definition(
    'scan',
    'info',
    'Library scan completed',
    'files skipped artists albums',
  ),
  scan_skipped: definition(
    'scan',
    'warn',
    'Library file skipped',
    'path error',
  ),
  scan_failed: definition('scan', 'error', 'Library scan failed', 'error'),
  lookup_request: definition(
    'lookups',
    'info',
    'Lookup outbound request',
    'plugin host status',
  ),
  lookup_lifecycle: definition(
    'lookups',
    'info',
    'Lookup plugin lifecycle',
    'plugin state generation error',
  ),
  lookup_plugin_log: definition(
    'lookups',
    'info',
    'Lookup plugin message',
    'plugin payload',
  ),
  lookup_failed: definition(
    'lookups',
    'error',
    'Lookup failed',
    'plugin error',
  ),
  podcast_failed: definition(
    'podcasts',
    'error',
    'Podcast refresh failed',
    'error',
  ),
  scan_fingerprint_failed: definition(
    'scan',
    'warn',
    'Audio fingerprint failed',
    'path error',
  ),
  scan_tags_failed: definition('scan', 'warn', 'Tags skipped', 'path error'),
  restore_complete: definition(
    'player',
    'info',
    'Engine restored',
    'queued state currentIndex positionMs',
  ),
  restore_missing: definition(
    'player',
    'warn',
    'Missing library track dropped during restore',
    'track',
  ),
  address_registered: definition(
    'airplay',
    'info',
    'Output address registered',
    'host preparation',
  ),
  listening: definition(
    'server',
    'info',
    'HTTP listener ready',
    'hostname port kind',
  ),
  server_error: definition(
    'server',
    'error',
    'HTTP server observed an error',
    'error',
  ),
  server_finished: definition(
    'server',
    'info',
    'HTTP listener finished',
    'port',
  ),
  server_failed: definition(
    'server',
    'error',
    'HTTP listener failed',
    'port error',
  ),
  startup_failed: definition(
    'server',
    'fatal',
    'Application startup failed',
    'error',
  ),
  persistence_failed: definition(
    'persistence',
    'debug',
    'Persistence write failed',
    'error',
  ),
  state_listener_failed: definition(
    'state',
    'debug',
    'State listener threw',
    'error',
  ),
  notify_listener_failed: definition(
    'notify',
    'debug',
    'Notification listener threw',
    'error',
  ),
  output_listener_failed: definition(
    'outputs',
    'debug',
    'Output command listener threw',
    'error',
  ),
  media_failed: definition(
    'media',
    'warn',
    'Media operation failed',
    'operation phase path format error',
  ),
  mdns_no_v4: definition(
    'mdns',
    'warn',
    'Service has no usable IPv4 address',
    'instance',
  ),
  discovery_failed: definition(
    'airplay',
    'warn',
    'Discovery unavailable; manual registration remains available',
    'error',
  ),
  discovery_skipped: definition(
    'airplay',
    'warn',
    'Discovery observation skipped',
    'instance reason',
  ),
  discovery_password: definition(
    'airplay',
    'warn',
    'Receiver password authentication unsupported',
    'instance',
  ),
  discovery_invalid: definition(
    'airplay',
    'warn',
    'Invalid receiver observation',
    'error',
  ),
  discovery_device: definition(
    'airplay',
    'warn',
    'AirPlay device discovered',
    'instance host port requiresAuth encrypt authsetup metadata devtype',
  ),
  airplay_policy: definition(
    'airplay',
    'info',
    'Connection policy initialized',
    'policy default',
  ),
  pump_first: definition(
    'airplay',
    'warn',
    'PCM pump first chunk',
    'output generation path bytes',
  ),
  pump_end: definition(
    'airplay',
    'warn',
    'PCM decoder completed',
    'output generation path bytes',
  ),
  content_failed: definition(
    'airplay',
    'error',
    'Output content failed',
    'output generation error',
  ),
  session_retire: definition(
    'airplay',
    'info',
    'Output session retiring',
    'output generation reason',
  ),
  session_retired: definition(
    'airplay',
    'info',
    'Output retired locally',
    'output generation',
  ),
  retirement_failed: definition(
    'airplay',
    'error',
    'Retirement failed; blocked until authorized restart',
    'output generation error',
  ),
  retry_exhausted: definition(
    'airplay',
    'warn',
    'Retries exhausted; explicit demand required',
    'output attempts',
  ),
  retry_scheduled: definition(
    'airplay',
    'warn',
    'Output retry scheduled',
    'output generation attempt limit waitMs',
  ),
  session_failed: definition(
    'airplay',
    'warn',
    'Output session failed',
    'output generation reason error',
  ),
  preparation_failed: definition(
    'airplay',
    'warn',
    'Output preparation failed',
    'output generation error',
  ),
  session_start: definition(
    'airplay',
    'info',
    'Output session starting',
    'output generation strategy grant',
  ),
  preparation_error: definition(
    'airplay',
    'error',
    'Output preparation threw',
    'output generation error',
  ),
  retry_settings_failed: definition(
    'airplay',
    'error',
    'Retry settings unavailable; automatic recovery disabled',
    'error',
  ),
  ffi_load_failed: definition(
    'airplay',
    'error',
    'Native RAOP library failed to load',
    'error',
  ),
  native_record: definition(
    'raop',
    'info',
    'Native diagnostic',
    'domain nativeSequence nativeEvent device value payload truncated dropped',
  ),
  dependency_console: definition(
    'dependency',
    'info',
    'Dependency console diagnostic',
    'method args',
  ),
  dependency_debug: definition(
    'music-metadata',
    'debug',
    'Dependency debug diagnostic',
    'namespace args',
  ),
  dependency_ffmpeg: definition(
    'node-av',
    'info',
    'FFmpeg diagnostic',
    'sourceLevel payload',
  ),
  sink_failed: definition(
    'logging',
    'error',
    'Log sink failure or overflow',
    'failures dropped',
  ),
  fixture_info: definition(
    'logging',
    'info',
    'Logging acceptance info',
    'payload',
  ),
  fixture_warn: definition(
    'logging',
    'warn',
    'Logging acceptance warning',
    'payload',
  ),
  fixture_error: definition(
    'logging',
    'error',
    'Logging acceptance error',
    'payload',
  ),
};
export const priorities: Record<Level, number> = {
  debug: 7,
  info: 6,
  notice: 5,
  warn: 4,
  error: 3,
  fatal: 2,
};
export function severity(id: EventId, facts: Record<string, unknown>): Level {
  if (id === 'native_record') {
    if (
      facts.nativeEvent === 'device_start' || facts.nativeEvent === 'pcm_peak'
    ) return 'info';
    if (facts.nativeEvent === 'player_tick') return 'debug';
    return typeof facts.severity === 'number'
      ? (['fatal', 'error', 'warn', 'info', 'debug', 'debug'] as Level[])[
        facts.severity
      ] ?? 'error'
      : 'error';
  }
  if (id === 'dependency_ffmpeg') {
    const level = typeof facts.sourceLevel === 'number'
      ? facts.sourceLevel
      : 16;
    return level <= 8
      ? 'fatal'
      : level <= 16
      ? 'error'
      : level <= 24
      ? 'warn'
      : level <= 32
      ? 'info'
      : level <= 40
      ? 'notice'
      : 'debug';
  }
  if (id === 'dependency_console') {
    return facts.method === 'error' || facts.method === 'assert'
      ? 'error'
      : facts.method === 'warn'
      ? 'warn'
      : facts.method === 'debug' || facts.method === 'trace'
      ? 'debug'
      : 'info';
  }
  return events[id].level;
}

const nativeMessages: Record<string, string> = {
  source_unavailable: 'Native local source unavailable',
  source_observation_error: 'Native source observation failed',
  source_changed: 'Native local source changed or inconsistent',
  source_schedule_failed: 'Native source observer reschedule failed',
  rtsp_source_failed: 'Native RTSP source snapshot failed',
  rtp_source_failed: 'Native RTP source snapshot failed',
  source_start_failed: 'Native source observer startup failed',
  device_start: 'Native AirPlay device starting',
  pcm_peak: 'Native PCM peak observed',
  player_tick: 'Native playback tick',
  resolve_failed: 'Native address resolution failed',
  teardown_unsent: 'Local cleanup completed; final TEARDOWN unsent',
  release_blocked: 'Native release blocked; ownership retained',
  gcrypt_init_failed: 'Native libgcrypt initialization failed',
  event_threads_failed: 'Native libevent threading initialization failed',
  timer_read_failed: 'Native playback timer read failed',
  player_create_failed: 'Native player allocation failed',
  timer_event_failed: 'Native playback timer allocation failed',
  timer_arm_failed: 'Native playback timer arm failed',
  overflow: 'Native diagnostic queue overflow',
  printf: 'Native dependency diagnostic',
  ffmpeg: 'System FFmpeg diagnostic',
  libevent: 'Libevent diagnostic',
};
export function nativePresentation(kind: string): string {
  return nativeMessages[kind] ?? 'Unrecognized native diagnostic';
}
export function nativeProjection(
  kind: string,
  payload: Record<string, unknown>,
): Record<string, unknown> | null {
  const device = payload.device;
  switch (kind) {
    case 'device_start': {
      const flags = Number(payload.flags);
      return {
        nativeDevice: device,
        name: payload.name,
        host: payload.host,
        port: payload.value,
        metadata: payload.value2,
        requiresAuth: !!(flags & 1),
        encrypt: !!(flags & 2),
        authsetup: !!(flags & 4),
        devtype: [
          'apex1',
          'apex2',
          'apex3',
          'appletv',
          'appletv4',
          'homepod',
          'other',
        ][flags >> 3] ?? 'unknown',
      };
    }
    case 'pcm_peak':
      return { pcm_peak: payload.value, samples: payload.value2 };
    case 'player_tick':
      return {
        pcm_buffered: payload.value,
        fed_samples: payload.value2,
        streaming: payload.flags === 1,
      };
    case 'resolve_failed':
      return { host: payload.host };
    case 'teardown_unsent':
    case 'release_blocked':
      return { nativeDevice: device };
    case 'source_unavailable':
    case 'source_observation_error':
    case 'rtsp_source_failed':
    case 'rtp_source_failed':
      return { nativeDevice: device, errno: payload.value };
    case 'source_changed':
    case 'source_schedule_failed':
    case 'source_start_failed':
      return { nativeDevice: device };
    case 'gcrypt_init_failed':
    case 'event_threads_failed':
    case 'timer_read_failed':
    case 'player_create_failed':
    case 'timer_event_failed':
    case 'timer_arm_failed':
      return {};
    default:
      return null;
  }
}
