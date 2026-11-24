// layers/opensubsonic/rest/getArtists/get.ts — GET /rest/getArtists: the ID3
// index of album artists.
import { ok } from '#opensubsonic/envelope.ts';
import { artistId3Of, artistIndex } from '#opensubsonic/id3.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (_request: HatRequest, context: HatContext) => {
  const { ignoredArticles } = await context.app.library.order();
  return ok(context, {
    artists: {
      // Spec Responses/ArtistsID3.md:84; Navidrome browsing.go:81–95.
      ignoredArticles: ignoredArticles.join(' '),
      index: await artistIndex(context, artistId3Of, ignoredArticles),
    },
  });
};
