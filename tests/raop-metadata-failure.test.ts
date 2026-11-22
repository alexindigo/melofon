import { assert, assertEquals } from '@std/assert';
import {
  faultChild,
  nativeStream,
  startFakeRaop,
  titles,
  until,
} from './helpers/raop-isolation.ts';

for (const stage of [3, 4, 5, 6]) {
  const name =
    `RAOP metadata failure: stage ${stage} retains content and remains reusable`;
  Deno.test({
    name,
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
      if (await faultChild(name, new URL(import.meta.url).pathname)) return;
      const fault = Deno.dlopen(Deno.env.get('RAOP_ISOLATION_FAULT_LIB')!, {
        raop_fi_allocation_stage: { parameters: ['i32'], result: 'void' },
      });
      const stream = nativeStream();
      const receiver = await startFakeRaop({ captureWire: true });
      try {
        if (stage !== 6) {
          assertEquals(
            await stream.metadata('Preserved content', 'Artist', 700, 3456),
            0,
          );
        }
        fault.symbols.raop_fi_allocation_stage(stage);
        assert(
          (await stream.metadata('Fault metadata', 'Replacement', 0, 1000)) < 0,
        );
        if (stage === 6) {
          assertEquals(
            await stream.metadata('Preserved content', 'Artist', 700, 3456),
            0,
          );
        }
        await stream.attach(receiver);
        await until(
          'previous complete metadata reaches receiver',
          () => titles(receiver.sessions[0]).length > 0,
        );
        assert(
          titles(receiver.sessions[0]).every((text) =>
            text.includes('Preserved content') &&
            !text.includes('Fault metadata')
          ),
        );
      } finally {
        fault.symbols.raop_fi_allocation_stage(0);
        await stream.close();
        receiver.close();
        fault.close();
      }
    },
  });
}
