import type { NowPlayingViewRow } from './types.ts';
import { songDetail } from './browse-payloads.ts';

/** Reuse catalog labels, explicitly selecting household-safe display facts. */
export function nowPlayingPayload(row: NowPlayingViewRow) {
  const song = row.facts.kind === 'song' ? songDetail(row.facts.song) : null;
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
        commander: row.commander,
        speakers: row.speakers.map(({ id, name }) => ({ id, name })),
      }),
    ...(song === null
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
      }),
    positionMs: row.positionMs,
    startedAtMs: row.startedAtMs,
    reportedAtMs: row.reportedAtMs,
    state: row.state,
    playbackRate: row.playbackRate,
  };
}
