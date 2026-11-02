// Shared declaration policy. Hats only transport the document; negotiation
// decides whether declared profiles can play a particular source.
import type { ClientCapabilities } from './stream-negotiation.ts';

export class CapabilityError extends Error {
  constructor(public readonly code: 'invalid_value' | 'too_large') {
    super(
      code === 'too_large'
        ? 'Playback capabilities are too large'
        : 'Invalid playback capabilities',
    );
    this.name = 'CapabilityError';
  }
}

function invalid(): never {
  throw new CapabilityError('invalid_value');
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    value === null || typeof value !== 'object' || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).some((key) => !keys.includes(key))
  ) invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) invalid();
  return value.trim();
}
function token(value: unknown): string {
  const result = text(value).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._+-]*$/.test(result)) invalid();
  return result;
}
function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) invalid();
  return value as number;
}
function protocol(value: unknown): string {
  const result = token(value);
  if (!['http', 'hls'].includes(result)) invalid();
  return result;
}
function array<T>(value: unknown, parse: (value: unknown) => T): T[] {
  if (!Array.isArray(value)) invalid();
  return value.map(parse);
}
function strings(value: unknown, parse = token): string[] {
  return [...new Set(array(value, parse))];
}
function channels(row: Record<string, unknown>) {
  return row.maxAudioChannels === undefined
    ? {}
    : { maxAudioChannels: integer(row.maxAudioChannels) };
}

export function normalizeCapabilities(
  value: unknown,
  maxBytes: number,
): ClientCapabilities {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    invalid();
  }
  if (json === undefined) invalid();
  if (new TextEncoder().encode(json).length > maxBytes) {
    throw new CapabilityError('too_large');
  }
  const row = object(value, [
    'name',
    'platform',
    'maxAudioBitrate',
    'maxTranscodingAudioBitrate',
    'directPlayProfiles',
    'transcodingProfiles',
    'codecProfiles',
  ]);
  const result: ClientCapabilities = {
    name: text(row.name),
    platform: text(row.platform),
    ...(row.maxAudioBitrate === undefined
      ? {}
      : { maxAudioBitrate: integer(row.maxAudioBitrate) }),
    ...(row.maxTranscodingAudioBitrate === undefined ? {} : {
      maxTranscodingAudioBitrate: integer(row.maxTranscodingAudioBitrate),
    }),
    directPlayProfiles: array(
      row.directPlayProfiles === undefined ? [] : row.directPlayProfiles,
      (value) => {
        const p = object(value, [
          'containers',
          'audioCodecs',
          'protocols',
          'maxAudioChannels',
        ]);
        return {
          containers: strings(p.containers),
          audioCodecs: strings(p.audioCodecs),
          protocols: strings(p.protocols, protocol),
          ...channels(p),
        };
      },
    ),
    transcodingProfiles: array(
      row.transcodingProfiles === undefined ? [] : row.transcodingProfiles,
      (value) => {
        const p = object(value, [
          'container',
          'audioCodec',
          'protocol',
          'maxAudioChannels',
        ]);
        return {
          container: token(p.container),
          audioCodec: token(p.audioCodec),
          protocol: protocol(p.protocol),
          ...channels(p),
        };
      },
    ),
    codecProfiles: array(
      row.codecProfiles === undefined ? [] : row.codecProfiles,
      (value) => {
        const p = object(value, ['type', 'name', 'limitations']);
        if (p.type !== 'AudioCodec') invalid();
        return {
          type: 'AudioCodec',
          name: token(p.name),
          limitations: array(
            p.limitations === undefined ? [] : p.limitations,
            (value) => {
              const lim = object(value, [
                'name',
                'comparison',
                'values',
                'required',
              ]);
              if (
                typeof lim.name !== 'string' ||
                typeof lim.comparison !== 'string' ||
                ![
                  'audioChannels',
                  'audioBitrate',
                  'audioProfile',
                  'audioSamplerate',
                  'audioBitdepth',
                ].includes(lim.name) ||
                !['Equals', 'NotEquals', 'LessThanEqual', 'GreaterThanEqual']
                  .includes(lim.comparison) ||
                typeof lim.required !== 'boolean'
              ) invalid();
              if (
                lim.name === 'audioProfile' &&
                !['Equals', 'NotEquals'].includes(lim.comparison)
              ) invalid();
              const values = strings(lim.values, (value) => {
                if (lim.name === 'audioProfile') return token(value);
                const number = Number(text(value));
                return String(integer(number));
              });
              if (!values.length) invalid();
              return {
                name: lim.name,
                comparison: lim.comparison,
                values,
                required: lim.required,
              };
            },
          ),
        };
      },
    ),
  };
  if (new TextEncoder().encode(JSON.stringify(result)).length > maxBytes) {
    throw new CapabilityError('too_large');
  }
  return result;
}
