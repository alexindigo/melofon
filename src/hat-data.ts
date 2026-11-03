import { decodeHex, encodeHex } from '@std/encoding/hex';
import type { Store } from './store/index.ts';
import type { State } from './state.ts';
import { createHatDataFiles } from './hat-data-files.ts';

export type HatDataValue = null | boolean | number | string | HatDataValue[] | {
  [key: string]: HatDataValue;
};
export type HatDataRecord =
  | { kind: 'data'; value: HatDataValue }
  | { kind: 'credential'; value: string }
  | { kind: 'image'; value: Uint8Array; contentType: string };
export type HatDataInput = Exclude<HatDataRecord, { kind: 'image' }> | {
  kind: 'image';
  value: Uint8Array;
};
export interface HatDataScope {
  /** Stable core user id; absent means hat-global. Core does not infer a caller. */
  userId?: string;
}
export type HatDataServices = ReturnType<typeof createHatData>;

/** Only the loader receives this factory. Hats receive its frozen bound result. */
export function createHatData(
  store: Pick<Store, 'hatData'>,
  cfg: { secret?: string; dataDir?: string },
  state?: Pick<State, 'declare' | 'getTyped'>,
): (hat: string) => {
  get(key: string, scope?: HatDataScope): Promise<HatDataRecord | null>;
  put(key: string, record: HatDataInput, scope?: HatDataScope): Promise<void>;
  remove(key: string, scope?: HatDataScope): Promise<boolean>;
  list(
    scope?: HatDataScope,
  ): Promise<{ key: string; kind: HatDataRecord['kind'] }[]>;
} {
  const defaults: Record<string, number> = {
    maxImageBytes: 20971520,
    maxImagePixels: 64000000,
  };
  for (const [name, value] of Object.entries(defaults)) {
    state?.declare(`hatData.${name}`, {
      type: 'integer',
      minimum: 1,
      default: value,
    });
  }
  const setting = async (name: string) =>
    Number(await state?.getTyped(`hatData.${name}`) ?? defaults[name]);
  const files = cfg.dataDir ? createHatDataFiles(cfg.dataDir) : undefined;
  // One owner serializes file reads, publication and retirement across hats.
  // Store slots remain short and contain no filesystem or crypto work.
  let tail: Promise<unknown> = Promise.resolve();
  let ready = false;
  function serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = tail.then(async () => {
      if (!ready && files) {
        await files.prune(await store.hatData.imagePayloads());
        ready = true;
      }
      return operation();
    });
    tail = result.catch(() => {});
    return result;
  }
  async function retire(row: { kind: string; payload: string } | null) {
    if (row?.kind === 'image') {
      if (!files) {
        throw new Error('A data directory is required for hat images');
      }
      await files.retire(row.payload);
    }
  }
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  async function credentialKey() {
    if (!cfg.secret) {
      throw new Error('MELOFON_SECRET is required for hat credentials');
    }
    const digest = await crypto.subtle.digest(
      'SHA-256',
      encoder.encode(`melofon/hat-data/credential/v1\0${cfg.secret}`),
    );
    return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, [
      'encrypt',
      'decrypt',
    ]);
  }
  function owner(scope?: HatDataScope): string {
    if (scope?.userId === undefined) return '';
    if (
      typeof scope.userId !== 'string' || !scope.userId ||
      scope.userId.includes('\0')
    ) {
      throw new Error('Invalid hat record owner');
    }
    return scope.userId;
  }
  function recordKey(key: string) {
    if (typeof key !== 'string' || !key || key.includes('\0')) {
      throw new Error('Invalid hat record key');
    }
  }
  return (hat: string) => {
    if (!hat) throw new Error('A hat name is required');
    const aad = (scope: string, key: string) =>
      encoder.encode(JSON.stringify([hat, scope, key, 'credential', 1]));
    return Object.freeze({
      get(
        key: string,
        input?: HatDataScope,
      ): Promise<HatDataRecord | null> {
        return serial(async () => {
          recordKey(key);
          const scope = owner(input);
          const row = await store.hatData.get(hat, scope, key);
          if (!row) return null;
          if (row.kind === 'data') {
            return { kind: 'data', value: JSON.parse(row.payload) };
          }
          if (row.kind === 'image') {
            if (!files) {
              throw new Error('A data directory is required for hat images');
            }
            return {
              kind: 'image',
              ...await files.read(row.payload, await setting('maxImageBytes')),
            };
          }
          if (row.kind !== 'credential') {
            throw new Error('Unsupported hat record kind');
          }
          const secretKey = await credentialKey();
          try {
            const [version, iv, ciphertext, extra] = row.payload.split(':');
            if (
              version !== 'aes-gcm-v1' || !/^[a-f0-9]{24}$/.test(iv) ||
              !/^(?:[a-f0-9]{2}){16,}$/.test(ciphertext) || extra !== undefined
            ) {
              throw new Error('Invalid credential envelope');
            }
            const bytes = await crypto.subtle.decrypt(
              {
                name: 'AES-GCM',
                iv: decodeHex(iv),
                additionalData: aad(scope, key),
              },
              secretKey,
              decodeHex(ciphertext),
            );
            return { kind: 'credential', value: decoder.decode(bytes) };
          } catch {
            throw new Error('Cannot decrypt hat credential');
          }
        });
      },
      put(key: string, record: HatDataInput, input?: HatDataScope) {
        return serial(async () => {
          recordKey(key);
          const scope = owner(input);
          let payload: string;
          if (record.kind === 'data') {
            // Reject lossy/non-JSON inputs rather than quietly dropping values.
            const validate = (value: HatDataValue): void => {
              if (
                value === null || typeof value === 'string' ||
                typeof value === 'boolean'
              ) return;
              if (typeof value === 'number' && Number.isFinite(value)) return;
              if (Array.isArray(value)) {
                for (const v of value) validate(v);
                return;
              }
              if (
                value && typeof value === 'object' &&
                Object.getPrototypeOf(value) === Object.prototype
              ) {
                for (const v of Object.values(value)) validate(v);
                return;
              }
              throw new Error('Hat data must be JSON');
            };
            validate(record.value);
            payload = JSON.stringify(record.value);
          } else if (
            record.kind === 'credential' && typeof record.value === 'string'
          ) {
            const secretKey = await credentialKey();
            const iv = crypto.getRandomValues(new Uint8Array(12));
            const bytes = new Uint8Array(
              await crypto.subtle.encrypt(
                { name: 'AES-GCM', iv, additionalData: aad(scope, key) },
                secretKey,
                encoder.encode(record.value),
              ),
            );
            payload = `aes-gcm-v1:${encodeHex(iv)}:${encodeHex(bytes)}`;
          } else if (record.kind === 'image') {
            if (!files) {
              throw new Error('A data directory is required for hat images');
            }
            payload = await files.save(
              record.value,
              await setting('maxImageBytes'),
              await setting('maxImagePixels'),
            );
          } else throw new Error('Unsupported hat record kind');
          let previous;
          try {
            previous = await store.hatData.put({
              hat,
              ownerScope: scope,
              key,
              kind: record.kind,
              payload,
            });
          } catch (error) {
            await retire({ kind: record.kind, payload });
            throw error;
          }
          await retire(previous);
        });
      },
      remove(key: string, input?: HatDataScope) {
        return serial(async () => {
          recordKey(key);
          const previous = await store.hatData.remove(hat, owner(input), key);
          await retire(previous);
          return previous !== null;
        });
      },
      list(input?: HatDataScope) {
        return store.hatData.list(hat, owner(input));
      },
    });
  };
}
