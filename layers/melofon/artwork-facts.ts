import { encodeBase64 } from '@std/encoding/base64';
import type { ArtworkDescriptor, ArtworkRef, HatContext } from './types.ts';
import { rgbaToThumbHash } from './thumbhash.ts';
import { dominantColor } from './dominant-color.ts';
import { artworkUrl } from './artwork.ts';

type Facts = {
  algorithmVersion: number;
  sourceHash: string;
  thumbHash: string;
  dominantColor: string;
  width: number | null;
  height: number | null;
};

function stored(value: unknown, sourceHash: string): value is Facts {
  if (!value || typeof value !== 'object') return false;
  const facts = value as Facts;
  return facts.algorithmVersion === 2 && facts.sourceHash === sourceHash &&
    typeof facts.thumbHash === 'string' &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(facts.thumbHash) &&
    typeof facts.dominantColor === 'string' &&
    /^#[a-f0-9]{6}$/.test(facts.dominantColor);
}

/** One request owns its bounded work and joins it before returning. No detached
 * jobs or module state: persisted, source-keyed facts deduplicate later reads. */
export function artworkFacts(context: HatContext) {
  const seen = new Map<string, Promise<Facts | null>>();
  let attempted = 0;
  const limit = context.app.state.getTyped('melofon.artworkFactsPerRequest');
  async function facts(ref: ArtworkRef, descriptor: ArtworkDescriptor) {
    const key = `artwork-facts/v2/${descriptor.sourceHash}`;
    try {
      const record = await context.app.hatData.get(key);
      if (
        record?.kind === 'data' && stored(record.value, descriptor.sourceHash)
      ) {
        return record.value;
      }
      const maximum = Number(await limit);
      if (attempted >= maximum) return null;
      attempted++;
      const pixels = await context.app.artwork.pixels(ref, {
        username: context.state.user.username,
        size: 100,
      });
      // Resolution can change during the request. Never label old/new pixels
      // with the other snapshot's hash; the next read resolves it afresh.
      if (
        pixels.kind !== 'pixels' ||
        pixels.descriptor.sourceHash !== descriptor.sourceHash
      ) return null;
      const value: Facts = {
        algorithmVersion: 2,
        sourceHash: descriptor.sourceHash,
        thumbHash: encodeBase64(
          rgbaToThumbHash(pixels.width, pixels.height, pixels.rgba),
        ),
        dominantColor: dominantColor(pixels.rgba),
        width: pixels.descriptor.width,
        height: pixels.descriptor.height,
      };
      await context.app.hatData.put(key, { kind: 'data', value });
    } catch {
      // Optional derived facts must not break browsing. No failure marker is
      // saved: decode/admission/storage failures remain retryable.
    }
    // A miss stays a miss throughout this response, even for shared images.
    return null;
  }
  return async (ref: ArtworkRef) => {
    // Core resolves existence/visibility and expected source unavailability
    // before any private-store read. Unexpected owner faults must still surface.
    const result = await context.app.artwork.describe(ref, {
      username: context.state.user.username,
    });
    if (result.kind !== 'image') return null;
    const descriptor = result.descriptor;
    let pending = seen.get(descriptor.sourceHash);
    if (!pending) {
      pending = facts(ref, descriptor);
      seen.set(descriptor.sourceHash, pending);
    }
    const value = await pending;
    return {
      url: artworkUrl(
        ref,
        descriptor.version,
        await context.app.publicAddress.prefix(),
      ),
      version: descriptor.version,
      width: descriptor.width,
      height: descriptor.height,
      thumbHash: value?.thumbHash ?? null,
      dominantColor: value?.dominantColor ?? null,
    };
  };
}
