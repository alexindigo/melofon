// layers/opensubsonic/rest/10-auth.ts — the common protocol for every /rest/…
// route: one ordered decision. First the response format and operation are
// resolved once (JSONP callback errors render as plain JSON before anything
// else); exact public capability discovery then returns; otherwise login
// mechanism errors (43 conflicting, 42 API key unsupported), missing u/v/c or
// incomplete credentials (10), the client version (20/30) and finally
// verification through app.user (40, generic: unknown user and bad password
// are indistinguishable). `p` is clear or `enc:`+hex; `t`+`s` is the md5
// token. Values are the first (form, then query) value; an empty one is
// absent. Errors ride HTTP 200. Success sets context.state.user.
import { fail } from '#opensubsonic/envelope.ts';
import {
  classifyCredentials,
  winningValue,
} from '#opensubsonic/credentials.ts';
import { hexDecode, params } from '#opensubsonic/params.ts';
import {
  checkVersion,
  operationName,
  resolveFormat,
} from '#opensubsonic/protocol.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

// Subsonic POSTs are small form bodies — the middleware reads them.
export const disableStreaming = true;

export default async function (request: HatRequest, context: HatContext) {
  const p = await params(request);
  context.state.params = p;
  // The facade has already stripped force/mount prefixes. The operation is
  // the complete repathed name, not a prefix or the caller's external URL.
  context.state.operation = operationName(
    new URL(request._raw.url).pathname,
    request.params.ext,
  );
  const format = await resolveFormat(p, (key) => context.app.state.get(key));
  if ('error' in format) {
    context.state.format = { type: 'json' };
    return format.error === 'missing-callback'
      ? fail(context, 10, 'Required parameter is missing')
      : fail(context, 0, 'invalid callback parameter');
  }
  context.state.format = format;
  // Params and format still precede this exception, so form precedence and
  // rendering are identical for public discovery.
  if (
    (request.method === 'GET' || request.method === 'POST') &&
    context.state.operation === 'getOpenSubsonicExtensions'
  ) return;
  const credentials = classifyCredentials({
    u: winningValue(p, 'u'),
    p: winningValue(p, 'p'),
    t: winningValue(p, 't'),
    s: winningValue(p, 's'),
    apiKey: winningValue(p, 'apiKey'),
  });
  if (credentials.kind === 'conflict') {
    return fail(
      context,
      43,
      'Multiple conflicting authentication mechanisms provided.',
    );
  }
  if (credentials.kind === 'unsupported') {
    return fail(
      context,
      42,
      'Provided authentication mechanism not supported.',
    );
  }
  const version = winningValue(p, 'v');
  if (
    credentials.kind === 'missing' || version === null ||
    winningValue(p, 'c') === null
  ) {
    return fail(context, 10, 'Required parameter is missing');
  }
  switch (checkVersion(version)) {
    case 'client-old':
      return fail(
        context,
        20,
        'Incompatible Subsonic REST protocol version. Client must upgrade.',
      );
    case 'server-old':
      return fail(
        context,
        30,
        'Incompatible Subsonic REST protocol version. Server must upgrade.',
      );
  }
  let user = null;
  if (credentials.kind === 'password') {
    let password = credentials.password;
    if (password.startsWith('enc:')) {
      try {
        password = hexDecode(password.slice(4));
      } catch {
        return fail(context, 40, 'Wrong username or password');
      }
    }
    user = await context.app.user.auth(credentials.username, password);
  } else {
    user = await context.app.user.authMd5(
      credentials.username,
      credentials.token,
      credentials.salt,
    );
  }
  if (user === null) {
    return fail(context, 40, 'Wrong username or password');
  }
  context.state.user = user;
}
