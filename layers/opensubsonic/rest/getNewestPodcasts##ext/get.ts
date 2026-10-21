import { ok } from '#opensubsonic/envelope.ts';
import { safeIntParam } from '#opensubsonic/params.ts';
import { podcastEpisodeOf } from '#opensubsonic/podcasts.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (_request: HatRequest, context: HatContext) => {
  const channels = new Map(
    (await context.app.podcasts.channels()).map((row) => [row.id, row]),
  );
  const episodes = await context.app.podcasts.newest(
    safeIntParam(context.state.params!, 'count', 20),
  );
  return ok(context, {
    newestPodcasts: {
      episode: episodes.map((row) =>
        podcastEpisodeOf(row, channels.get(row.channelId))
      ),
    },
  });
};
