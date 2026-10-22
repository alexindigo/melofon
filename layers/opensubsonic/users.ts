import type { UserProfile } from '#opensubsonic/types.ts';

// Every user can access every library until per-user library access exists.
export function userOf(user: UserProfile, folder: number[], sharing = false) {
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
    podcastRole: user.role === 'admin',
    streamRole: true,
    jukeboxRole: false,
    shareRole: sharing,
    videoConversionRole: false,
    folder,
  };
}
