import { createAuthentication } from '../../src/authentication.ts';
import { openStore } from '../../src/store/index.ts';
import { createState } from '../../src/state.ts';
import { seedFirstUser } from '../../src/users.ts';
import type { Notify } from '../../src/notify.ts';

export async function authFixture(notify?: Notify) {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-auth-' });
  const cfg = {
    listen: undefined,
    dataDir: dir,
    user: 'admin',
    password: 'password-admin',
    secret: 'test-secret',
    version: 'a3',
  };
  const store = await openStore(dir);
  await seedFirstUser(store, cfg);
  const state = createState(store, undefined, notify);
  let clock = 1800000000000;
  const auth = createAuthentication(store, cfg, state, () => clock);
  const admin = (await store.users.credentials({ username: 'admin' }))!.user;
  return {
    dir,
    cfg,
    store,
    state,
    auth,
    admin,
    now: () => clock,
    advance: (ms: number) => {
      clock += ms;
    },
    signIn: (
      username = 'admin',
      password = 'password-admin',
      clientAddress = 'client-a',
    ) =>
      auth.signIn({
        username,
        password,
        clientAddress,
        deviceName: 'Device',
        userAgent: 'a3-test',
      }),
    async close() {
      await store.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}
