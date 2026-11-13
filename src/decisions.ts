import type { Store } from './store/index.ts';
import type { Notify } from './notify.ts';
import {
  materializeArtistPhoto,
  materializeCandidate,
  materializeLyrics,
} from './unify.ts';

export function createDecisions(
  store: Store,
  options: { dataDir?: string; notify?: Notify } = {},
) {
  return {
    async accept(candidateId: string): Promise<void> {
      const candidate = await store.candidates.byId(candidateId);
      if (!candidate) throw new Error('Candidate not found');
      // All filesystem checks precede the atomic decision + queue operation.
      if (candidate.entityType === 'artist') {
        await materializeArtistPhoto(store, candidate, options.dataDir);
      } else if (candidate.kind === 'lyrics') {
        await materializeLyrics(store, candidate);
      } else await materializeCandidate(store, candidate);
      await store.candidates.accept(candidateId);
      options.notify?.emit(['library'], undefined, 'all');
    },
    async reject(candidateId: string): Promise<void> {
      if (!await store.candidates.byId(candidateId)) {
        throw new Error('Candidate not found');
      }
      await store.candidates.setState(candidateId, 'rejected');
      options.notify?.emit(['library'], undefined, 'all');
    },
  };
}
