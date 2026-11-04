// layers/owntone/api/queue/items/add/post.ts — POST
// /api/queue/items/add?uris=…&position=&playback=&playback_from_position=&clear=&shuffle=
// uris: library:track|album|artist|playlist:<digits> or library:genre:<name>
// (comma-separated). The hat translates each uri to songs (a facade's one
// job); core's playback.queueAdd owns clear/insert/shuffle/play and emits.
// expression stays unsupported (genre plays use the genre URI); unknown id
// or genre → 404; malformed uri → 400; http/DLNA stays 400.
import {
  albumArtistResolver,
  artistAlbums,
  badRequest,
  boolParam,
  findAlbumByWire,
  findArtistByWire,
  findPlaylistByWire,
  findSongByWire,
  intParam,
  notFound,
  playbackCommand,
  queueItemPayload,
  sourceFrom,
} from '#owntone/payloads.ts';
import type { HatContext, HatRequest, SongRow } from '#owntone/types.ts';

const ALL = 9007199254740991; // Largest exactly representable safe integer.

async function songsForUri(
  context: HatContext,
  kind: string,
  id: string,
): Promise<SongRow[] | null> {
  const app = context.app;
  if (kind === 'track') {
    const song = await findSongByWire(app, id);
    return song === null ? null : [song];
  }
  if (kind === 'album') {
    const album = await findAlbumByWire(app, id);
    if (album === null) return null;
    return (await app.library.getAlbum(album.id))?.songs ?? null;
  }
  if (kind === 'artist') {
    const artist = await findArtistByWire(app, id);
    if (artist === null) return null;
    const songs: SongRow[] = [];
    for (const album of await artistAlbums(app, artist.id)) {
      const got = await app.library.getAlbum(album.id);
      if (got !== null) songs.push(...got.songs);
    }
    return songs;
  }
  // playlist — OwnTone's are global, Melofon's are the seeded user's
  if (app.cfg.user === undefined) return null;
  const playlist = await findPlaylistByWire(app, id);
  if (playlist === null) return null;
  const full = await app.playlists.get(app.cfg.user, playlist.id);
  if (full === null) return null;
  return (
    await Promise.all(full.trackIds.map((tid) => app.library.getSong(tid)))
  ).filter((s): s is SongRow => s !== null);
}

export default async (request: HatRequest, context: HatContext) => {
  const uris = request.query.get('uris');
  if (uris === null) return badRequest(); // expression: not supported
  const songs: SongRow[] = [];
  for (const raw of uris.split(',')) {
    const uri = raw.trim();
    const m = /^library:(track|album|artist|playlist):(\d+)$/.exec(uri);
    if (m !== null) {
      const found = await songsForUri(context, m[1], m[2]);
      if (found === null) return notFound();
      songs.push(...found);
      continue;
    }
    const g = /^library:genre:(.+)$/.exec(uri);
    if (g !== null) {
      const found = await context.app.library.songsByGenre(g[1], {
        size: ALL,
        offset: 0,
      });
      if (found.length === 0) return notFound();
      songs.push(...found);
      continue;
    }
    return badRequest();
  }

  const rawPosition = request.query.get('position');
  const position = rawPosition === null ? undefined : intParam(rawPosition);
  if (position === null) return badRequest();
  const rawFrom = request.query.get('playback_from_position');
  const playbackFromPosition = rawFrom === null ? undefined : intParam(rawFrom);
  if (playbackFromPosition === null) return badRequest();
  const shuffleParam = request.query.get('shuffle');

  return playbackCommand(async () => {
    const added = await context.app.playback.queueAdd(songs, {
      position,
      playbackFromPosition,
      play: request.query.get('playback') === 'start',
      clear: boolParam(request.query.get('clear')),
      shuffle: shuffleParam === null ? undefined : boolParam(shuffleParam),
    }, sourceFrom(request));

    const queue = context.app.playback.queueView();
    const positions = new Map(
      queue.items.map((entry, position) => [entry.id, position]),
    );
    const albumArtist = albumArtistResolver(context.app);
    return {
      version: queue.version,
      count: added.length,
      items: await Promise.all(
        added.map(async (entry) =>
          queueItemPayload(
            entry,
            positions.get(entry.id)!,
            entry.facts.kind === 'song'
              ? await albumArtist(entry.facts.song.albumId)
              : null,
          )
        ),
      ),
    };
  }, (result) => result);
};
