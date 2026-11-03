import type { CommandSource, Output, Outputs } from './player.ts';
import type { PreparationView } from './output-admission.ts';
import { isConnectionStrategy } from './connection-strategy.ts';

export class SpeakerError extends Error {
  override name = 'SpeakerError';
  constructor(
    public code:
      | 'not_found'
      | 'invalid_field'
      | 'unknown_field'
      | 'unsupported_protocol'
      | 'not_adopted'
      | 'persistence_failed',
    message: string,
  ) {
    super(message);
  }
}

function fields(input: unknown, allowed: string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new SpeakerError(
      'invalid_field',
      'Speaker configuration must be an object',
    );
  }
  if (Object.keys(input).some((key) => !allowed.includes(key))) {
    throw new SpeakerError(
      'unknown_field',
      'Unknown speaker configuration field',
    );
  }
  return input as Record<string, unknown>;
}

function strategy(value: unknown) {
  if (!isConnectionStrategy(value)) {
    throw new SpeakerError('invalid_field', 'Invalid connection strategy');
  }
  return value;
}

/** Public facts only. No profiles, transports, permits or lifecycle commands. */
export interface SpeakerAdapterView {
  preparation: PreparationView;
}

export interface SpeakerView {
  id: string;
  name: string;
  protocol: string;
  address?: string;
  port?: number;
  model?: string;
  selected: boolean;
  volume: number;
  connectionStrategy: Output['connectionStrategy'];
  adopted: boolean;
  discovered: boolean;
  state: SpeakerAdapterView;
}

/** One protocol-neutral boundary over control preferences and live facts.
 * Reading never acquires facts, starts a session or saves configuration. */
export function createSpeakers(deps: {
  outputs: Pick<
    Outputs,
    'list' | 'get' | 'lifetime' | 'adopt' | 'update' | 'forget'
  >;
  playback?: { pause(source?: CommandSource): void };
  adapterView(id: string): SpeakerAdapterView;
  registerAddress?(input: {
    host: string;
    name?: string;
    port?: number;
    connectionStrategy?: Output['connectionStrategy'];
  }, source?: CommandSource): Promise<Output | null>;
}) {
  const view = (row: Output): SpeakerView => ({
    id: row.id,
    name: row.name,
    protocol: row.type,
    ...(row.host === undefined ? {} : { address: row.host }),
    ...(row.port === undefined ? {} : { port: row.port }),
    ...(row.model === undefined ? {} : { model: row.model }),
    selected: row.selected,
    volume: row.volume,
    connectionStrategy: row.connectionStrategy,
    ...deps.outputs.lifetime(row.id),
    state: structuredClone(deps.adapterView(row.id)),
  });
  const requireRow = (id: string) => {
    const row = deps.outputs.get(id);
    if (!row) throw new SpeakerError('not_found', 'Speaker not found');
    return row;
  };
  const durable = async (operation: () => Promise<Output | null>) => {
    try {
      const row = await operation();
      if (!row) throw new SpeakerError('not_found', 'Speaker not found');
      return view(row);
    } catch (error) {
      if (error instanceof SpeakerError) throw error;
      throw new SpeakerError(
        'persistence_failed',
        'Speaker configuration could not be saved',
      );
    }
  };
  return {
    list(): SpeakerView[] {
      return deps.outputs.list().map(view);
    },
    get(id: string): SpeakerView | null {
      const row = deps.outputs.get(id);
      return row === null ? null : view(row);
    },
    async add(input: unknown, source?: CommandSource): Promise<SpeakerView> {
      const body = fields(input, [
        'protocol',
        'address',
        'port',
        'name',
        'connectionStrategy',
      ]);
      if (body.protocol !== 'AirPlay') {
        throw new SpeakerError(
          body.protocol === undefined
            ? 'invalid_field'
            : 'unsupported_protocol',
          'Unsupported speaker protocol',
        );
      }
      if (typeof body.address !== 'string' || !body.address.trim()) {
        throw new SpeakerError(
          'invalid_field',
          'Address must be a non-empty host',
        );
      }
      if (
        body.name !== undefined &&
        (typeof body.name !== 'string' || !body.name.trim())
      ) {
        throw new SpeakerError(
          'invalid_field',
          'Name must be a non-empty string',
        );
      }
      if (
        body.port !== undefined &&
        (typeof body.port !== 'number' || !Number.isInteger(body.port) ||
          body.port < 1 || body.port > 65535)
      ) {
        throw new SpeakerError(
          'invalid_field',
          'Port must be an integer from 1 to 65535',
        );
      }
      const connectionStrategy = body.connectionStrategy === undefined
        ? undefined
        : strategy(body.connectionStrategy);
      if (!deps.registerAddress) {
        throw new Error('Speaker address adapter unavailable');
      }
      return await durable(() =>
        deps.registerAddress!({
          host: body.address as string,
          ...(body.name === undefined
            ? {}
            : { name: (body.name as string).trim() }),
          ...(body.port === undefined ? {} : { port: body.port as number }),
          ...(connectionStrategy === undefined ? {} : { connectionStrategy }),
        }, source)
      );
    },
    async adopt(id: string): Promise<SpeakerView> {
      requireRow(id);
      return await durable(() => deps.outputs.adopt(id));
    },
    async forget(id: string, source?: CommandSource): Promise<void> {
      const row = requireRow(id);
      if (!deps.outputs.lifetime(id).adopted) {
        throw new SpeakerError(
          'not_adopted',
          'Discovered speakers cannot be forgotten; use ignore',
        );
      }
      const operation = deps.outputs.forget(id, source);
      if (
        row.selected && !deps.outputs.list().some((speaker) => speaker.selected)
      ) {
        deps.playback?.pause(source);
      }
      try {
        await operation;
      } catch {
        throw new SpeakerError(
          'persistence_failed',
          'Speaker configuration could not be removed',
        );
      }
    },
    async configure(
      id: string,
      input: unknown,
      source?: CommandSource,
    ): Promise<SpeakerView> {
      const body = fields(input, ['connectionStrategy']);
      const connectionStrategy = strategy(body.connectionStrategy);
      requireRow(id);
      const adopted = deps.outputs.lifetime(id).adopted;
      const row = deps.outputs.update(id, { connectionStrategy }, source)!;
      // Temporary edits stay temporary; saved edits await durable completion.
      return adopted ? await durable(() => deps.outputs.adopt(id)) : view(row);
    },
  };
}

export type Speakers = ReturnType<typeof createSpeakers>;
