// Structural ports only: hats never import core or its store.
import type { PathfinderRequest } from '@pathfinder/pathfinder';

export type HatRequest = PathfinderRequest<Record<string, string>>;
export interface User {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  role: 'admin' | 'user';
  createdAt: string;
  lastLoginAt: string | null;
  lastAccessAt: string | null;
}
export interface Session {
  id: string;
  userId: string;
  deviceName: string;
  userAgent: string;
  createdAt: string;
  lastUsedAt: string;
}
export interface Hat {
  name: string;
  state: 'found' | 'loaded' | 'active' | 'failed';
  active: boolean;
  pendingRestart: boolean;
  setup: boolean;
  errors: { phase: string; code: string; message: string; file?: string }[];
  mounts: { folder: string; prefix: string }[];
  ports: { claimed: number[]; actual: number[] };
  settings: string[];
}
export interface HatContext {
  app: {
    settings: {
      describe(caller: string, key?: string): Promise<Setting[]>;
      change(caller: string, changes: unknown): Promise<Setting[]>;
    };
    hats: {
      list(caller: string): Promise<{ hats: Hat[]; restartRequired: boolean }>;
      rescan(
        caller: string,
      ): Promise<{ hats: Hat[]; restartRequired: boolean }>;
      activate(caller: string, name: string): Promise<Hat>;
      deactivate(caller: string, name: string): Promise<Hat>;
    };
    state: { getTyped(key: string): Promise<unknown> };
    signIn(input: {
      username: string;
      password: string;
      clientAddress: string;
      deviceName: string;
      userAgent: string;
    }): Promise<{ session: Session; key: string }>;
    sessions: {
      authenticate(
        key: string,
      ): Promise<{ user: User; sessionId: string } | null>;
      list(caller: string, target?: string): Promise<Session[]>;
      revoke(caller: string, id: string): Promise<void>;
      revokeAll(caller: string, target?: string): Promise<void>;
    };
    users: {
      get(caller: string, target: string): Promise<User>;
      list(caller: string): Promise<User[]>;
      create(caller: string, input: {
        username: string;
        password: string;
        role: 'admin' | 'user';
        displayName?: string;
        email?: string;
      }): Promise<User>;
      update(caller: string, target: string, input: {
        username?: string;
        displayName?: string | null;
        email?: string | null;
        role?: 'admin' | 'user';
      }): Promise<User>;
      setPassword(
        caller: string,
        target: string,
        input: { current?: string; new: string },
      ): Promise<void>;
      noteAccess(id: string): Promise<void>;
    };
  };
  state: {
    user: User;
    sessionId: string;
    json: Record<string, unknown>;
  };
  miss?: unknown;
}

export interface Setting {
  key: string;
  owner: string;
  category: string;
  schema: Record<string, unknown>;
  default?: unknown;
  value?: unknown;
  source: 'stored' | 'default';
  revision: number;
  writeOnly: boolean;
  isSet?: boolean;
}
