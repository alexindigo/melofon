// The loader consumes this factory; hats receive only their scoped public port.
import type { Hats, HatView } from './hats.ts';
import type { Store } from './store/index.ts';

export class HatServiceError extends Error {
  override name = 'HatServiceError';
  constructor(
    readonly code:
      | 'forbidden'
      | 'not_found'
      | 'hat_failed'
      | 'hat_reserved'
      | 'hat_self'
      | 'activation_failed',
    message: string,
  ) {
    super(message);
  }
}

export interface HatService {
  list(caller: string): Promise<{ hats: HatView[]; restartRequired: boolean }>;
  rescan(
    caller: string,
  ): Promise<{ hats: HatView[]; restartRequired: boolean }>;
  activate(caller: string, name: string): Promise<HatView>;
  deactivate(caller: string, name: string): Promise<HatView>;
}
export type HatServices = (name: string) => HatService;

export function createHatServices(
  store: Pick<Store, 'users'>,
  registry: () => Hats,
): HatServices {
  async function admin(caller: string) {
    if ((await store.users.byId(caller))?.role !== 'admin') {
      throw new HatServiceError('forbidden', 'Forbidden');
    }
  }
  function view() {
    const hats = registry();
    return { hats: hats.list(), restartRequired: hats.restartRequired };
  }
  function target(name: string) {
    const hat = registry().list().find((hat) => hat.name === name);
    if (!hat) throw new HatServiceError('not_found', 'Not found');
    if (hat.state === 'failed') {
      throw new HatServiceError('hat_failed', `Hat failed: ${name}`);
    }
    if (hat.setup) {
      throw new HatServiceError(
        'hat_reserved',
        `Setup hat is reserved: ${name}`,
      );
    }
  }
  return (ownName) =>
    Object.freeze<HatService>({
      async list(caller) {
        await admin(caller);
        return view();
      },
      async rescan(caller) {
        await admin(caller);
        await registry().rescan();
        return view();
      },
      async activate(caller, name) {
        await admin(caller);
        target(name);
        try {
          return await registry().activate(name);
        } catch (error) {
          // Deno.serve bind failures are public conflicts; storage/programming
          // failures remain unexpected errors, never exposed as an HTTP message.
          if (
            error instanceof Deno.errors.AddrInUse ||
            error instanceof Deno.errors.AddrNotAvailable ||
            error instanceof Deno.errors.PermissionDenied
          ) throw new HatServiceError('activation_failed', error.message);
          throw error;
        }
      },
      async deactivate(caller, name) {
        await admin(caller);
        if (name === ownName) {
          throw new HatServiceError(
            'hat_self',
            'Cannot deactivate the calling hat',
          );
        }
        target(name);
        return registry().deactivate(name);
      },
    });
}
