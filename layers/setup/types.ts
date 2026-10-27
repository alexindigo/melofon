import type { PathfinderRequest } from '@pathfinder/pathfinder';

export type SetupRequest = PathfinderRequest<Record<string, string>>;
export interface SetupContext {
  miss?: unknown;
  state: { json: Record<string, unknown> };
  app: {
    publicAddress: {
      acceptsOrigin(request: Request, origin: string): Promise<boolean>;
    };
    state: { getTyped(key: string): Promise<unknown> };
    setup: {
      create(
        input: {
          code: string;
          username: string;
          password: string;
          displayName?: string;
        },
        address: string,
        completed: Promise<void>,
      ): Promise<unknown>;
    };
  };
}
