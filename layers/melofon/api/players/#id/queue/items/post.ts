import type {
  HatContext,
  HatRequest,
  PlayerQueueReference,
} from '#melofon/types.ts';
import { core, fail } from '#melofon/errors.ts';
import { fields } from '#melofon/input.ts';
import { source } from '#melofon/libraries.ts';
import { playerId, queueEntryPayload } from '#melofon/players.ts';
import { queueDestination } from '#melofon/queue-edit.ts';

function reference(value: unknown): PlayerQueueReference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(400, 'invalid_field', 'Invalid queue reference');
  }
  const row = value as Record<string, unknown>;
  const keys = row.kind === 'url'
    ? ['kind', 'url']
    : row.kind === 'folder'
    ? ['kind', 'libraryId', 'path']
    : ['kind', 'id'];
  if (Object.keys(row).some((key) => !keys.includes(key))) {
    fail(400, 'unknown_field', 'Unknown reference field');
  }
  if (row.kind === 'url' && typeof row.url === 'string' && row.url) {
    return { kind: row.kind, url: row.url };
  }
  if (
    row.kind === 'folder' && typeof row.libraryId === 'string' &&
    row.libraryId && typeof row.path === 'string'
  ) {
    return { kind: row.kind, libraryId: row.libraryId, path: row.path };
  }
  if (
    (row.kind === 'song' || row.kind === 'album' || row.kind === 'artist' ||
      row.kind === 'playlist' || row.kind === 'station') &&
    typeof row.id === 'string' && row.id
  ) {
    return { kind: row.kind, id: row.id };
  }
  fail(400, 'invalid_field', 'Invalid queue reference');
}

export default async function (request: HatRequest, context: HatContext) {
  const body = fields(context, [
    'references',
    'where',
    'clear',
    'startPlaying',
  ]);
  if (!Array.isArray(body.references) || !body.references.length) {
    fail(400, 'invalid_field', 'references must be a nonempty array');
  }
  const references = body.references.map(reference);
  for (const key of ['clear', 'startPlaying']) {
    if (body[key] !== undefined && typeof body[key] !== 'boolean') {
      fail(400, 'invalid_field', `${key} must be a boolean`);
    }
  }
  const where = queueDestination(body.where);
  return await core(async () => {
    const playback = context.app.players.get(playerId(request.params.id));
    const added = await playback.queueAddReferences(references, {
      where,
      clear: body.clear as boolean | undefined,
      startPlaying: body.startPlaying as boolean | undefined,
    }, source(request, context));
    const queue = playback.queueView();
    const positions = new Map(
      queue.items.map((entry, index) => [entry.id, index]),
    );
    return Response.json({
      version: queue.version,
      count: added.length,
      items: added.map((entry) =>
        queueEntryPayload(entry, positions.get(entry.id)!)
      ),
    }, { headers: { 'Cache-Control': 'no-store' } });
  });
}
