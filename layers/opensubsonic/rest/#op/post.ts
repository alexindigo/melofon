// POST /rest/<op> (no .view) — see get.ts for the normalizeOp note.
import {
  dispatch,
  type HatContext,
  type HatRequest,
  normalizeOp,
} from '../../00-subsonic.ts';

export default (request: HatRequest, context: HatContext) =>
  dispatch(normalizeOp(request.params.op), request, context);
