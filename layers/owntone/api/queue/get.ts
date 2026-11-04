// layers/owntone/api/queue/get.ts — GET /api/queue: { version, count, items }.
// OwnTone's id/start/end filter params are not implemented in M5.
import { albumArtistResolver, queueItemPayload } from '#owntone/payloads.ts';
import type { HatContext } from '#owntone/types.ts';

export default async (_request: unknown, context: HatContext) => {
  const { version, items } = context.app.playback.queueView();
  const albumArtist = albumArtistResolver(context.app);
  return {
    version,
    count: items.length,
    items: await Promise.all(
      items.map(async (entry, position) =>
        queueItemPayload(
          entry,
          position,
          entry.facts.kind === 'song'
            ? await albumArtist(entry.facts.song.albumId)
            : null,
        )
      ),
    ),
  };
};
