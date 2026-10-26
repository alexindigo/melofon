import { assertEquals } from '@std/assert';
import { apiFixture } from './helpers/api.ts';
import { createOutputs, type Outputs } from '../src/player.ts';
import {
  CONNECTION_STRATEGY_DEFAULT_KEY as key,
  DEFAULT_CONNECTION_STRATEGY,
} from '../src/connection-strategy.ts';
import type { Setting } from '../layers/melofon/types.ts';

const base = '/api/v1/admin/settings';
const registration = (id: string) => ({
  id,
  name: id,
  type: 'AirPlay',
  host: '192.0.2.200',
  selected: false,
  volume: 100,
});

for (const mode of ['cookie', 'bearer'] as const) {
  Deno.test(`API settings: ${mode} strategy default stays declared through change, reset and reopen`, async () => {
    const dir = await Deno.makeTempDir({ prefix: 'melofon-api-strategy-' });
    let outputs: Outputs;
    const open = () =>
      apiFixture({
        storeDir: dir,
        services: async (f) => {
          outputs = createOutputs({ state: f.state });
          await outputs.ready();
          return { outputs };
        },
      });
    let f: Awaited<ReturnType<typeof open>> | undefined;
    try {
      f = await open();
      const { credential } = await f.login(mode);
      const read = async () => {
        const response = await f!.get(base, credential, { Origin: f!.origin });
        assertEquals(response.status, 200, await response.clone().text());
        return ((await response.json()).settings as Setting[]).find((s) =>
          s.key === key
        )!;
      };
      const fresh = await read();
      assertEquals(
        [fresh.source, fresh.value, fresh.default, fresh.revision],
        [
          'default',
          DEFAULT_CONNECTION_STRATEGY,
          DEFAULT_CONNECTION_STRATEGY,
          0,
        ],
      );
      assertEquals(await f.state.get(key), null);
      outputs!.register(registration('fresh'));
      assertEquals(
        outputs!.get('fresh')?.connectionStrategy,
        DEFAULT_CONNECTION_STRATEGY,
      );

      const changed = await f.json(base, 'PATCH', {
        changes: [{ key, value: 'owntone', revision: fresh.revision }],
      }, credential);
      assertEquals(changed.status, 200, await changed.clone().text());
      const stored = (await changed.json()).settings[0];
      assertEquals([stored.source, stored.value, stored.revision], [
        'stored',
        'owntone',
        1,
      ]);
      assertEquals(await read(), stored);
      assertEquals(await f.state.get(key), 'owntone');
      outputs!.register(registration('changed'));
      assertEquals(outputs!.get('changed')?.connectionStrategy, 'owntone');

      const reset = await f.json(base, 'PATCH', {
        changes: [{ key, reset: true, revision: stored.revision }],
      }, credential);
      assertEquals(reset.status, 200, await reset.clone().text());
      const fallback = (await reset.json()).settings[0];
      assertEquals([fallback.source, fallback.value, fallback.revision], [
        'default',
        DEFAULT_CONNECTION_STRATEGY,
        2,
      ]);
      assertEquals(await read(), fallback);
      assertEquals(await f.state.get(key), null);
      outputs!.register(registration('reset'));
      assertEquals(
        outputs!.get('reset')?.connectionStrategy,
        DEFAULT_CONNECTION_STRATEGY,
      );
      assertEquals(outputs!.get('changed')?.connectionStrategy, 'owntone');

      await f.close();
      f = undefined;
      f = await open();
      // The persisted session and reset survive a fresh store/service lifecycle.
      assertEquals(await read(), fallback);
      assertEquals(await f.state.get(key), null);
      outputs!.register(registration('reopened'));
      assertEquals(
        outputs!.get('reopened')?.connectionStrategy,
        DEFAULT_CONNECTION_STRATEGY,
      );
    } finally {
      await f?.close();
      await Deno.remove(dir, { recursive: true });
    }
  });
}
