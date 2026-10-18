// Wire validation and projection only. Matching, real profiles, verified
// parameters and native execution belong to the injected stream service.
import { jsonIntegerParam } from '#opensubsonic/params.ts';
export interface ClientInfo {
  name: string;
  platform: string;
  maxAudioBitrate?: number;
  maxTranscodingAudioBitrate?: number;
  directPlayProfiles?: {
    containers: string[];
    audioCodecs: string[];
    protocols: string[];
    maxAudioChannels?: number;
  }[];
  transcodingProfiles?: {
    container: string;
    audioCodec: string;
    protocol: string;
    maxAudioChannels?: number;
  }[];
  codecProfiles?: {
    type: string;
    name: string;
    limitations?: {
      name: string;
      comparison: string;
      values: string[];
      required: boolean;
    }[];
  }[];
}
export interface StreamDetails {
  protocol: string;
  container: string;
  codec: string;
  audioChannels?: number;
  audioBitrate?: number;
  audioProfile?: string;
  audioSamplerate?: number;
  audioBitdepth?: number;
}
export interface TranscodeDecision {
  canDirectPlay: boolean;
  canTranscode: boolean;
  transcodeReason: string[];
  errorReason: string;
  transcodeParams: string;
  sourceStream: StreamDetails;
  transcodeStream?: StreamDetails;
}

const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const strings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((s) => typeof s === 'string');
const integer = (v: unknown) => v === undefined || jsonIntegerParam(v);
const protocol = (v: unknown) => v === 'http' || v === 'hls';
const rows = (v: unknown, valid: (row: Record<string, unknown>) => boolean) =>
  v === undefined ||
  (Array.isArray(v) && v.every((row) => record(row) && valid(row)));

export function clientInfo(value: unknown): ClientInfo | null {
  if (
    !record(value) || typeof value.name !== 'string' ||
    typeof value.platform !== 'string' || !integer(value.maxAudioBitrate) ||
    !integer(value.maxTranscodingAudioBitrate)
  ) return null;
  if (
    !rows(
      value.directPlayProfiles,
      (p) =>
        strings(p.containers) && strings(p.audioCodecs) &&
        strings(p.protocols) &&
        p.protocols.every(protocol) && integer(p.maxAudioChannels),
    )
  ) return null;
  if (
    !rows(
      value.transcodingProfiles,
      (p) =>
        typeof p.container === 'string' && typeof p.audioCodec === 'string' &&
        protocol(p.protocol) && integer(p.maxAudioChannels),
    )
  ) return null;
  if (
    !rows(
      value.codecProfiles,
      (p) =>
        p.type === 'AudioCodec' && typeof p.name === 'string' &&
        rows(p.limitations, (lim) =>
          [
            'audioChannels',
            'audioBitrate',
            'audioProfile',
            'audioSamplerate',
            'audioBitdepth',
          ].includes(String(lim.name)) &&
          ['Equals', 'NotEquals', 'LessThanEqual', 'GreaterThanEqual'].includes(
            String(lim.comparison),
          ) && strings(lim.values) && typeof lim.required === 'boolean'),
    )
  ) return null;
  return value as unknown as ClientInfo;
}
