// layers/opensubsonic/personal.ts — the requesting user's personal facts on
// the wire: one batched load per response (annotation.facts and listens.facts,
// each called once with every id), the OpenSubsonic starred date (the most
// recent like, Navidrome's rule — derived here from core's raw star events),
// and the per-DTO field rules. Shared module at the layer root, outside the
// walked mount tree.
import type {
  HatContext,
  PersonalFactsRow,
  PlayRow,
  StarEvent,
} from '#opensubsonic/types.ts';

/** One item's facts, already in wire units (ISO dates, rounded average). */
export interface Facts {
  /** Present only while the item is starred: its most recent like. */
  starred?: string;
  userRating?: number;
  averageRating?: number;
  playCount: number;
  played?: string;
}

export interface Personal {
  song(id: string): Facts;
  album(id: string): Facts;
  artist(id: string): Facts;
}

/** The most recent like: max time of the star events (null without one). */
export function lastStarredMs(events: StarEvent[]): number | null {
  let latest: number | null = null;
  for (const event of events) {
    if (event.action === 'star' && (latest === null || event.atMs > latest)) {
      latest = event.atMs;
    }
  }
  return latest;
}

const NO_PLAYS: PlayRow = { playCount: 0, lastPlayedMs: null };

function factsOf(row: PersonalFactsRow | undefined, play: PlayRow): Facts {
  const liked = row?.starred ? lastStarredMs(row.events) : null;
  const average = row?.averageRating ?? null;
  return {
    starred: liked === null ? undefined : new Date(liked).toISOString(),
    userRating: row?.userRating ?? undefined,
    averageRating: average === null
      ? undefined
      : Math.round(average * 100) / 100,
    playCount: play.playCount,
    played: play.lastPlayedMs === null
      ? undefined
      : new Date(play.lastPlayedMs).toISOString(),
  };
}

const EMPTY: Personal = {
  song: () => factsOf(undefined, NO_PLAYS),
  album: () => factsOf(undefined, NO_PLAYS),
  artist: () => factsOf(undefined, NO_PLAYS),
};

/** Loads every id's facts for the current user in one batch per service.
 * Ids that were not requested or are unknown get empty facts. */
export async function loadPersonal(
  context: HatContext,
  ids: { songs?: string[]; albums?: string[]; artists?: string[] },
): Promise<Personal> {
  const user = context.state.user;
  const songs = ids.songs ?? [];
  const albums = ids.albums ?? [];
  const artists = ids.artists ?? [];
  const all = [...songs, ...albums, ...artists];
  if (user === undefined || all.length === 0) return EMPTY;
  const annotations = await context.app.annotation.facts(user.username, [
    ...new Set(all),
  ]);
  const plays = await context.app.listens.facts(user.username, {
    songs,
    albums,
    artists,
  });
  const of = (kind: Record<string, PlayRow>) => (id: string) =>
    factsOf(annotations[id], kind[id] ?? NO_PLAYS);
  return {
    song: of(plays.songs),
    album: of(plays.albums),
    artist: of(plays.artists),
  };
}

// Per-DTO field rules. "Always" fields are OpenSubsonic additions that are
// present with an empty/default value; the rest are omitted without data.

/** Child (song, album-as-Child): played always (ISO or ""). */
export function childFields(f: Facts): Record<string, unknown> {
  return {
    starred: f.starred,
    userRating: f.userRating,
    averageRating: f.averageRating,
    playCount: f.playCount > 0 ? f.playCount : undefined,
    played: f.played ?? '',
  };
}

/** AlbumID3: userRating always (0 when unset), played always. */
export function albumId3Fields(f: Facts): Record<string, unknown> {
  return { ...childFields(f), userRating: f.userRating ?? 0 };
}

/** ArtistID3 and the legacy Artist: no play fields. */
export function artistFields(f: Facts): Record<string, unknown> {
  return {
    starred: f.starred,
    userRating: f.userRating,
    averageRating: f.averageRating,
  };
}

/** Directory (getMusicDirectory itself): played only when played. */
export function directoryFields(f: Facts): Record<string, unknown> {
  return { ...childFields(f), played: f.played };
}
