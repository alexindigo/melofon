// layers/opensubsonic/rest/10-auth.ts — Subsonic auth for every /rest/…
// route. The hat extracts credentials (query or form body; `p` clear or
// `enc:`+hex, or `t`+`s` md5 token); core verifies via app.user. Failure is
// Navidrome-shaped: HTTP 200, status="failed", code 40 with a generic
// message (unknown user and bad password are indistinguishable); missing
// u/v/c → code 10. Success sets context.state.user = { username, displayName }.
import {
  failResponse,
  type HatContext,
  type HatRequest,
  hexDecode,
  params,
} from '../00-subsonic.ts';

// Subsonic POSTs are small form bodies — the middleware reads them.
export const disableStreaming = true;

export default async function (request: HatRequest, context: HatContext) {
  const p = await params(request);
  context.state.params = p;
  const username = p.get('u');
  if (username === null || p.get('v') === null || p.get('c') === null) {
    return failResponse(context, 10, 'Required parameter is missing');
  }
  let password = p.get('p');
  const token = p.get('t');
  const salt = p.get('s');
  let user = null;
  if (password !== null) {
    if (password.startsWith('enc:')) {
      try {
        password = hexDecode(password.slice(4));
      } catch {
        return failResponse(context, 40, 'Wrong username or password');
      }
    }
    user = await context.app.user.auth(username, password);
  } else if (token !== null && salt !== null) {
    user = await context.app.user.authMd5(username, token, salt);
  }
  if (user === null) {
    return failResponse(context, 40, 'Wrong username or password');
  }
  context.state.user = user;
}
