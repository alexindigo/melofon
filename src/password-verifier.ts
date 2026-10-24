import type { Config } from './config.ts';
import type { Store } from './store/index.ts';
import { decryptPassword, encryptPassword } from './users.ts';
import { equalCredentials, passwordToken } from './password-crypto.ts';

export type PasswordProof = { password: string } | {
  token: string;
  salt: string;
};

/** The only password-checking boundary, shared by every protocol and re-proof. */
export function createPasswordVerifier(
  store: Store,
  cfg: Pick<Config, 'secret'>,
) {
  let dummy: Promise<string> | undefined;
  return async (
    identity: { username: string } | { id: string },
    proof: PasswordProof,
  ) => {
    dummy ??= encryptPassword(cfg.secret ?? '', crypto.randomUUID());
    const fallback = await dummy;
    const record = await store.users.credentials(identity);
    // Unknown names do the same lookup, AES decrypt and digest comparison as a
    // wrong password. No secret/credential material ever enters a SQL operation.
    const plaintext = await decryptPassword(
      cfg.secret ?? '',
      cfg.secret === undefined ? fallback : record?.passwordEnc ?? fallback,
    );
    const matches = 'password' in proof
      ? equalCredentials(proof.password, plaintext)
      : equalCredentials(
        proof.token.toLowerCase(),
        passwordToken(plaintext + proof.salt),
      );
    return matches && cfg.secret !== undefined && record !== null
      ? record
      : null;
  };
}
export type PasswordVerifier = ReturnType<typeof createPasswordVerifier>;
