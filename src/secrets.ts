import { decodeHex, encodeHex } from '@std/encoding/hex';
import { appLogger, type Logger } from './logging.ts';

export type SpeakerCredentialKind = 'password' | 'pairing-key';
export interface SecretBinding {
  speakerId: string;
  kind: SpeakerCredentialKind;
}

export class SecretError extends Error {
  override name = 'SecretError';
  constructor(
    public code:
      | 'secret_missing'
      | 'secret_unavailable'
      | 'invalid_ciphertext'
      | 'unsupported_ciphertext'
      | 'authentication_failed',
  ) {
    super(
      {
        secret_missing:
          'MELOFON_SECRET is required for saved speaker credentials',
        secret_unavailable: 'Speaker credential encryption is unavailable',
        invalid_ciphertext: 'Saved speaker credential is malformed',
        unsupported_ciphertext:
          'Saved speaker credential version is unsupported',
        authentication_failed:
          'Saved speaker credential could not be authenticated; restore MELOFON_SECRET or re-enter the password/pair again',
      }[code],
    );
  }
}

const VERSION = '1';
const KEY_ID = 'speaker-credentials-v1';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

/** Deployment-root encryption, separate from existing user password ciphertext.
 * The key is nonextractable. No root/key generation or plaintext fallback. */
export function createSecrets(
  root: string | undefined,
  logger: Pick<Logger, 'registerSecrets'> = appLogger(),
) {
  logger.registerSecrets([root]);
  let derived: Promise<CryptoKey> | undefined;
  const key = (): Promise<CryptoKey> => {
    if (!root) throw new SecretError('secret_missing');
    return derived ??= (async () => {
      try {
        const base = await crypto.subtle.importKey(
          'raw',
          encoder.encode(root),
          'HKDF',
          false,
          ['deriveKey'],
        );
        return await crypto.subtle.deriveKey(
          {
            name: 'HKDF',
            hash: 'SHA-256',
            salt: encoder.encode('melofon/secrets/hkdf/v1'),
            info: encoder.encode(`melofon/${KEY_ID}/AES-256-GCM`),
          },
          base,
          { name: 'AES-GCM', length: 256 },
          false,
          ['encrypt', 'decrypt'],
        );
      } catch {
        throw new SecretError('secret_unavailable');
      }
    })();
  };
  const additionalData = (binding: SecretBinding) =>
    encoder.encode(JSON.stringify([
      'melofon/speaker-credentials',
      VERSION,
      KEY_ID,
      binding.speakerId,
      binding.kind,
    ]));
  return {
    register(value: string) {
      logger.registerSecrets([value]);
    },
    async encrypt(binding: SecretBinding, plaintext: string): Promise<string> {
      logger.registerSecrets([plaintext]);
      const encryptionKey = await key();
      try {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ciphertext = await crypto.subtle.encrypt(
          {
            name: 'AES-GCM',
            iv,
            additionalData: additionalData(binding),
            tagLength: 128,
          },
          encryptionKey,
          encoder.encode(plaintext),
        );
        return `${VERSION}:${KEY_ID}:${encodeHex(iv)}:${
          encodeHex(new Uint8Array(ciphertext))
        }`;
      } catch {
        throw new SecretError('secret_unavailable');
      }
    },
    async decrypt(binding: SecretBinding, stored: string): Promise<string> {
      const decryptionKey = await key();
      const parts = stored.split(':');
      if (parts.length !== 4) throw new SecretError('invalid_ciphertext');
      const [version, keyId, iv, ciphertext] = parts;
      if (version !== VERSION || keyId !== KEY_ID) {
        throw new SecretError('unsupported_ciphertext');
      }
      if (
        !/^[0-9a-f]{24}$/.test(iv) || !/^(?:[0-9a-f]{2}){16,}$/.test(ciphertext)
      ) {
        throw new SecretError('invalid_ciphertext');
      }
      try {
        const plaintext = decoder.decode(
          await crypto.subtle.decrypt(
            {
              name: 'AES-GCM',
              iv: decodeHex(iv),
              additionalData: additionalData(binding),
              tagLength: 128,
            },
            decryptionKey,
            decodeHex(ciphertext),
          ),
        );
        logger.registerSecrets([plaintext]);
        return plaintext;
      } catch {
        throw new SecretError('authentication_failed');
      }
    },
  };
}

export type Secrets = ReturnType<typeof createSecrets>;
