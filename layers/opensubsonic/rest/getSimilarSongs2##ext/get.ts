import { similarSongs } from '#opensubsonic/reference.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default (_request: HatRequest, context: HatContext) =>
  similarSongs(context, 'similarSongs2');
