import { encodeBase64 } from '@std/encoding/base64';
import { rgbaToThumbHash } from './thumbhash.ts';
import { dominantColor } from './dominant-color.ts';

declare function postMessage(value: unknown): void;
addEventListener('message', (event) => {
  const { data } = event as MessageEvent<{
    width: number;
    height: number;
    rgba: Uint8Array;
    call: string;
  }>;
  try {
    postMessage({ started: true, call: data.call });
    postMessage({
      call: data.call,
      value: {
        thumbHash: encodeBase64(
          rgbaToThumbHash(data.width, data.height, data.rgba),
        ),
        dominantColor: dominantColor(data.rgba) || null,
      },
    });
  } catch (error) {
    postMessage({ error: String(error), call: data.call });
  }
});
postMessage({ ready: true });
