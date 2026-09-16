// GET /rest/<op> (no .view). Depending on route registration order this file
// may also capture /rest/<op>.view paths — normalizeOp strips the suffix, so
// dispatch is correct under either order.
import {
  dispatch,
  type HatContext,
  type HatRequest,
  normalizeOp,
} from '../../00-subsonic.ts';

export default (request: HatRequest, context: HatContext) =>
  dispatch(normalizeOp(request.params.op), request, context);
