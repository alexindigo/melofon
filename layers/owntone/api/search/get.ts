// layers/owntone/api/search/get.ts — GET /api/search. `type` is
// substring-matched like OwnTone's C (strstr: "track" matches track and
// tracks, "artist" both artist(s), …) so HA's type=tracks works. `query`
// maps onto search3 (artists/albums/songs) plus playlist/genre name filters;
// composers is an empty paging object (no composer data). `expression`: only
// `data_kind is pipe` (→ empty results, we have no pipes); anything else →
// 400. media_kind is accepted and ignored in this slice.
import {
  albumArtistLabel,
  albumArtistResolver,
  albumPayload,
  artistPayload,
  badRequest,
  browseArtists,
  paged,
  pagingParams,
  playlistPayload,
  trackPayload,
} from '#owntone/payloads.ts';
import type { HatContext, HatRequest } from '#owntone/types.ts';

export default async (request: HatRequest, context: HatContext) => {
  const type = request.query.get('type');
  const query = request.query.get('query');
  const expression = request.query.get('expression');
  if (type === null || (query === null && expression === null)) {
    return badRequest();
  }
  const paging = pagingParams(request.query);
  if (paging instanceof Response) return paging;
  const ALL = Number.MAX_SAFE_INTEGER;
  const wants = (kind: string) => type.includes(kind);
  const empty = {
    items: [] as unknown[],
    total: 0,
    offset: paging.offset,
    limit: paging.limit,
  };
  const reply: Record<string, unknown> = {};

  if (expression !== null) {
    const trimmed = expression.trim();
    if (trimmed.toLowerCase() === 'data_kind is pipe') {
      // No pipes of any kind: every requested type is an empty paging object.
      if (wants('track')) reply.tracks = empty;
      if (wants('artist')) reply.artists = empty;
      if (wants('album')) reply.albums = empty;
      if (wants('playlist')) reply.playlists = empty;
      if (wants('genre')) reply.genres = empty;
      if (wants('composer')) reply.composers = empty;
      return reply;
    }
    // The one smart-playlist shape we speak: genre is "<name>" (HA's
    // get_genre). Anything more is the full language — still 400.
    const gm = /^genre is "(.+)"$/i.exec(trimmed);
    if (gm === null) return badRequest();
    const genre = gm[1];
    if (wants('track')) {
      const albumArtist = albumArtistResolver(context.app);
      const songs = await context.app.library.songsByGenre(genre, {
        size: ALL,
        offset: 0,
      });
      reply.tracks = paged(
        await Promise.all(
          songs.map(async (s) => trackPayload(s, await albumArtist(s.albumId))),
        ),
        paging.offset,
        paging.limit,
      );
    }
    if (wants('album')) {
      const albums = await context.app.library.listAlbums({
        sort: 'genre',
        genre,
        size: ALL,
        offset: 0,
      });
      reply.albums = paged(
        albums.map(albumPayload),
        paging.offset,
        paging.limit,
      );
    }
    if (wants('artist')) {
      const albums = await context.app.library.listAlbums({
        sort: 'genre',
        genre,
        size: ALL,
        offset: 0,
      });
      const artistIds = new Set(albums.map((a) => albumArtistLabel(a).id));
      const artists = (await browseArtists(context.app)).filter((a) =>
        artistIds.has(a.id)
      );
      reply.artists = paged(
        await Promise.all(
          artists.map((a) => artistPayload(context.app, a)),
        ),
        paging.offset,
        paging.limit,
      );
    }
    // Playlists/genres/composers have no genre-expression meaning here.
    if (wants('playlist')) reply.playlists = empty;
    if (wants('genre')) reply.genres = empty;
    if (wants('composer')) reply.composers = empty;
    return reply;
  }

  const q = (query ?? '').toLowerCase();
  if (wants('track') || wants('artist') || wants('album')) {
    const found = await context.app.library.search3(query ?? '', {
      artistCount: ALL,
      artistOffset: 0,
      albumCount: ALL,
      albumOffset: 0,
      songCount: ALL,
      songOffset: 0,
    });
    if (wants('track')) {
      const albumArtist = albumArtistResolver(context.app);
      reply.tracks = paged(
        await Promise.all(
          found.songs.map(async (s) =>
            trackPayload(s, await albumArtist(s.albumId))
          ),
        ),
        paging.offset,
        paging.limit,
      );
    }
    if (wants('artist')) {
      reply.artists = paged(
        await Promise.all(
          found.artists.map((a) => artistPayload(context.app, a)),
        ),
        paging.offset,
        paging.limit,
      );
    }
    if (wants('album')) {
      reply.albums = paged(
        found.albums.map(albumPayload),
        paging.offset,
        paging.limit,
      );
    }
  }
  if (wants('playlist')) {
    const user = context.app.cfg.user;
    const playlists = user === undefined
      ? []
      : (await context.app.playlists.list(user)).filter((p) =>
        p.name.toLowerCase().includes(q)
      );
    reply.playlists = paged(
      playlists.map(playlistPayload),
      paging.offset,
      paging.limit,
    );
  }
  if (wants('genre')) {
    const genres = (await context.app.library.listGenres()).filter((g) =>
      g.name.toLowerCase().includes(q)
    );
    reply.genres = paged(
      genres.map((g) => ({ name: g.name })),
      paging.offset,
      paging.limit,
    );
  }
  if (wants('composer')) reply.composers = empty;
  return reply;
};
