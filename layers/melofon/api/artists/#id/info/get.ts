import type { HatContext, HatRequest } from '#melofon/types.ts';
import { artistReferenceQuery } from '#melofon/artist-reference.ts';
import { browseArtwork } from '#melofon/browse-payloads.ts';

export default async function (request: HatRequest, context: HatContext) {
  const { artist, folderId, limit, includeNotPresent } =
    await artistReferenceQuery(request, context, true);
  const payload = browseArtwork(context);
  const info = {
    biography: null,
    musicBrainzId: null,
    url: null,
    similarArtists: [],
  } as {
    biography: { text: string; language?: string } | null;
    musicBrainzId: string | null;
    url: string | null;
    similarArtists: unknown[];
  };
  if (artist.kind === 'artist') {
    const values = await context.app.reference.get('artist', artist.id!, [
      'artist.biography',
      'artist.url',
      'artist.id.mbid',
    ]);
    info.biography = values['artist.biography'] ?? null;
    info.musicBrainzId = artist.musicBrainzId ?? values['artist.id.mbid'] ??
      null;
    info.url = values['artist.url']?.url ?? null;
    const related = await context.app.reference.similarArtists(
      artist.id!,
      limit,
      !includeNotPresent,
      folderId,
    );
    for (const match of related) {
      if (match.present) {
        const { artist: local } = await context.app.library.getArtistSnapshot({
          kind: 'artist',
          id: match.id,
        }, folderId);
        if (local) {
          info.similarArtists.push({
            present: true,
            ...await payload.artist(local),
          });
        }
      } else {
        info.similarArtists.push({
          present: false,
          name: match.name,
          musicBrainzId: match.mbid ?? null,
        });
      }
    }
  }
  return Response.json({ info }, {
    headers: { 'Cache-Control': 'private, no-store' },
  });
}
