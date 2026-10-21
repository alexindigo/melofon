import type { HatRequest } from '#opensubsonic/types.ts';

// Form POST carries protocol parameters, not media bytes. After the hat has
// parsed them, every media read has GET semantics; HEAD retains its no-body
// contract. Preserve conditional/range headers and the caller's cancellation.
export function mediaReadRequest(request: HatRequest): Request {
  const raw = request._raw;
  return raw.method === 'POST'
    ? new Request(raw.url, {
      method: 'GET',
      headers: raw.headers,
      signal: raw.signal,
    })
    : raw;
}
