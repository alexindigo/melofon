import { fail } from '#opensubsonic/envelope.ts';
import type {
  HatContext,
  PodcastChannelRow,
  PodcastEpisodeRow,
} from '#opensubsonic/types.ts';

// Protocol-only administration, like radio: core has no user/role rule.
export async function podcastWriteGuard(
  context: HatContext,
): Promise<Response | undefined> {
  const username = context.state.user!.username;
  const user = await context.app.user.get(username, username);
  if (!user || user === 'forbidden' || user.role !== 'admin') {
    return fail(context, 50, 'User is not authorized for the given operation');
  }
}

// PodcastChannel.md:82–92; keep optional unknown facts absent on the wire.
export function podcastChannelOf(channel: PodcastChannelRow) {
  return {
    id: channel.id,
    url: channel.feedUrl,
    title: channel.title ?? undefined,
    description: channel.description ?? undefined,
    coverArt: channel.imagePath ? channel.id : undefined,
    originalImageUrl: channel.imageUrl ?? undefined,
    status: channel.status,
    errorMessage: channel.errorMessage ?? undefined,
  };
}

// PodcastEpisode.md:65–74 extends Child. These are podcast facts, not
// catalog songs: no invented artist, catalog identity or personal play facts.
export function podcastEpisodeOf(
  episode: PodcastEpisodeRow,
  channel: PodcastChannelRow | undefined,
) {
  const completed = episode.status === 'completed';
  return {
    id: episode.id,
    isDir: false,
    title: episode.title ?? '[Untitled Episode]',
    album: channel?.title ?? undefined,
    type: 'podcast',
    duration: episode.duration === null
      ? undefined
      : Math.round(episode.duration),
    coverArt: channel?.imagePath ? channel.id : undefined,
    contentType: completed ? episode.contentType ?? undefined : undefined,
    suffix: completed ? episode.filePath?.split('.').pop() : undefined,
    size: completed ? episode.size ?? undefined : undefined,
    channelId: episode.channelId,
    description: episode.description ?? undefined,
    status: episode.status,
    publishDate: episode.publishDate ?? undefined,
    streamId: completed ? episode.streamId : undefined,
  };
}
