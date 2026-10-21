import { topSongs } from '#opensubsonic/reference.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default (_request: HatRequest, context: HatContext) => topSongs(context);
