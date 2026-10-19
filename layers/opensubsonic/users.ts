import type { UserProfile } from '#opensubsonic/types.ts';

// Every user can access every library until per-user library access exists.
export function userOf(user: UserProfile, folder: number[]) {
  return {
    username: user.username,
    scrobblingEnabled: true,
    adminRole: user.role === 'admin',
    settingsRole: true,
    downloadRole: true,
    uploadRole: false,
    playlistRole: true,
    coverArtRole: true,
    commentRole: false,
    podcastRole: false,
    streamRole: true,
    jukeboxRole: false,
    shareRole: false,
    videoConversionRole: false,
    folder,
  };
}
