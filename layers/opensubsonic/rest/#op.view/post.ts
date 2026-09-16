// POST /rest/<op>.view — form params were merged by 10-auth; same dispatch.
import {
  dispatch,
  type HatContext,
  type HatRequest,
} from '../../00-subsonic.ts';

export default (request: HatRequest, context: HatContext) =>
  dispatch(request.params.op, request, context);
