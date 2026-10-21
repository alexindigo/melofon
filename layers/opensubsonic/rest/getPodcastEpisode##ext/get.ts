import { notFound, ok } from '#opensubsonic/envelope.ts';
import { requiredParam } from '#opensubsonic/params.ts';
import { podcastEpisodeOf } from '#opensubsonic/podcasts.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (_request: HatRequest, context: HatContext) => {
  const id = requiredParam(context, 'id');
  if (id instanceof Response) return id;
  const episode = await context.app.podcasts.episode(id);
  if (!episode) return notFound(context);
  const channel = (await context.app.podcasts.channels()).find((row) =>
    row.id === episode.channelId
  );
  return ok(context, { podcastEpisode: podcastEpisodeOf(episode, channel) });
};
