import { notFound, ok } from '#opensubsonic/envelope.ts';
import { optionalBool } from '#opensubsonic/params.ts';
import { podcastChannelOf, podcastEpisodeOf } from '#opensubsonic/podcasts.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (_request: HatRequest, context: HatContext) => {
  const params = context.state.params!;
  const id = params.get('id');
  const include = optionalBool(params.get('includeEpisodes')) ?? true;
  const channels = (await context.app.podcasts.channels()).filter((row) =>
    id === null || row.id === id
  );
  if (id !== null && channels.length === 0) return notFound(context);
  return ok(context, {
    podcasts: {
      channel: await Promise.all(channels.map(async (channel) => ({
        ...podcastChannelOf(channel),
        episode: include
          ? (await context.app.podcasts.episodes(channel.id)).map((episode) =>
            podcastEpisodeOf(episode, channel)
          )
          : undefined,
      }))),
    },
  });
};
