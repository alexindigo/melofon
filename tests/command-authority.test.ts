import { assert, assertEquals } from '@std/assert';
import { createCommandLane } from '../src/command-authority.ts';

Deno.test('command handles cancel only captured authority, including reentrant submission', () => {
  const lane = createCommandLane();
  const first = lane.submit();
  let reentrant: ReturnType<typeof lane.submit> | undefined;
  first.signal.addEventListener('abort', () => reentrant = lane.submit());
  const second = lane.submit();
  assert(first.signal.aborted);
  assert(second.signal.aborted);
  assert(reentrant);
  assert(reentrant.isCurrent());
  first.cancel();
  second.cancel();
  assert(reentrant.isCurrent());
  assertEquals(lane.capture(), reentrant);
  reentrant.cancel();
  assertEquals(lane.capture(), undefined);
});
