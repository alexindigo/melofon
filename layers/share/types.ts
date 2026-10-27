// Structural ports only: this hat never imports core implementation modules.
export interface Share {
  id: string;
  description: string;
  downloadable: boolean;
}
export interface Track {
  id: string;
  path: string;
  title: string | null;
  fileName: string;
  artistName: string | null;
  albumName: string | null;
  albumFolderName: string | null;
  albumId: string | null;
  durationMs: number | null;
}
export interface ShareRequest {
  params: { id: string; n?: bigint };
  query: URLSearchParams;
  _raw: Request;
}
export interface ShareContext {
  app: {
    publicAddress: { full(request: Request, path: string): Promise<string> };
    state: { getTyped(key: string): Promise<unknown> };
    shares: {
      enabled(): Promise<boolean>;
      admitStream(id: string): Promise<(() => void) | null>;
      resolve(id: string): Promise<Share | 'expired' | null>;
      open(id: string): Promise<Share | 'expired' | null>;
      tracks(share: Share): Promise<Track[]>;
      publicUrl(): Promise<string>;
    };
    stream: { file(request: Request, path: string): Promise<Response> };
    artwork: {
      cover(id: string, options?: { size?: number }): Promise<Response>;
      placeholder(): Response;
    };
    zip: { archive(entries: { name: string; path: string }[]): Promise<Blob> };
  };
}
