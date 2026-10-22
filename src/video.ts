// Scan-owned video facts and caption conversion. Paths come only from scanned
// sidecars; client caption identifiers never become filesystem paths.
import { basename, dirname, extname, join } from 'node:path';

export interface MediaTrack {
  index: number;
  codec: string | null;
  language: string | null;
  title: string | null;
  channels?: number;
}
export interface CaptionSource {
  key: string;
  name: string;
  format: 'srt' | 'vtt';
  file?: string;
  stream?: number;
}
export interface VideoDetails {
  audio: MediaTrack[];
  subtitles: MediaTrack[];
  captions: CaptionSource[];
}
export const TEXT_SUBTITLES = new Set([
  'subrip',
  'webvtt',
  'mov_text',
  'ass',
  'ssa',
]);

export async function videoDetails(
  path: string,
  audio: MediaTrack[],
  subtitles: MediaTrack[],
): Promise<VideoDetails> {
  const stem = basename(path, extname(path));
  const captions: CaptionSource[] = [];
  const files: string[] = [];
  for await (const entry of Deno.readDir(dirname(path))) {
    if (entry.isFile) files.push(entry.name);
  }
  for (const file of files.sort()) {
    const ext = extname(file).toLowerCase();
    if (ext !== '.srt' && ext !== '.vtt') continue;
    const base = file.slice(0, -ext.length);
    if (base !== stem && !base.startsWith(stem + '.')) continue;
    const language = base === stem ? '' : base.slice(stem.length + 1);
    if (language && !/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]+)*$/.test(language)) {
      continue;
    }
    captions.push({
      key: `sidecar:${encodeURIComponent(file)}`,
      name: language || file,
      format: ext === '.vtt' ? 'vtt' : 'srt',
      file: join(dirname(path), file),
    });
  }
  for (const track of subtitles) {
    if (!track.codec || !TEXT_SUBTITLES.has(track.codec)) continue;
    captions.push({
      key: `stream:${track.index}`,
      name: track.title || track.language || track.codec,
      format: track.codec === 'webvtt' ? 'vtt' : 'srt',
      stream: track.index,
    });
  }
  return { audio, subtitles, captions };
}

export interface CaptionCue {
  start: number;
  end: number;
  text: string;
}

function timestamp(ms: number, format: 'srt' | 'vtt'): string {
  const n = Math.max(0, Math.round(ms));
  const pad = (v: number, length = 2) => String(v).padStart(length, '0');
  return `${pad(Math.floor(n / 3600000))}:${pad(Math.floor(n / 60000) % 60)}:${
    pad(Math.floor(n / 1000) % 60)
  }${format === 'srt' ? ',' : '.'}${pad(n % 1000, 3)}`;
}

export function renderCaptions(
  cues: CaptionCue[],
  format: 'srt' | 'vtt',
): string {
  return (format === 'vtt' ? 'WEBVTT\n\n' : '') +
    cues.map((cue, i) =>
      `${format === 'srt' ? `${i + 1}\n` : ''}${
        timestamp(cue.start, format)
      } --> ${timestamp(cue.end, format)}\n${cue.text}\n\n`
    ).join('');
}

export function convertCaptions(text: string, format: 'srt' | 'vtt'): string {
  const cues: CaptionCue[] = [];
  const time = (
    hours: string | undefined,
    minutes: string,
    seconds: string,
    ms: string,
  ) =>
    Number(hours ?? 0) * 3600000 + Number(minutes) * 60000 +
    Number(seconds) * 1000 + Number(ms);
  for (
    const block of text.replace(/^\uFEFF/, '').replaceAll('\r\n', '\n').split(
      /\n[ \t]*\n/,
    )
  ) {
    const lines = block.split('\n');
    const at = lines.findIndex((line) => line.includes('-->'));
    if (at < 0) continue;
    const match =
      /^(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})\s+-->\s+(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})(?:\s.*)?$/
        .exec(lines[at]);
    if (!match) continue;
    cues.push({
      start: time(match[1], match[2], match[3], match[4]),
      end: time(match[5], match[6], match[7], match[8]),
      text: lines.slice(at + 1).join('\n'),
    });
  }
  return renderCaptions(cues, format);
}
