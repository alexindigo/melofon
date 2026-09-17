// layers/opensubsonic/rest/getAvatar/get.ts — GET /rest/getAvatar.
// No avatars (no Gravatar, no uploads): the same placeholder tile as
// getCoverArt's fallback. The username param is ignored, Navidrome-style.
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default (_request: HatRequest, context: HatContext) =>
  context.app.artwork.placeholder();
