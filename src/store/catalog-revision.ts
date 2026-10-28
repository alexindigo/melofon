// Sole SQL writer of the internal, keep-on-rescan catalog revision. Helpers
// share the caller's slot/transaction; they never open a public store operation.
import type { Queries } from './engine.ts';

export async function initializeCatalogRevision(q: Queries): Promise<void> {
  await q.run(`INSERT INTO catalog_revision (id, epoch, revision)
    SELECT 1, uuid()::VARCHAR, 0
    WHERE NOT EXISTS (SELECT 1 FROM catalog_revision WHERE id = 1)`);
}

export async function advanceCatalogRevision(q: Queries): Promise<void> {
  await q.run(
    'UPDATE catalog_revision SET revision = revision + 1 WHERE id = 1',
  );
}

export async function catalogRevision(q: Queries): Promise<string> {
  const [row] = await q.all<{ revision: string }>(
    "SELECT epoch || ':' || revision::VARCHAR AS revision FROM catalog_revision WHERE id = 1",
  );
  return row.revision;
}
