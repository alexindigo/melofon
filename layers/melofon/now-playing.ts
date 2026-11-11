import type { NowPlayingViewRow, PlayerQueueEntry } from './types.ts';
import { songDetail } from './browse-payloads.ts';

/** Reuse catalog labels, explicitly selecting household-safe display facts. */
export function nowPlayingPayload(row: NowPlayingViewRow) {
  return {
    ...(row.kind === 'app'
      ? {
        kind: row.kind,
        username: row.username,
        client: row.client,
        appPlayerId: row.appPlayerId,
      }
      : {
        kind: row.kind,
        label: row.label,
        playerId: row.playerId,
        playerName: row.playerName,
        commander: row.commander,
        speakers: row.speakers.map(({ id, name }) => ({ id, name })),
      }),
    ...queueMediaPayload(row),
    positionMs: row.positionMs,
    startedAtMs: row.startedAtMs,
    reportedAtMs: row.reportedAtMs,
    state: row.state,
    playbackRate: row.playbackRate,
  };
}

/** Queue and current rows share safe display facts, never resolved source URLs. */
export function queueMediaPayload(row: Pick<PlayerQueueEntry, 'facts'>) {
  const song = row.facts.kind === 'song' ? songDetail(row.facts.song) : null;
  return song === null
    ? {
      media: {
        kind: 'web',
        ...(row.facts.kind === 'web' && {
          title: row.facts.title,
          artistName: row.facts.artistName,
          durationMs: row.facts.durationMs,
          mode: row.facts.mode,
          seekable: row.facts.seekable,
          streamTitle: row.facts.streamTitle,
        }),
      },
    }
    : {
      song: {
        id: song.id,
        title: song.title,
        label: song.label,
        albumId: song.albumId,
        albumName: song.albumName,
        albumLabel: song.albumLabel,
        artistId: song.artistId,
        artistName: song.artistName,
        artistLabel: song.artistLabel,
        durationMs: song.durationMs,
        isVideo: song.isVideo,
      },
    };
}
