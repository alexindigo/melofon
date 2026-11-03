import type { Output, Outputs } from './player.ts';
import type { PreparationView } from './output-admission.ts';

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
  state: SpeakerAdapterView;
}

/** One protocol-neutral read boundary over control preferences and live facts.
 * Reading never acquires facts, starts a session or saves configuration. */
export function createSpeakers(deps: {
  outputs: Pick<Outputs, 'list' | 'get'>;
  adapterView(id: string): SpeakerAdapterView;
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
    state: structuredClone(deps.adapterView(row.id)),
  });
  return {
    list(): SpeakerView[] {
      return deps.outputs.list().map(view);
    },
    get(id: string): SpeakerView | null {
      const row = deps.outputs.get(id);
      return row === null ? null : view(row);
    },
  };
}

export type Speakers = ReturnType<typeof createSpeakers>;
