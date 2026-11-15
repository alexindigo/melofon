// Household app reports and aggregate now-playing. Engines supply live server
// rows; this owner alone subscribes to sessions and schedules report expiry.
import type { Library } from './library.ts';
import type {
  NowPlaying,
  PlaybackReport,
  SessionPlaybackReport,
} from './nowplaying.ts';
import type { Sessions } from './sessions.ts';
import type { Notify } from './notify.ts';
import type { State } from './state.ts';
import { type Log, scopedLog } from './logging.ts';
import { catalogMedia, type QueueMedia } from './queue-source.ts';
import { createOperationScope } from './operations.ts';

export interface ReportPlaying {
  username: string;
  client: string;
  trackId: string;
  /** Only the current stream's stop can clear its report. */
  streamId: string;
  positionMs?: number;
}

interface NowPlayingFacts {
  positionMs: number | null;
  startedAtMs: number | null;
  reportedAtMs: number;
  state: 'starting' | 'playing' | 'paused';
  playbackRate: number;
}

export type NowPlayingViewRow =
  & NowPlayingFacts
  & QueueMedia
  & (
    | { kind: 'app'; username: string; client: string; appPlayerId: number }
    | {
      kind: 'server';
      entryId: number;
      playerId: number;
      playerName: string;
      label: string;
      /** External commands replace attribution; internal transitions retain it. */
      commander: string | null;
      /** Selected targets, not evidence of audible output. */
      speakers: { id: string; name: string }[];
    }
  );

export type ServerNowPlayingRow = Extract<
  NowPlayingViewRow,
  { kind: 'server' }
>;

export interface PlaybackReports {
  reportPlaying(report: ReportPlaying): Promise<void>;
  reportStopped(opts: { streamId: string }): Promise<void>;
  reportPlayback(report: PlaybackReport): Promise<boolean>;
  reportSessionPlayback(report: SessionPlaybackReport): Promise<boolean>;
  nowPlayingView(): Promise<NowPlayingViewRow[]>;
  expireReports(): Promise<boolean>;
  startReportExpiry(state: State): Promise<void>;
  close(): Promise<void>;
}

export function createPlaybackReports(deps: {
  nowPlaying: NowPlaying;
  library: Pick<Library, 'getSong'>;
  /** One current row per engine, supplied by composition, never a cached view. */
  serverRows(): readonly ServerNowPlayingRow[];
  sessions?: Pick<Sessions, 'onSessionsEnded'>;
  notify?: Notify;
  log?: Log;
}): PlaybackReports {
  const { nowPlaying, library } = deps;
  const log = deps.log ?? scopedLog('playback');
  const invalidate = () => deps.notify?.emit(['nowPlaying'], undefined, 'all');
  const operations = createOperationScope('Playback reports');
  let expiryStarted = false;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let expiryWork: Promise<boolean> | undefined;
  // Queued session cleanup and timer cycles already have an admitted parent.
  // They may finish their sweep during close without reopening public intake.
  const sweep = (owned: boolean): Promise<boolean> => {
    if (expiryWork) return expiryWork;
    const work = async () => {
      try {
        const changed = await nowPlaying.expire();
        if (changed) invalidate();
        return changed;
      } finally {
        expiryWork = undefined;
      }
    };
    return expiryWork = owned ? operations.run(work) : work();
  };
  const expireReports = () =>
    operations.closed ? Promise.resolve(false) : sweep(true);
  // Revoke follows any sweep already in flight. Only committed removal emits.
  let sessionCleanup = Promise.resolve();
  const unsubscribeSessions = deps.sessions?.onSessionsEnded(() => {
    if (operations.closed) return;
    const previous = sessionCleanup;
    sessionCleanup = operations.run(async () => {
      try {
        await previous;
        await expiryWork;
        await sweep(false);
      } catch (error) {
        log.event('playback_expiry_failed', { error });
      }
    });
  });
  let intervalMs = 1000;
  const cycle = (state: State) =>
    operations.run(async () => {
      try {
        intervalMs =
          (await state.getTyped('playback.sessionSweepSeconds') as number) *
          1000;
        if (!operations.closed) await sweep(false);
      } catch (error) {
        log.event('playback_expiry_failed', { error });
      } finally {
        if (!operations.closed) {
          expiryTimer = setTimeout(() => {
            void cycle(state);
          }, intervalMs);
        }
      }
    });
  return {
    expireReports,
    startReportExpiry: (state) =>
      operations.run(async () => {
        if (expiryStarted) return;
        expiryStarted = true;
        state.declare('playback.sessionSweepSeconds', {
          type: 'number',
          minimum: 0.01,
          maximum: 3600,
          default: 1,
        });
        await cycle(state);
      }),
    reportPlaying: (report) =>
      operations.run(async () => {
        // Queue before an abort can queue its clear, retaining stream ordering.
        await nowPlaying.set(
          report.username,
          report.client,
          report.trackId,
          report.streamId,
          report.positionMs,
        );
        invalidate();
      }),
    reportStopped: ({ streamId }) =>
      operations.run(async () => {
        if (await nowPlaying.clearByStreamId(streamId)) invalidate();
      }),
    reportPlayback: (report) =>
      operations.run(async ({ signal }) => {
        const song = await library.getSong(report.trackId);
        signal.throwIfAborted();
        if (!song) return false;
        await nowPlaying.report(report, song.durationMs);
        invalidate();
        return true;
      }),
    reportSessionPlayback: (report) =>
      operations.run(async ({ signal }) => {
        const song = await library.getSong(report.trackId);
        signal.throwIfAborted();
        if (!song) return false;
        const changed = await nowPlaying.reportSession(report, song.durationMs);
        if (changed) invalidate();
        return changed;
      }),
    nowPlayingView: () =>
      operations.run(async ({ signal }) => {
        const out: NowPlayingViewRow[] = [...deps.serverRows()];
        for (const row of await nowPlaying.list()) {
          signal.throwIfAborted();
          const song = await library.getSong(row.trackId);
          signal.throwIfAborted();
          if (song === null) continue;
          out.push({
            kind: 'app',
            username: row.username,
            client: row.client,
            ...catalogMedia(song),
            positionMs: row.positionMs,
            startedAtMs: row.startedAtMs,
            reportedAtMs: row.reportedAtMs,
            state: row.state,
            playbackRate: row.playbackRate,
            appPlayerId: row.playerId,
          });
        }
        return out;
      }),
    close() {
      const alreadyClosed = operations.closed;
      const settled = operations.close();
      // Unsubscribing and clearing timers are synchronous; all accepted work,
      // including queued session cleanup and settings reads, is in the scope.
      if (!alreadyClosed) {
        unsubscribeSessions?.();
        clearTimeout(expiryTimer);
      }
      return settled;
    },
  };
}
