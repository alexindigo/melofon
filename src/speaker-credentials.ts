import type { Secrets, SpeakerCredentialKind } from './secrets.ts';
import { SecretError } from './secrets.ts';
import { SpeakerError } from './speaker-errors.ts';
import type { Store } from './store/index.ts';
import type { EncryptedSpeakerCredential } from './store/speakers.ts';

/** Private core owner. Never injected into hats or public Output/Speaker views.
 * Output incarnations fence delayed crypto/store results across forget/release.
 * Adapter-specific validation and playback authority belong to the adapter. */
export function createSpeakerCredentials(deps: {
  store: Store['speakers'];
  secrets: Secrets;
  current(id: string): { revision: number; adopted: boolean } | null;
}) {
  const memory = new Map<string, Map<SpeakerCredentialKind, string>>();
  const tails = new Map<string, Promise<unknown>>();
  const requireCurrent = (id: string, revision?: number) => {
    const current = deps.current(id);
    if (!current || (revision !== undefined && current.revision !== revision)) {
      throw new SpeakerError(
        'not_found',
        'Speaker credential lifetime has ended',
      );
    }
    return current;
  };
  const kindOf = (kind: SpeakerCredentialKind) => {
    if (kind !== 'password' && kind !== 'pairing-key') {
      throw new SpeakerError(
        'invalid_field',
        'Invalid speaker credential kind',
      );
    }
  };
  const serialize = <T>(
    id: string,
    operation: (revision: number) => Promise<T>,
    before: Promise<void> = Promise.resolve(),
  ): Promise<T> => {
    const revision = requireCurrent(id).revision;
    const work = (tails.get(id) ?? Promise.resolve()).catch(() => {}).then(
      async () => {
        await before;
        requireCurrent(id, revision);
        return operation(revision);
      },
    );
    const tail = work.finally(() => {
      if (tails.get(id) === tail) tails.delete(id);
    });
    tails.set(id, tail);
    // The caller owns work's rejection, not the housekeeping tail.
    void tail.catch(() => {});
    return work;
  };
  const durable = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof SecretError || error instanceof SpeakerError) {
        throw error;
      }
      throw new SpeakerError(
        'persistence_failed',
        'Speaker credential could not be saved or loaded',
      );
    }
  };
  return {
    /** Called synchronously when the registry ends an incarnation. */
    release(id: string): void {
      memory.delete(id);
    },
    async get(id: string, kind: SpeakerCredentialKind): Promise<string | null> {
      kindOf(kind);
      return await serialize(id, async (revision) => {
        if (!requireCurrent(id, revision).adopted) {
          return memory.get(id)?.get(kind) ?? null;
        }
        const stored = await durable(() => deps.store.loadCredential(id, kind));
        const value = stored === null
          ? null
          : await deps.secrets.decrypt({ speakerId: id, kind }, stored);
        requireCurrent(id, revision);
        return value;
      });
    },
    async set(
      id: string,
      kind: SpeakerCredentialKind,
      value: string | null,
    ): Promise<void> {
      // Register before any validation or error-producing work, including temporary use.
      if (typeof value === 'string') deps.secrets.register(value);
      kindOf(kind);
      if (value !== null && typeof value !== 'string') {
        throw new SpeakerError('invalid_field', 'Invalid speaker credential');
      }
      await serialize(id, async (revision) => {
        if (requireCurrent(id, revision).adopted) {
          const ciphertext = value === null
            ? null
            : await deps.secrets.encrypt({ speakerId: id, kind }, value);
          requireCurrent(id, revision);
          await durable(() => deps.store.saveCredential(id, kind, ciphertext));
          requireCurrent(id, revision);
        } else {
          const values = memory.get(id) ??
            new Map<SpeakerCredentialKind, string>();
          if (value === null) values.delete(kind);
          else values.set(kind, value);
          if (values.size) memory.set(id, values);
          else memory.delete(id);
        }
      });
    },
    /** Encryption finishes before the atomic configuration/credential store call.
     * The callback publishes durable adoption before releasing this per-id queue. */
    async adopt(
      id: string,
      save: (records: EncryptedSpeakerCredential[]) => Promise<void>,
      before: Promise<void> = Promise.resolve(),
    ): Promise<void> {
      await serialize(id, async (revision) => {
        const records: EncryptedSpeakerCredential[] = [];
        for (const [kind, value] of memory.get(id) ?? []) {
          records.push({
            kind,
            ciphertext: await deps.secrets.encrypt(
              { speakerId: id, kind },
              value,
            ),
          });
        }
        requireCurrent(id, revision);
        await durable(() => save(records));
        requireCurrent(id, revision);
        memory.delete(id);
      }, before);
    },
  };
}

export type SpeakerCredentials = ReturnType<typeof createSpeakerCredentials>;
