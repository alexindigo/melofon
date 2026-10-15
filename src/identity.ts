// Core-only read side of the retained identity index. The scan owns all writes.
import type { Db } from './db.ts';

export interface DuplicateGroup {
  fingerprint: string;
  files: { id: string; libraryId: string; relPath: string }[];
}

export interface FileEvent {
  seq: number;
  occurredAtMs: number;
  kind: 'linked' | 'ambiguous' | 'audio_changed';
  fileId: string;
  fingerprint: string | null;
  fromLibraryId: string | null;
  fromPath: string | null;
  toLibraryId: string | null;
  toPath: string | null;
  candidates: string[];
}

export interface Identity {
  duplicates(): Promise<DuplicateGroup[]>;
  events(opts: { limit: number }): Promise<FileEvent[]>;
  /** Epoch milliseconds, including identities currently absent from the catalog. */
  firstSeen(ids: string[]): Promise<Record<string, number>>;
}

function esc(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function createIdentity(db: Db): Identity {
  return {
    async duplicates() {
      const res = await db.conn.runAndReadAll(`
        SELECT id, library_id, rel_path, fingerprint FROM file_identity
        WHERE present AND fingerprint IN (
          SELECT fingerprint FROM file_identity
          WHERE present AND fingerprint IS NOT NULL
          GROUP BY fingerprint HAVING COUNT(*) > 1
        ) ORDER BY fingerprint, rel_path, library_id, id`);
      const groups: DuplicateGroup[] = [];
      for (
        const row of res.getRowObjects() as {
          id: string;
          library_id: string;
          rel_path: string;
          fingerprint: string;
        }[]
      ) {
        let group = groups[groups.length - 1];
        if (group?.fingerprint !== row.fingerprint) {
          group = { fingerprint: row.fingerprint, files: [] };
          groups.push(group);
        }
        group.files.push({
          id: row.id,
          libraryId: row.library_id,
          relPath: row.rel_path,
        });
      }
      return groups;
    },

    async events({ limit }) {
      if (!Number.isSafeInteger(limit) || limit < 0) {
        throw new RangeError('invalid event limit');
      }
      const res = await db.conn.runAndReadAll(`
        SELECT seq, epoch_ms(occurred_at)::BIGINT AS at_ms, kind, file_id,
               fingerprint, from_library_id, from_path, to_library_id, to_path,
               candidates FROM file_events ORDER BY seq DESC LIMIT ${limit}`);
      return (res.getRowObjects() as unknown as {
        seq: bigint;
        at_ms: bigint;
        kind: FileEvent['kind'];
        file_id: string;
        fingerprint: string | null;
        from_library_id: string | null;
        from_path: string | null;
        to_library_id: string | null;
        to_path: string | null;
        candidates: { items: string[] } | null;
      }[]).map((row) => ({
        seq: Number(row.seq),
        occurredAtMs: Number(row.at_ms),
        kind: row.kind,
        fileId: row.file_id,
        fingerprint: row.fingerprint,
        fromLibraryId: row.from_library_id,
        fromPath: row.from_path,
        toLibraryId: row.to_library_id,
        toPath: row.to_path,
        candidates: row.candidates?.items ?? [],
      }));
    },

    async firstSeen(ids) {
      if (ids.length === 0) return {};
      const res = await db.conn.runAndReadAll(`
        SELECT id, epoch_ms(first_seen_at)::BIGINT AS at_ms FROM file_identity
        WHERE id IN (${[...new Set(ids)].map(esc).join(', ')})`);
      const out: Record<string, number> = {};
      for (
        const row of res.getRowObjects() as { id: string; at_ms: bigint }[]
      ) out[row.id] = Number(row.at_ms);
      return out;
    },
  };
}
