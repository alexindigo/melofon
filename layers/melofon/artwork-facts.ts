import type { ArtworkRef, HatContext } from './types.ts';
import { artworkUrl } from './artwork.ts';

/** Core owns discovery, background computation and persistence. A hat only
 * projects currently available facts after authorized source resolution. */
export function artworkFacts(context: HatContext) {
  return async (ref: ArtworkRef) => {
    const result = await context.app.artwork.describe(ref, {
      username: context.state.user.username,
    });
    if (result.kind !== 'image') return null;
    const descriptor = result.descriptor;
    return {
      url: artworkUrl(
        ref,
        descriptor.version,
        await context.app.publicAddress.prefix(),
      ),
      version: descriptor.version,
      width: descriptor.width,
      height: descriptor.height,
      thumbHash: descriptor.thumbHash ?? null,
      dominantColor: descriptor.dominantColor ?? null,
    };
  };
}
