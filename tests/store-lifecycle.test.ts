import { assertEquals, assertRejects, assertStrictEquals } from '@std/assert';
import { type DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';
import { engineForTesting } from '../src/store/engine.ts';
import { openStore } from '../src/store/index.ts';
import type { Candidate } from '../src/store/candidates.ts';

interface NativeOwner {
  instance: DuckDBInstance;
  connect: () => Promise<DuckDBConnection>;
  connection?: DuckDBConnection;
  closed: string[];
}

// Retain the real native owners, so GC cannot decide the outcome. Observe the
// existing driver boundary without exposing native handles on the Store API.
async function observeOwners(
  fn: (owners: NativeOwner[]) => Promise<void>,
  configure: (owner: NativeOwner) => void = () => {},
) {
  const create = DuckDBInstance.create;
  const owners: NativeOwner[] = [];
  DuckDBInstance.create = async (...args) => {
    const instance = await create(...args);
    const owner: NativeOwner = {
      instance,
      connect: instance.connect.bind(instance),
      closed: [],
    };
    owners.push(owner);
    const closeInstance = instance.closeSync.bind(instance);
    instance.closeSync = () => {
      closeInstance();
      owner.closed.push('instance');
    };
    instance.connect = async () => {
      const connection = await owner.connect();
      owner.connection = connection;
      const closeConnection = connection.closeSync.bind(connection);
      connection.closeSync = () => {
        closeConnection();
        owner.closed.push('connection');
      };
      return connection;
    };
    configure(owner);
    return instance;
  };
  try {
    await fn(owners);
  } finally {
    DuckDBInstance.create = create;
    for (const owner of owners) {
      if (!owner.closed.includes('connection')) owner.connection?.closeSync();
      if (!owner.closed.includes('instance')) owner.instance.closeSync();
    }
  }
}

async function assertNativeClosed(owner: NativeOwner) {
  await assertRejects(async () => {
    // The unmodified driver's connect must reject after native close. Close an
    // unexpected successful connection as well, so a red run leaks no handle.
    const connection = await owner.connect();
    connection.closeSync();
  }, Error);
}

Deno.test('Store closes native owners synchronously and keeps lyrics, artist candidates and state across three opens', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'store-lifecycle-' });
  let passed = false;
  try {
    await observeOwners(async (owners) => {
      let store = await openStore(dir);
      const candidates: Candidate[] = [];
      try {
        for (const generation of [1, 2]) {
          for (const candidate of candidates) {
            assertEquals(await store.candidates.byId(candidate.id), candidate);
          }
          if (generation === 2) {
            assertEquals(await store.state.get('first'), 'kept');
          }
          candidates.push(
            ...await store.candidates.addCandidates([{
              entityType: 'song',
              entityId: `song-${generation}`,
              kind: 'lyrics',
              source: 'local',
              confidence: null,
              imageHash: `lyrics-${generation}`,
              imageExt: 'lyrics',
              libraryId: 'library',
              origin: `song-${generation}`,
              details: {
                lyrics: {
                  entry: {
                    language: 'xxx',
                    synced: false,
                    lines: [{ text: `Words ${generation}` }],
                  },
                },
              },
            }, {
              entityType: 'artist',
              entityId: `artist-${generation}`,
              kind: 'cover',
              source: 'fixture',
              confidence: 'strong',
              imageHash: `photo-${generation}`,
              imageExt: 'jpg',
              libraryId: null,
              origin: `https://fixture/photo-${generation}`,
            }]),
          );
          await store.state.set(generation === 1 ? 'first' : 'second', 'kept');
          const closing = store.close();
          assertStrictEquals(store.close(), closing);
          assertEquals(owners[generation - 1].closed, [
            'connection',
            'instance',
          ]);
          await closing;
          await assertNativeClosed(owners[generation - 1]);
          await assertRejects(
            () => store.state.set('late', 'lost'),
            Error,
            'Store is closed',
          );
          store = await openStore(dir);
        }
        assertEquals(await store.state.list(), {
          first: 'kept',
          second: 'kept',
        });
        for (const candidate of candidates) {
          assertEquals(await store.candidates.byId(candidate.id), candidate);
        }
      } finally {
        await store.close();
      }
      assertEquals(owners.length, 3);
      for (const owner of owners) {
        assertEquals(owner.closed, ['connection', 'instance']);
        await assertNativeClosed(owner);
      }
    });
    passed = true;
  } finally {
    if (passed) await Deno.remove(dir, { recursive: true });
    else console.error('RETAIN_FAILED_LIFECYCLE', dir);
  }
});

Deno.test('Store drains queued writes before closing both owners and preserves the inside-slot guard', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'store-drain-' });
  try {
    await observeOwners(async (owners) => {
      const store = await openStore(dir);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => release = resolve);
      try {
        const first = engineForTesting(store).exclusive(async () => {
          await assertRejects(
            () => store.close(),
            Error,
            'inside an exclusive slot',
          );
          await gate;
        });
        const write = store.state.set('drained', 'committed');
        const closing = store.close();
        assertStrictEquals(store.close(), closing);
        assertEquals(owners[0].closed, []);
        await assertRejects(() => store.ping(), Error, 'Store is closed');
        release();
        await Promise.all([first, write, closing]);
        assertEquals(owners[0].closed, ['connection', 'instance']);
        await assertNativeClosed(owners[0]);
        const reopened = await openStore(dir);
        try {
          assertEquals(await reopened.state.get('drained'), 'committed');
        } finally {
          await reopened.close();
        }
      } finally {
        release();
        await store.close();
      }
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('Store failed opens release native owners at connection, schema and domain initialization', async () => {
  for (const phase of ['connection', 'schema', 'domain']) {
    const dir = await Deno.makeTempDir({ prefix: `store-open-${phase}-` });
    const failure = new Error(`injected ${phase} failure`);
    try {
      await observeOwners(async (owners) => {
        assertStrictEquals(await assertRejects(() => openStore(dir)), failure);
        assertEquals(owners.length, 1);
        assertEquals(
          owners[0].closed,
          phase === 'connection' ? ['instance'] : ['connection', 'instance'],
        );
        await assertNativeClosed(owners[0]);
      }, (owner) => {
        const connect = owner.instance.connect.bind(owner.instance);
        owner.instance.connect = async () => {
          if (phase === 'connection') throw failure;
          const connection = await connect();
          const run = connection.run.bind(connection);
          connection.run = (sql, ...args) => {
            if (phase === 'schema' || sql.startsWith('UPDATE lookup_jobs')) {
              return Promise.reject(failure);
            }
            return run(sql, ...args);
          };
          return connection;
        };
      });
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  }
});
