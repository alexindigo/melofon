// Shared normalized output-frame origin; no decoder or transport dependency.
export const PCM_RATE = 44100;

export function pcmOrigin(
  options: { startMs?: number; startFrame?: bigint },
): bigint {
  let frame = options.startFrame;
  if (frame !== undefined && options.startMs !== undefined) {
    throw new RangeError('PCM origin requires either startFrame or startMs');
  }
  if (frame === undefined) {
    const ms = options.startMs ?? 0;
    const rounded = Math.round(ms * PCM_RATE / 1000);
    if (!Number.isFinite(ms) || ms < 0 || !Number.isSafeInteger(rounded)) {
      throw new RangeError('PCM origin is not representable');
    }
    frame = BigInt(rounded);
  }
  if (typeof frame !== 'bigint' || frame < 0n || frame > 0xffffffffffffffffn) {
    throw new RangeError('PCM origin requires an unsigned 64-bit frame');
  }
  return frame;
}
