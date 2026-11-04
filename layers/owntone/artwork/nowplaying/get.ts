// layers/owntone/artwork/nowplaying/get.ts — GET /artwork/nowplaying: the
// current item's cover from app.playback.playerView() — THE shared read, so
// a mirrored client report's cover answers too (the engine wins when it has
// a current item). 404 when neither plane has anything.
import { notFound } from '#owntone/payloads.ts';
import type { HatContext } from '#owntone/types.ts';

export default async (_request: unknown, context: HatContext) => {
  const view = await context.app.playback.playerView();
  if (view.current === null || view.current.facts.kind !== 'song') {
    return notFound();
  }
  const song = view.current.facts.song;
  return context.app.artwork.cover(
    song.pictureHash ? song.id : song.albumId ?? song.id,
  );
};
