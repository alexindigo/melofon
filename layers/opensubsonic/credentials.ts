// layers/opensubsonic/credentials.ts — plugin-private classification of the
// login mechanism a request supplied. Values are the winning (first, form
// before query) parameters; an empty winning value counts as not sent and
// never falls through to a later value (Navidrome's empty-is-missing rule).
// API keys are not supported: alone they are unsupported (42), together with
// u/p/t/s they conflict (43), as does p with t or s.

/** The first value of a parameter, or null when absent or empty. */
export function winningValue(
  params: URLSearchParams,
  name: string,
): string | null {
  const value = params.get(name);
  return value === '' ? null : value;
}

export interface CredentialValues {
  u: string | null;
  p: string | null;
  t: string | null;
  s: string | null;
  apiKey: string | null;
}

export type Credentials =
  | { kind: 'conflict' }
  | { kind: 'unsupported' }
  | { kind: 'missing' }
  | { kind: 'password'; username: string; password: string }
  | { kind: 'token'; username: string; token: string; salt: string };

export function classifyCredentials(values: CredentialValues): Credentials {
  const { u, p, t, s, apiKey } = values;
  if (apiKey !== null) {
    return u !== null || p !== null || t !== null || s !== null
      ? { kind: 'conflict' }
      : { kind: 'unsupported' };
  }
  if (p !== null && (t !== null || s !== null)) return { kind: 'conflict' };
  if (u === null) return { kind: 'missing' };
  if (p !== null) return { kind: 'password', username: u, password: p };
  if (t !== null && s !== null) {
    return { kind: 'token', username: u, token: t, salt: s };
  }
  return { kind: 'missing' };
}
