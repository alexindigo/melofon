import type { Store } from './store/index.ts';
import { materializeCandidate } from './unify.ts';

export function createDecisions(store: Store) {
  return {
    async accept(candidateId: string): Promise<void> {
      const candidate = await store.candidates.byId(candidateId);
      if (!candidate) throw new Error('Candidate not found');
      // All filesystem checks precede the atomic decision + queue operation.
      await materializeCandidate(store, candidate);
      await store.candidates.acceptCover(candidateId);
    },
    async reject(candidateId: string): Promise<void> {
      if (!await store.candidates.byId(candidateId)) {
        throw new Error('Candidate not found');
      }
      await store.candidates.setState(candidateId, 'rejected');
    },
  };
}
