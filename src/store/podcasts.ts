import { atomic, type Engine, esc, type Queries } from './engine.ts';

export type PodcastStatus =
  | 'new'
  | 'downloading'
  | 'completed'
  | 'error'
  | 'deleted'
  | 'skipped';
export interface PodcastChannel {
  id: string;
  feedUrl: string;
  title: string | null;
  description: string | null;
  imageUrl: string | null;
  status: 'new' | 'completed' | 'error';
  errorMessage: string | null;
  lastRefreshMs: number | null;
}
export interface EpisodeFacts {
  guid: string;
  title: string | null;
  description: string | null;
  publishDate: string | null;
  enclosureUrl: string;
  contentType: string | null;
  enclosureLength: number | null;
  duration: number | null;
}
export interface PodcastEpisode extends EpisodeFacts {
  id: string;
  channelId: string;
  status: PodcastStatus;
  filePath: string | null;
  size: number | null;
}
export interface PodcastFeed {
  title: string | null;
  description: string | null;
  imageUrl: string | null;
  episodes: EpisodeFacts[];
}
const nullable = (value: string | number | null) =>
  value === null
    ? 'NULL'
    : typeof value === 'string'
    ? esc(value)
    : String(value);
const CHANNEL = `SELECT id, feed_url AS "feedUrl", title, description,
  image_url AS "imageUrl", status, error_message AS "errorMessage",
  last_refresh_ms AS "lastRefreshMs" FROM podcast_channels`;
const EPISODE = `SELECT id, channel_id AS "channelId", guid, title, description,
  publish_date AS "publishDate", enclosure_url AS "enclosureUrl",
  content_type AS "contentType", enclosure_length AS "enclosureLength",
  duration, status, file_path AS "filePath", size FROM podcast_episodes`;
const ORDER = ' ORDER BY publish_date DESC NULLS LAST, id';
const channel = async (q: Queries, id: string) =>
  (await q.all<PodcastChannel>(`${CHANNEL} WHERE id=${esc(id)}`))[0] ?? null;

/** Sole writer for both kept tables. No I/O or nested public operations. */
export function createPodcastsStore(engine: Engine) {
  return {
    channels: () =>
      engine.exclusive((q) => q.all<PodcastChannel>(`${CHANNEL} ORDER BY id`)),
    channel: (id: string) => engine.exclusive((q) => channel(q, id)),
    add(feedUrl: string): Promise<PodcastChannel> {
      return atomic(engine, async (q) => {
        const existing = (await q.all<PodcastChannel>(
          `${CHANNEL} WHERE feed_url=${esc(feedUrl)}`,
        ))[0];
        if (existing) return existing;
        const id = `podcast-${crypto.randomUUID()}`;
        await q.run(
          `INSERT INTO podcast_channels(id,feed_url,status) VALUES (${
            esc(id)
          },${esc(feedUrl)},'new')`,
        );
        return (await channel(q, id))!;
      });
    },
    saveFeed(
      id: string,
      feed: PodcastFeed,
      refreshedMs: number,
    ): Promise<PodcastChannel | null> {
      return atomic(engine, async (q) => {
        if (!await channel(q, id)) return null;
        await q.run(`UPDATE podcast_channels SET title=${nullable(feed.title)},
          description=${nullable(feed.description)}, image_url=${
          nullable(feed.imageUrl)
        },
          status='completed',error_message=NULL,last_refresh_ms=${refreshedMs} WHERE id=${
          esc(id)
        }`);
        for (const item of feed.episodes) {
          await q.run(`INSERT INTO podcast_episodes
            (id,channel_id,guid,title,description,publish_date,enclosure_url,content_type,enclosure_length,duration,status)
            VALUES (${esc(`episode-${crypto.randomUUID()}`)},${esc(id)},${
            esc(item.guid)
          },
              ${nullable(item.title)},${nullable(item.description)},${
            nullable(item.publishDate)
          },
              ${esc(item.enclosureUrl)},${nullable(item.contentType)},${
            nullable(item.enclosureLength)
          },${nullable(item.duration)},'new')
            ON CONFLICT (channel_id,guid) DO UPDATE SET title=excluded.title,
              description=excluded.description,publish_date=excluded.publish_date,
              enclosure_url=excluded.enclosure_url,content_type=excluded.content_type,
              enclosure_length=excluded.enclosure_length,duration=excluded.duration`);
        }
        return await channel(q, id);
      });
    },
    fail(id: string, message: string, refreshedMs: number) {
      return atomic(engine, async (q) => {
        await q.run(
          `UPDATE podcast_channels SET status='error',error_message=${
            esc(message)
          },last_refresh_ms=${refreshedMs} WHERE id=${esc(id)}`,
        );
        return await channel(q, id);
      });
    },
    delete(id: string): Promise<boolean> {
      return atomic(engine, async (q) => {
        if (!await channel(q, id)) return false;
        await q.run(`DELETE FROM podcast_episodes WHERE channel_id=${esc(id)}`);
        await q.run(`DELETE FROM podcast_channels WHERE id=${esc(id)}`);
        return true;
      });
    },
    episodes: (channelId: string) =>
      engine.exclusive((q) =>
        q.all<PodcastEpisode>(
          `${EPISODE} WHERE channel_id=${esc(channelId)}${ORDER}`,
        )
      ),
    newest: (count: number) =>
      engine.exclusive((q) =>
        q.all<PodcastEpisode>(
          `${EPISODE}${ORDER} LIMIT ${Math.max(0, Math.floor(count))}`,
        )
      ),
    episode: (id: string) =>
      engine.exclusive(async (q) =>
        (await q.all<PodcastEpisode>(`${EPISODE} WHERE id=${esc(id)}`))[0] ??
          null
      ),
  };
}
