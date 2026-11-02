// Core owns stream decisions and their execution. Hats parse wire arguments;
// one prepared decision governs GET/HEAD, legacy streaming and negotiation.
// Media delivery has no playback-state capability: apps report separately.
import { serveFile } from '@std/http/file-server';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { extname } from 'node:path';
import type { Media } from './media.ts';
import type { FileSource } from './file-source.ts';
import { type Log, scopedLog } from './logging.ts';
import {
  type ClientCapabilities,
  negotiate,
  type Negotiation,
} from './stream-negotiation.ts';

export interface StreamFile {
  path: string;
  isVideo: boolean;
}
export interface StreamOptions {
  timeOffset?: number;
  estimateContentLength?: boolean;
}
export type StreamDecision =
  | { kind: 'direct' }
  | {
    kind: 'transcode';
    format: string;
    bitRateKbps: number;
    sampleRate?: number;
    channels?: number;
  };
export interface StreamService {
  source: FileSource;
  file(
    request: Request,
    path: string,
  ): Promise<Response>;
  play(
    request: Request,
    file: StreamFile,
    format?: string,
    maxBitRateKbps?: number,
    options?: StreamOptions,
  ): Promise<Response | null>;
  decision(
    file: StreamFile,
    capabilities: ClientCapabilities,
    username: string,
  ): Promise<(Negotiation & { transcodeParams: string }) | null>;
  negotiated(
    request: Request,
    file: StreamFile,
    token: string,
    username: string,
    offset?: number,
  ): Promise<Response>;
}

// Normalize unlimited once, before any target or bitrate selection.
const limit = (value?: number) =>
  value !== undefined && Number.isFinite(value) && value > 0 ? value : Infinity;
const offsetSeconds = (value?: number) =>
  value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : 0;

export function createStream(
  media: Media,
  cfg?: { absentToMp3?: boolean; secret?: string },
  log: Log = scopedLog('stream'),
  source: FileSource = () => Promise.resolve(null),
): StreamService {
  const secret = cfg?.secret ?? crypto.randomUUID();
  const signature = (payload: string) =>
    createHmac('sha256', secret).update(payload).digest();
  const fileKey = (path: string) =>
    createHash('sha256').update(path).digest('hex');
  const stamp = async (path: string) => {
    const stat = await Deno.stat(path);
    return `${stat.size}:${stat.mtime?.getTime()}:${stat.ino}`;
  };
  const fixed = async (
    request: Request,
    path: string,
  ) => {
    const response = await serveFile(request, path);
    const probe = await media.probe(path);
    if (probe.durationMs !== null) {
      response.headers.set(
        'X-Content-Duration',
        String(probe.durationMs / 1000),
      );
    }
    return response;
  };
  const serve = async (
    request: Request,
    file: StreamFile,
    decision: StreamDecision,
    options: StreamOptions = {},
  ): Promise<Response | null> => {
    if (decision.kind === 'direct') return fixed(request, file.path);
    const profile = (await media.audioProfiles()).find((p) =>
      p.format === decision.format
    );
    if (!profile) return null;
    const probe = await media.probe(file.path);
    if (!probe.hasAudio) return null;
    const offset = offsetSeconds(options.timeOffset);
    const headers = new Headers({
      'content-type': profile.contentType,
      'accept-ranges': 'none',
    });
    if (probe.durationMs !== null) {
      headers.set('X-Content-Duration', String(probe.durationMs / 1000));
    }
    const empty = probe.durationMs !== null &&
      offset * 1000 >= probe.durationMs;
    // Navidrome media_streamer.go:149-151,165-172: full source duration,
    // selected kbps and 1024 (not 1000), even for an offset request.
    if (options.estimateContentLength && probe.durationMs !== null) {
      headers.set(
        'content-length',
        String(
          Math.trunc(probe.durationMs / 1000 * decision.bitRateKbps / 8 * 1024),
        ),
      );
    }
    if (empty) {
      log.event('stream_empty', {
        path: file.path,
        format: decision.format,
        offset,
      });
      headers.set('content-length', '0');
    }
    if (request.method === 'HEAD' || empty) {
      return new Response(null, { headers });
    }
    const audio = await media.transcodeAudio(file.path, decision.format, {
      bitRateKbps: decision.bitRateKbps,
      startSeconds: offset,
      sampleRate: decision.sampleRate,
      channels: decision.channels,
      signal: request.signal,
    });
    if (!audio) return null;
    return new Response(audio.stream, { headers });
  };
  return {
    source,
    file: fixed,
    async play(request, file, format, maxBitRateKbps, options) {
      if (format === 'raw') return fixed(request, file.path);
      const ceiling = limit(maxBitRateKbps);
      const probe = await media.probe(file.path);
      const profiles = await media.audioProfiles();
      const over = probe.bitrateKbps !== null && probe.bitrateKbps > ceiling;
      const container = extname(file.path).slice(1).toLowerCase();
      if (file.isVideo && format === container && !over) {
        return fixed(request, file.path);
      }
      let target = format;
      if (!file.isVideo && format === undefined && !cfg?.absentToMp3 && !over) {
        return fixed(request, file.path);
      }
      if (!file.isVideo && format === probe.audioCodec && !over) {
        return fixed(request, file.path);
      }
      if (target === undefined && over && !file.isVideo) {
        target = probe.audioCodec ?? undefined;
      }
      const profile = profiles.find((p) => p.format === target) ??
        profiles.find((p) => p.format === 'mp3');
      if (!profile) return null;
      if (
        !file.isVideo && format !== undefined &&
        profile.format === probe.audioCodec && !over
      ) return fixed(request, file.path);
      return serve(
        request,
        file,
        {
          kind: 'transcode',
          format: profile.format,
          bitRateKbps: Math.min(profile.bitRateKbps, ceiling),
        },
        options,
      );
    },
    async decision(file, capabilities, username) {
      const source = await media.describeAudio(file.path);
      if (!source) return null;
      const result = negotiate(
        source,
        capabilities,
        await media.audioProfiles(),
      );
      let token = '';
      if (result.selection) {
        const payload = Buffer.from(
          JSON.stringify({
            file: fileKey(file.path),
            stamp: await stamp(file.path),
            username,
            decision: result.selection,
          }),
        ).toString('base64url');
        token = `${payload}.${signature(payload).toString('base64url')}`;
      }
      return { ...result, transcodeParams: token };
    },
    async negotiated(request, file, token, username, offset) {
      let decision: StreamDecision;
      try {
        const [payload, mac, extra] = token.split('.');
        const expected = signature(payload);
        const actual = Buffer.from(mac, 'base64url');
        if (
          extra !== undefined || actual.length !== expected.length ||
          !timingSafeEqual(actual, expected)
        ) throw new Error('Invalid token');
        const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
        if (
          claims.file !== fileKey(file.path) ||
          claims.username !== username ||
          claims.stamp !== await stamp(file.path)
        ) throw new Error('Stale token');
        decision = claims.decision;
      } catch {
        return new Response('Invalid or stale transcodeParams', {
          status: 410,
        });
      }
      return await serve(request, file, decision, {
        timeOffset: offset,
      }) ?? new Response('Cannot create media stream', { status: 500 });
    },
  };
}
