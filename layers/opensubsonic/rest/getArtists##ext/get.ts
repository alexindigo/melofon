// layers/opensubsonic/rest/getArtists/get.ts — GET /rest/getArtists: the ID3
// index of album artists.
import { ok } from '#opensubsonic/envelope.ts';
import {
  artistId3Of,
  artistIndex,
  IGNORED_ARTICLES,
} from '#opensubsonic/id3.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (_request: HatRequest, context: HatContext) => {
  return ok(context, {
    artists: {
      ignoredArticles: IGNORED_ARTICLES,
      index: await artistIndex(context, artistId3Of),
    },
  });
};
