// Pinned Responses/internetRadioStation.md:31-35, optional art is absent.
import { ok } from '#opensubsonic/envelope.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (_request: HatRequest, context: HatContext) =>
  ok(context, {
    internetRadioStations: {
      internetRadioStation: (await context.app.radio.list()).map((row) => ({
        id: row.id,
        name: row.name,
        streamUrl: row.streamUrl,
        ...(row.homePageUrl === null ? {} : { homePageUrl: row.homePageUrl }),
      })),
    },
  });
