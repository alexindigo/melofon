// Core file sources retain their own identities. A podcast is playable media,
// not a catalog song and not a playback/listen reporting target.
import type { Library } from './library.ts';
import type { Podcasts } from './podcasts.ts';
import type { StreamFile } from './stream.ts';

export type FileSource = (
  id: string,
) => Promise<(StreamFile & { trackId?: string }) | null>;
export function createFileSource(
  library: Pick<Library, 'getSong'>,
  podcasts?: Pick<Podcasts, 'fileSource'>,
): FileSource {
  return async (id) => {
    const episode = await podcasts?.fileSource(id);
    if (episode) return episode;
    const song = await library.getSong(id);
    return song
      ? { path: song.path, isVideo: song.isVideo, trackId: song.id }
      : null;
  };
}
