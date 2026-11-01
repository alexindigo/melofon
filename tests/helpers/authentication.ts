import { createAuthentication } from '../../src/authentication.ts';
import { openStore } from '../../src/store/index.ts';
import { createState } from '../../src/state.ts';
import { seedFirstUser } from '../../src/users.ts';
import type { Notify } from '../../src/notify.ts';
import { restored } from './prepared.ts';

function config(dir: string) {
  return {
    listen: undefined,
    dataDir: dir,
    user: 'admin',
    password: 'password-admin',
    secret: 'test-secret',
    version: 'a3',
  };
}

export async function authFixture(notify?: Notify, storeDir?: string) {
  const dir = storeDir ?? await restored('auth', async (dir) => {
    const store = await openStore(dir);
    try {
      await seedFirstUser(store, config(dir));
    } finally {
      await store.close();
    }
  }, 'melofon-auth-');
  const cfg = config(dir);
  const store = await openStore(dir);
  await seedFirstUser(store, cfg);
  const state = createState(store, undefined, notify);
  let clock = 1800000000000;
  const auth = createAuthentication(store, cfg, state, () => clock, notify);
  const admin = (await store.users.credentials({ username: 'admin' }))!.user;
  return {
    dir,
    cfg,
    store,
    state,
    auth,
    notify,
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
      if (storeDir === undefined) await Deno.remove(dir, { recursive: true });
    },
  };
}
