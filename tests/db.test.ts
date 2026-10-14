// tests/db.test.ts — openDb creates the file + schema; seedFirstUser inserts
// once, encrypts the password, never overwrites existing users.
import { assert, assertEquals, assertNotEquals } from '@std/assert';
import { instrumentConn, openDb } from '../src/db.ts';
import type * as duckdb from '@duckdb/node-api';
import { captureLogs, parseLogfmt } from './helpers/logging.ts';
import {
  decryptPassword,
  encryptPassword,
  seedFirstUser,
} from '../src/users.ts';

async function tmpdir(): Promise<string> {
  return await Deno.makeTempDir({ prefix: 'melofon-db-' });
}

Deno.test('openDb creates melofon.duckdb with the M0 tables', async () => {
  const dir = await tmpdir();
  const db = await openDb(dir);
  try {
    const stat = await Deno.stat(`${dir}/melofon.duckdb`);
    assert(stat.isFile);
    const res = await db.conn.runAndReadAll(
      "SELECT table_name FROM information_schema.tables WHERE table_name IN ('users', 'artists', 'albums', 'files')",
    );
    assertEquals(res.getRowObjects().length, 4);
  } finally {
    db.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('openDb creates the M2 user-state tables', async () => {
  const dir = await tmpdir();
  const db = await openDb(dir);
  try {
    const res = await db.conn.runAndReadAll(
      "SELECT table_name FROM information_schema.tables WHERE table_name IN ('listens', 'stars', 'star_events', 'ratings', 'playlists', 'playlist_tracks', 'play_queues')",
    );
    assertEquals(res.getRowObjects().length, 7);
  } finally {
    db.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('seedFirstUser inserts one row with an encrypted password', async () => {
  const dir = await tmpdir();
  const db = await openDb(dir);
  try {
    await seedFirstUser(db, {
      listen: undefined,
      dataDir: dir,
      user: 'admin',
      password: 'test',
      secret: 's3cret',
    });
    const res = await db.conn.runAndReadAll(
      'SELECT name, password_enc FROM users',
    );
    const rows = res.getRowObjects() as {
      name: string;
      password_enc: string;
    }[];
    assertEquals(rows.length, 1);
    assertEquals(rows[0].name, 'admin');
    assertNotEquals(rows[0].password_enc, 'test');
    assertEquals(await decryptPassword('s3cret', rows[0].password_enc), 'test');
  } finally {
    db.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('seedFirstUser does not overwrite existing users', async () => {
  const dir = await tmpdir();
  const db = await openDb(dir);
  try {
    const cfg = {
      listen: undefined,
      dataDir: dir,
      user: 'admin',
      password: 'first',
      secret: 's3cret',
    };
    await seedFirstUser(db, cfg);
    await seedFirstUser(db, { ...cfg, password: 'second' });
    const res = await db.conn.runAndReadAll(
      'SELECT count(*) AS n FROM users',
    );
    const rows = res.getRowObjects() as { n: bigint | number }[];
    assertEquals(Number(rows[0].n), 1);
  } finally {
    db.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('query spans log begin/end and qinflight on overlap', async () => {
  const { log, lines } = captureLogs();
  try {
    let release!: () => void;
    const gate = new Promise<unknown>((
      resolve,
    ) => (release = () => resolve(null)));
    const fake = {
      run: (sql: string) => sql.includes('SLOW') ? gate : Promise.resolve(null),
      runAndReadAll: (_sql: string) => Promise.resolve({ rows: [] }),
    };
    instrumentConn(fake as unknown as duckdb.DuckDBConnection, log);
    const slow = fake.run('SELECT SLOW');
    const fast = fake.run('SELECT 1');
    release();
    await Promise.all([slow, fast]);
    assertEquals(lines.length, 5);
    const records = lines.map(parseLogfmt);
    assertEquals(records.map((r) => r.event), [
      'db_begin',
      'db_overlap',
      'db_begin',
      'db_end',
      'db_end',
    ]);
    assertEquals(records[0].operation, 'SELECT');
    assertEquals(records[0].qinflight, '1');
    assertEquals(records[1].qinflight, '2');
    assertEquals(records[2].qinflight, '2');
    assert(records[3].waitMs !== undefined && records[4].waitMs !== undefined);
  } finally {
    await log.flush();
  }
});

Deno.test('encryptPassword round-trips and is salted per call', async () => {
  const a = await encryptPassword('k', 'pw');
  const b = await encryptPassword('k', 'pw');
  assertNotEquals(a, b);
  assertEquals(await decryptPassword('k', a), 'pw');
  assertEquals(await decryptPassword('k', b), 'pw');
});
