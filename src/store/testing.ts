import { engineForTesting } from './engine.ts';
import type { Store } from './index.ts';

/** One statement per call. Comments and literals cannot hide a second one. */
function checkSql(sql: string): void {
  let first = true;
  let ended = false;
  for (let i = 0; i < sql.length;) {
    if (/\s/.test(sql[i])) {
      i++;
      continue;
    }
    if (sql.startsWith('--', i)) {
      i += 2;
      while (i < sql.length && !/[\r\n]/.test(sql[i])) i++;
      continue;
    }
    if (sql.startsWith('/*', i)) {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth) {
        if (sql.startsWith('/*', i)) {
          depth++;
          i += 2;
        } else if (sql.startsWith('*/', i)) {
          depth--;
          i += 2;
        } else i++;
      }
      if (depth) throw new Error('Unterminated raw SQL comment');
      continue;
    }
    if (sql[i] === ';') {
      ended = true;
      i++;
      continue;
    }
    if (ended) throw new Error('rawSql accepts only one statement');
    if (first) {
      const word = sql.slice(i).match(/^[A-Za-z_]+/)?.[0].toUpperCase();
      // Include DuckDB transaction aliases: none may escape this call's slot.
      if (
        !word ||
        /^(BEGIN|START|COMMIT|END|ROLLBACK|ABORT|CHECKPOINT|FORCE|ATTACH|DETACH|CALL|PREPARE|EXECUTE)$/
          .test(word)
      ) throw new Error(`rawSql rejects ${word ?? 'unknown'} statements`);
      first = false;
    }
    const escaped = /[Ee]/.test(sql[i]) && sql[i + 1] === "'";
    if (escaped) i++;
    const quote = sql[i];
    if (quote === "'" || quote === '"') {
      i++;
      let closed = false;
      while (i < sql.length) {
        if (escaped && sql[i] === '\\') {
          i += 2;
        } else if (sql[i++] === quote) {
          if (sql[i] === quote) i++;
          else {
            closed = true;
            break;
          }
        }
      }
      if (!closed) throw new Error('Unterminated raw SQL quote');
    } else if (quote === '$') {
      const delimiter = sql.slice(i).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)
        ?.[0];
      if (!delimiter) throw new Error('Unsupported raw SQL dollar token');
      const end = sql.indexOf(delimiter, i + delimiter.length);
      if (end < 0) throw new Error('Unterminated raw SQL dollar quote');
      i = end + delimiter.length;
    } else i++;
  }
}

/** Test-only fixture seeding and driver-faithful rows, through the store queue. */
export function rawSql(store: Store) {
  const engine = engineForTesting(store);
  return {
    async run(sql: string): Promise<void> {
      checkSql(sql);
      await engine.exclusive((q) => q.run(sql));
    },
    async all<T = Record<string, unknown>>(sql: string): Promise<T[]> {
      checkSql(sql);
      return await engine.exclusive((q) => q.rawAll<T>(sql));
    },
  };
}
