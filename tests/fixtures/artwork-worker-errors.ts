import { assertRejects } from '@std/assert';
import { createArtworkFactsHost } from '../../src/artwork/facts-host.ts';
import { artworkStateFixture } from '../helpers/artwork-worker.ts';

const source = { width: 1, height: 1, rgba: new Uint8Array([255, 0, 0, 255]) };
const errors: string[] = [];
for (
  const [code, message] of [
    ['throw new Error("fixture startup error");', 'fixture startup error'],
    [
      'postMessage({ready:true}); onmessage = () => { throw new Error("fixture compute error"); };',
      'fixture compute error',
    ],
    [
      'postMessage({ready:true}); onmessage = async () => { throw new Error("fixture async error"); };',
      'fixture async error',
    ],
    [
      'postMessage({ready:true}); onmessage = () => postMessage({value:{thumbHash:42}});',
      'Invalid artwork Worker result',
    ],
  ]
) {
  const url = new URL(
    `data:application/javascript,${encodeURIComponent(code)}`,
  );
  const host = createArtworkFactsHost(artworkStateFixture(), url);
  try {
    const error = await assertRejects(
      () => host.compute(source),
      Error,
      message,
    );
    errors.push(error.message);
  } finally {
    host.close();
  }
}
console.log(JSON.stringify(errors));
