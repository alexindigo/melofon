// layers/owntone/artwork/nowplaying/get.ts — GET /artwork/nowplaying: the
// wire-reported current item's cover (the queue head when stopped, per the
// player status fallback). 404 when the queue is empty.
import { notFound } from '#owntone/payloads.ts';
import type { HatContext } from '#owntone/types.ts';

export default (_request: unknown, context: HatContext) => {
  const current = context.app.player.status().current;
  if (current === null) return notFound();
  return context.app.artwork.cover(current.song.albumId ?? current.song.id);
};
