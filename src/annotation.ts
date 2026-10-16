// src/annotation.ts — app.annotation: per-user star history and ratings. The
// service owns classification policy; persistence and facts belong to store.
import type { Store } from './store/index.ts';
import type { PersonalFacts, StarredItem } from './store/annotations.ts';
export type {
  PersonalFacts,
  StarEvent,
  StarredItem,
  TargetType,
} from './store/annotations.ts';

export interface Annotation {
  /** Appends a star (a like) for a catalog id, even if already starred.
   * false (nothing written) when the id is no artist, album or song. */
  star(username: string, targetId: string): Promise<boolean>;
  /** Appends an unstar. An id that left the catalog keeps the type of the
   * user's latest event for it; false (nothing written) when it has none. */
  unstar(username: string, targetId: string): Promise<boolean>;
  /** Subsonic 1..5; 0 clears the rating row. false (nothing written) when
   * the id is no artist, album or song. */
  setRating(
    username: string,
    targetId: string,
    rating: number,
  ): Promise<boolean>;
  /** Items starred now that still exist (optionally only those in one
   * source), each with its events; ordered by targetId. */
  starred(
    username: string,
    opts?: { folderId?: string },
  ): Promise<StarredItem[]>;
  /** Batch facts: every requested id is present (missing data → not
   * starred, no events, null ratings). Orphans are not filtered. */
  facts(
    username: string,
    targetIds: string[],
  ): Promise<Record<string, PersonalFacts>>;
  /** Across all users: star events for the id and distinct users with one. */
  likes(targetId: string): Promise<{ likes: number; users: number }>;
}

export function createAnnotation(store: Store): Annotation {
  return {
    async star(username, targetId) {
      const type = await store.annotations.classify(username, targetId);
      if (type === null) return false;
      await store.annotations.appendStarEvent(username, targetId, type, 'star');
      return true;
    },
    async unstar(username, targetId) {
      let type = await store.annotations.classify(username, targetId);
      if (type === null) {
        type = await store.annotations.latestTargetType(username, targetId);
        if (type === null) return false;
      }
      await store.annotations.appendStarEvent(
        username,
        targetId,
        type,
        'unstar',
      );
      return true;
    },
    async setRating(username, targetId, rating) {
      if (await store.annotations.classify(username, targetId) === null) {
        return false;
      }
      if (rating === 0) await store.annotations.clearRating(username, targetId);
      else await store.annotations.setRating(username, targetId, rating);
      return true;
    },
    starred: (username, opts) => store.annotations.starred(username, opts),
    facts: (username, targetIds) =>
      store.annotations.facts(username, targetIds),
    likes: (targetId) => store.annotations.likes(targetId),
  };
}
