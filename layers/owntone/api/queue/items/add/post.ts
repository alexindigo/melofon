// layers/owntone/api/queue/items/add/post.ts — POST
// /api/queue/items/add?uris=library:track:<id>|library:album:<id>[,…]
// uris only: no smart-playlist `expression` in M5. The clear=true, shuffle=…
// and playback=start modifiers are honored (OwnTone's); position/limit are
// not. Response { version, count, items } counts/lists the ADDED items.
import {
  albumArtistResolver,
  badRequest,
  boolParam,
  findAlbumByWire,
  findSongByWire,
  notFound,
  queueItemPayload,
} from '#owntone/payloads.ts';
import type { HatContext, HatRequest, SongRow } from '#owntone/types.ts';

export default async (request: HatRequest, context: HatContext) => {
  const uris = request.query.get('uris');
  if (uris === null) return badRequest(); // expression: not supported in M5
  const songs: SongRow[] = [];
  for (const raw of uris.split(',')) {
    const m = /^library:(track|album):(\d+)$/.exec(raw.trim());
    if (m === null) return badRequest();
    if (m[1] === 'track') {
      const song = await findSongByWire(context.app, m[2]);
      if (song === null) return notFound();
      songs.push(song);
    } else {
      const album = await findAlbumByWire(context.app, m[2]);
      if (album === null) return notFound();
      const got = await context.app.library.getAlbum(album.id);
      if (got === null) return notFound();
      songs.push(...got.songs);
    }
  }

  if (boolParam(request.query.get('clear'))) context.app.player.queueClear();
  const shuffle = request.query.get('shuffle');
  if (shuffle !== null) context.app.player.setShuffle(boolParam(shuffle));

  const base = context.app.player.queue().items.length;
  const added = context.app.player.queueAdd(songs);
  if (request.query.get('playback') === 'start') context.app.player.play();

  const albumArtist = albumArtistResolver(context.app);
  return {
    version: context.app.player.queue().version,
    count: added.length,
    items: await Promise.all(
      added.map(async (entry, i) =>
        queueItemPayload(
          entry,
          base + i,
          await albumArtist(entry.song.albumId),
        )
      ),
    ),
  };
};
