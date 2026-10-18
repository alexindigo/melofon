// Profile matching over plain media facts. Native codec ownership stays in media;
// the OpenSubsonic plugin alone validates/encodes its wire payload.
import type { AudioDetails, AudioProfile } from './media.ts';
import type { StreamDecision } from './stream.ts';

export interface Limitation {
  name: string;
  comparison: string;
  values: string[];
  required: boolean;
}
export interface ClientCapabilities {
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
  codecProfiles?: { type: string; name: string; limitations?: Limitation[] }[];
}
export interface Negotiation {
  canDirectPlay: boolean;
  canTranscode: boolean;
  transcodeReason: string[];
  errorReason: string;
  sourceStream: AudioDetails;
  transcodeStream?: AudioDetails;
  selection?: StreamDecision;
}
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const codec = (s: string) =>
  s.toLowerCase() === 'ogg' ? 'vorbis' : s.toLowerCase();
const matches = (value: string, choices: string[]) =>
  !choices.length || choices.some((v) => same(v, value));
const cap = (n?: number) => n !== undefined && n > 0 ? n : Infinity;

function satisfies(
  value: string | number | undefined,
  lim: Limitation,
): boolean {
  if (value === undefined) return false;
  const equal = (v: string) =>
    typeof value === 'number' ? Number(v) === value : same(v, value);
  switch (lim.comparison) {
    case 'Equals':
      return lim.values.some(equal);
    case 'NotEquals':
      return !lim.values.some(equal);
    case 'LessThanEqual':
      return typeof value === 'string' || value <= Number(lim.values[0]);
    case 'GreaterThanEqual':
      return typeof value === 'string' || value >= Number(lim.values[0]);
    default:
      return false;
  }
}
const limits = (info: ClientCapabilities, target: string) =>
  (info.codecProfiles ?? []).filter((p) => codec(p.name) === codec(target))
    .flatMap((p) => p.limitations ?? []);

export function negotiate(
  source: AudioDetails,
  info: ClientCapabilities,
  profiles: AudioProfile[],
): Negotiation {
  const result: Negotiation = {
    canDirectPlay: false,
    canTranscode: false,
    transcodeReason: [],
    errorReason: '',
    sourceStream: source,
  };
  for (const profile of info.directPlayProfiles ?? []) {
    const reason = !matches('http', profile.protocols)
      ? 'protocol not supported'
      : !matches(source.container, profile.containers)
      ? 'container not supported'
      : !matches(codec(source.codec), profile.audioCodecs.map(codec))
      ? 'audio codec not supported'
      : source.audioBitrate !== undefined &&
          source.audioBitrate > cap(info.maxAudioBitrate)
      ? 'audio bitrate not supported'
      : source.audioChannels !== undefined &&
          source.audioChannels > cap(profile.maxAudioChannels)
      ? 'audio channels not supported'
      : limits(info, source.codec).find((lim) =>
          lim.required &&
          !satisfies(source[lim.name as keyof AudioDetails], lim)
        )
      ? 'codec limitation not supported'
      : '';
    if (!reason) {
      return {
        ...result,
        canDirectPlay: true,
        selection: { kind: 'direct' },
        transcodeReason: [],
      };
    }
    result.transcodeReason.push(reason);
  }
  for (const requested of info.transcodingProfiles ?? []) {
    if (!same(requested.protocol, 'http')) continue;
    const profile = profiles.find((p) =>
      same(p.container, requested.container) &&
      codec(p.codec) === codec(requested.audioCodec)
    );
    if (!profile || !source.audioSamplerate || !source.audioChannels) continue;
    const rates = profile.sampleRates;
    const sampleRate = rates?.length
      ? [...rates].sort((a, b) =>
        Math.abs(a - source.audioSamplerate!) -
        Math.abs(b - source.audioSamplerate!)
      )[0]
      : source.audioSamplerate;
    const maxChannels = Math.min(
      source.audioChannels,
      cap(requested.maxAudioChannels),
    );
    const channels = profile.channelCounts?.length
      ? Math.max(...profile.channelCounts.filter((c) => c <= maxChannels))
      : maxChannels;
    if (!(channels > 0)) continue;
    const target: AudioDetails = {
      protocol: 'http',
      container: profile.container,
      codec: profile.codec,
      audioChannels: channels,
      audioSamplerate: sampleRate,
      audioBitrate: Math.min(
        profile.bitRateKbps * 1000,
        cap(info.maxAudioBitrate),
        cap(info.maxTranscodingAudioBitrate),
      ),
    };
    let rejected = false;
    for (const lim of limits(info, target.codec)) {
      const key = lim.name as keyof AudioDetails;
      if (satisfies(target[key], lim)) continue;
      const current = target[key];
      // Match Navidrome's downward-only limitation fitting. The encoder then
      // receives these exact values, rather than treating the decision as a hint.
      if (
        typeof current === 'number' &&
        ['audioChannels', 'audioSamplerate', 'audioBitrate'].includes(key)
      ) {
        const candidates = lim.values.map(Number).filter((n) =>
          Number.isFinite(n) && n > 0 && n <= current && satisfies(n, lim)
        );
        const fitted = Math.max(...candidates);
        const supported = key !== 'audioSamplerate' || !rates?.length ||
          rates.includes(fitted);
        const layout = key !== 'audioChannels' ||
          !profile.channelCounts?.length ||
          profile.channelCounts.includes(fitted);
        if (fitted > 0 && supported && layout) {
          Object.assign(target, { [key]: fitted });
          continue;
        }
      }
      // For transcodes Navidrome rejects any limitation that cannot fit.
      rejected = true;
      break;
    }
    if (rejected) continue;
    return {
      ...result,
      canTranscode: true,
      transcodeStream: target,
      selection: {
        kind: 'transcode',
        format: profile.format,
        bitRateKbps: target.audioBitrate! / 1000,
        sampleRate: target.audioSamplerate,
        channels: target.audioChannels,
      },
    };
  }
  return { ...result, errorReason: 'no compatible playback profile found' };
}
