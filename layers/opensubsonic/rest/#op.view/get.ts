// GET /rest/<op>.view — dispatch op → handler (see 00-subsonic.ts).
import {
  dispatch,
  type HatContext,
  type HatRequest,
} from '../../00-subsonic.ts';

export default (request: HatRequest, context: HatContext) =>
  dispatch(request.params.op, request, context);
