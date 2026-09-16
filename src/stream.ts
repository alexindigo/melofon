// src/stream.ts — app.stream: original file bytes as a Response, with HTTP
// Range (std serveFile). M1 does not transcode: transcode query params are
// ignored by the hat, the file ships as-is. No listens are recorded here —
// stream is not a scrobble (that is M2's scrobble endpoint).
import { serveFile } from '@std/http/file-server';

export interface StreamService {
  /** Stream one file path to the client (200 full / 206 partial). */
  file(request: Request, path: string): Promise<Response>;
}

export function createStream(): StreamService {
  return {
    file(request, path) {
      return serveFile(request, path);
    },
  };
}
