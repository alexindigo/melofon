// GET /_/last-command — read the same core owners used by hats and boots.
import { projectCommandProvenance } from '../../src/command-provenance.ts';
import type { LastCommand, OutputCommand } from '../../src/player.ts';

export default function (
  _request: unknown,
  context: {
    app: {
      playback: { lastCommand(): LastCommand | null };
      outputs: { lastCommand(): OutputCommand | null };
    };
  },
) {
  const playback = context.app.playback.lastCommand();
  const outputs = context.app.outputs.lastCommand();
  return Response.json(projectCommandProvenance(playback, outputs), {
    headers: { 'Cache-Control': 'no-store' },
  });
}
