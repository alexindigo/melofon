// Core client-session lifecycle and clock. Store owns all persistence.
import type { Store } from './store/index.ts';
import type { NativeReport, NowPlayingRow } from './store/nowplaying.ts';
import { createState, type State } from './state.ts';
export type { NowPlayingRow } from './store/nowplaying.ts';

export interface PlaybackReport {
  /** Supplied by the reporting facade, never copied from a wire parameter. */
  source: 'opensubsonic' | 'melofon';
  username: string;
  client: string;
  trackId: string;
  state: 'starting' | 'playing' | 'paused' | 'stopped';
  positionMs: number;
  playbackRate: number;
  ignoreScrobble: boolean;
}

export interface SessionPlaybackReport extends NativeReport {
  // Identity comes from authenticated core context; labels and source are derived.
  // run is a positive safe integer, sequence a nonnegative safe integer. Persist
  // the counters per login; a stopped/expired run cannot be resumed or replayed.
  ignoreScrobble: boolean;
}

function eligibleListen(
  report: { ignoreScrobble: boolean; positionMs: number },
  durationMs: number | null,
  source: PlaybackReport['source'],
  playedAtMs: number,
) {
  return !report.ignoreScrobble && durationMs !== null && durationMs > 0 &&
      report.positionMs >= Math.min(durationMs / 2, 240000)
    ? { source, durationMs, playedAtMs }
    : undefined;
}

export interface NowPlaying {
  set(
    username: string,
    client: string,
    trackId: string,
    streamId: string,
    positionMs?: number,
    durationMs?: number | null,
  ): Promise<void>;
  report(report: PlaybackReport, durationMs: number | null): Promise<void>;
  reportSession(
    report: SessionPlaybackReport,
    durationMs: number | null,
  ): Promise<boolean>;
  clearByStreamId(streamId: string): Promise<boolean>;
  list(): Promise<NowPlayingRow[]>;
  /** Remove expired reports without recording listens; true only after a removal commits. */
  expire(): Promise<boolean>;
}

export function createNowPlaying(store: Store, options: {
  state?: State;
  now?: () => number;
} = {}): NowPlaying {
  const state = options.state ?? createState(store);
  const now = options.now ?? Date.now;
  for (
    const key of [
      'playback.sessionGraceMinutes',
      'playback.pausedSessionMinutes',
    ]
  ) {
    state.declare(key, { type: 'number', minimum: 0, default: 30 });
  }
  const expiry = async (at: number) => ({
    plannedBeforeMs: at -
      (await state.getTyped('playback.sessionGraceMinutes') as number) * 60000,
    pausedBeforeMs: at -
      (await state.getTyped('playback.pausedSessionMinutes') as number) * 60000,
  });
  return {
    set(username, client, trackId, streamId, positionMs, durationMs) {
      return store.nowPlaying.set(
        username,
        client,
        trackId,
        streamId,
        positionMs,
        {
          state: 'playing',
          playbackRate: 1,
          reportedAtMs: now(),
          durationMs: durationMs ?? null,
          restart: true,
        },
      );
    },
    async report(report, durationMs) {
      if (report.source !== 'opensubsonic' && report.source !== 'melofon') {
        throw new Error('Invalid playback report source');
      }
      const at = now();
      if (report.state === 'stopped') {
        await store.nowPlaying.finish(
          report.username,
          report.client,
          report.trackId,
          await expiry(at),
          eligibleListen(report, durationMs, report.source, at),
        );
        return;
      }
      await store.nowPlaying.set(
        report.username,
        report.client,
        report.trackId,
        crypto.randomUUID(),
        report.positionMs,
        {
          state: report.state,
          playbackRate: report.playbackRate,
          reportedAtMs: at,
          durationMs,
          restart: report.state === 'starting',
        },
        await expiry(at),
      );
    },
    async reportSession(report, durationMs) {
      if (
        !Number.isSafeInteger(report.run) || report.run < 1 ||
        !Number.isSafeInteger(report.sequence) || report.sequence < 0 ||
        !Number.isSafeInteger(report.positionMs) || report.positionMs < 0 ||
        !Number.isFinite(report.playbackRate) || report.playbackRate <= 0 ||
        !['starting', 'playing', 'paused', 'stopped'].includes(report.state) ||
        typeof report.ignoreScrobble !== 'boolean' ||
        typeof report.userId !== 'string' ||
        typeof report.sessionId !== 'string'
      ) throw new Error('Invalid session playback report');
      const at = now();
      return store.nowPlaying.reportSession(
        report,
        {
          playbackRate: report.playbackRate,
          reportedAtMs: at,
          durationMs,
        },
        await expiry(at),
        report.state === 'stopped'
          ? eligibleListen(report, durationMs, 'melofon', at)
          : undefined,
      );
    },
    clearByStreamId: store.nowPlaying.clearByStreamId,
    async expire() {
      return (await store.nowPlaying.expire(await expiry(now()))) > 0;
    },
    async list() {
      const at = now();
      return (await store.nowPlaying.list(await expiry(at))).map((row) => ({
        ...row,
        positionMs: Math.trunc(
          Math.min(
            row.durationMs ?? Infinity,
            (row.positionMs ?? 0) +
              (row.state === 'playing'
                ? Math.max(0, at - row.reportedAtMs) * row.playbackRate
                : 0),
          ),
        ),
      }));
    },
  };
}
