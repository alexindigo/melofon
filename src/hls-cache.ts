// Core-owned HLS outputs. Native work is injected by app.media; hats receive
// facts and leases, never filesystem paths or cache-admission responsibilities.
import { createHash } from 'node:crypto';
import type { State } from './state.ts';

export interface HlsOptions {
  kbps?: number;
  width?: number;
  height?: number;
  audioTrack?: number;
}
/** Request policy, checked before cache reuse and never passed to encoding. */
export interface HlsAdmissionSettings {
  maxRenditions: number;
  maxDimension: number;
  maxKbps: number;
}
/** Output policy shared by the cache signature and its native producer. */
export interface HlsEncodingSettings {
  segmentSeconds: number;
  audioKbps: number;
  videoKbps: number;
  preset: string;
  threads: number;
  quality: number;
  ladder: string[];
}
export interface HlsFacts {
  width: number;
  height: number;
}
export interface HlsView extends HlsFacts {
  segments: { duration: number }[];
  complete: boolean;
  bandwidth: number;
  segment(index: number): Promise<ReadableStream<Uint8Array> | null>;
  release(): Promise<void>;
}
type Producer = (
  path: string,
  dir: string,
  options: HlsOptions,
  settings: HlsEncodingSettings,
  publish: (facts: HlsFacts) => Promise<void>,
) => Promise<HlsFacts | null>;
interface Entry {
  users: number;
  running: boolean;
  failed: boolean;
  ready: Promise<HlsFacts | null>;
  completion?: Promise<void>;
}

const ADMISSION_DEFAULTS: HlsAdmissionSettings = {
  maxRenditions: 8,
  maxDimension: 4096,
  maxKbps: 100000,
};
const ENCODING_DEFAULTS: HlsEncodingSettings = {
  segmentSeconds: 10,
  audioKbps: 128,
  videoKbps: 2000,
  preset: 'veryfast',
  threads: 2,
  quality: 23,
  // Bounding boxes, never upscale for bitrate-only requests. Preserve aspect
  // ratio and round to even pixels. Explicit WxH requests specify exact size.
  ladder: [
    '500@426x240',
    '1000@640x360',
    '2000@854x480',
    '4000@1280x720',
    '8000@1920x1080',
  ],
};

export class HlsError extends Error {
  readonly code = 'invalid_field';
  constructor(message: string) {
    super(message);
    this.name = 'HlsError';
  }
}

/** One output geometry policy for admission and the native encoder. */
export function hlsDimensions(
  source: HlsFacts,
  options: HlsOptions,
  config: HlsEncodingSettings,
): HlsFacts {
  let { width, height } = source;
  if (options.width !== undefined && options.height !== undefined) {
    if (options.width > width || options.height > height) {
      throw new HlsError('HLS dimensions exceed the source');
    }
    width = options.width;
    height = options.height;
  } else if (options.kbps !== undefined) {
    const ladder = config.ladder.map((rung) => rung.split(/[@x]/).map(Number))
      .sort((a, b) => a[0] - b[0]);
    const box = ladder.find((rung) => rung[0] >= options.kbps!) ??
      ladder.at(-1);
    if (box) {
      const ratio = Math.min(1, box[1] / width, box[2] / height);
      width = Math.max(2, Math.floor(width * ratio / 2) * 2);
      height = Math.max(2, Math.floor(height * ratio / 2) * 2);
    }
  }
  return { width, height };
}

export function createHlsCache(
  produce: Producer,
  state?: Pick<State, 'declare' | 'getTyped'>,
  inspect: (path: string) => Promise<HlsFacts | null> = () =>
    Promise.resolve(null),
) {
  state?.declare('media.hlsCacheMegabytes', {
    type: 'number',
    minimum: 0,
    default: 2048,
  });
  for (
    const name of [
      'segmentSeconds',
      'audioKbps',
      'videoKbps',
      'threads',
    ] as const
  ) {
    state?.declare(`media.hls.${name}`, {
      type: 'integer',
      minimum: 1,
      default: ENCODING_DEFAULTS[name],
    });
  }
  for (const [name, value] of Object.entries(ADMISSION_DEFAULTS)) {
    state?.declare(`media.hls.${name}`, {
      type: 'integer',
      minimum: 1,
      default: value,
    });
  }
  state?.declare('media.hls.preset', {
    type: 'string',
    enum: [
      'ultrafast',
      'superfast',
      'veryfast',
      'faster',
      'fast',
      'medium',
      'slow',
      'slower',
      'veryslow',
    ],
    default: ENCODING_DEFAULTS.preset,
  });
  state?.declare('media.hls.quality', {
    type: 'integer',
    minimum: 0,
    maximum: 51,
    default: ENCODING_DEFAULTS.quality,
  });
  state?.declare('media.hls.ladder', {
    type: 'array',
    items: { type: 'string', pattern: '^[1-9][0-9]*@[1-9][0-9]*x[1-9][0-9]*$' },
    default: ENCODING_DEFAULTS.ladder,
  });
  const entries = new Map<string, Entry>();
  let serial = Promise.resolve();
  const exclusive = <T>(run: () => T | Promise<T>): Promise<T> => {
    const pending = serial.then(run);
    serial = pending.then(() => {}, () => {});
    return pending;
  };
  /** Load only the settings declared by this policy's typed defaults. */
  const settings = async <T extends object>(defaults: T): Promise<T> => {
    const value = { ...defaults };
    for (const key of Object.keys(defaults)) {
      const v = await state?.getTyped(`media.hls.${key}`);
      if (v !== undefined) Object.assign(value, { [key]: v });
    }
    return value;
  };
  async function manifest(dir: string) {
    const text = await Deno.readTextFile(`${dir}/index.m3u8`);
    const segments: { duration: number; name: string }[] = [];
    let duration = 0;
    for (const line of text.split('\n')) {
      if (line.startsWith('#EXTINF:')) duration = parseFloat(line.slice(8));
      else if (/^seg\d+\.ts$/.test(line) && duration > 0) {
        segments.push({ duration, name: line });
        duration = 0;
      }
    }
    if (!segments.length) throw new Error('Empty HLS output');
    let bandwidth = 0;
    for (const segment of segments) {
      const stat = await Deno.stat(`${dir}/${segment.name}`);
      bandwidth = Math.max(
        bandwidth,
        Math.ceil(stat.size * 8 / segment.duration),
      );
    }
    return { segments, bandwidth, complete: text.includes('#EXT-X-ENDLIST') };
  }
  // Include old nested M4.6 output directories in the budget as well as current
  // hashed outputs. Directory mtimes persist recency across process restarts.
  async function prune(root: string) {
    const limit =
      Number(await state?.getTyped('media.hlsCacheMegabytes') ?? 2048) * 1024 *
      1024;
    const outputs: { dir: string; bytes: number; time: number }[] = [];
    async function walk(dir: string): Promise<number> {
      let bytes = 0;
      let output = entries.has(dir) || /\/[a-f0-9]{64}$/.test(dir);
      const children: string[] = [];
      for await (const item of Deno.readDir(dir)) {
        if (item.isFile) {
          const stat = await Deno.stat(`${dir}/${item.name}`).catch((error) => {
            if (!(error instanceof Deno.errors.NotFound)) throw error;
            return null; // muxer atomically renames its playlist temporary
          });
          bytes += stat?.size ?? 0;
          if (item.name === 'index.m3u8' || item.name === 'facts.json') {
            output = true;
          }
        } else if (item.isDirectory) children.push(`${dir}/${item.name}`);
      }
      for (const child of children) bytes += await walk(child);
      if (output) {
        outputs.push({
          dir,
          bytes,
          time: (await Deno.stat(dir)).mtime?.getTime() ?? 0,
        });
      }
      return bytes;
    }
    let total = await walk(root);
    for (const output of outputs.sort((a, b) => a.time - b.time)) {
      if (total <= limit) break;
      const entry = entries.get(output.dir);
      if (entry?.running || entry?.users) continue;
      await Deno.remove(output.dir, { recursive: true });
      entries.delete(output.dir);
      total -= output.bytes;
    }
  }
  const acquire = async (
    path: string,
    root: string,
    options: HlsOptions,
    config: HlsEncodingSettings,
  ): Promise<HlsView | null> => {
    const stat = await Deno.stat(path).catch(() => null);
    if (!stat) return null;
    const signature = JSON.stringify([
      2,
      path,
      stat.size,
      stat.mtime?.getTime(),
      [options.kbps, options.width, options.height, options.audioTrack],
      config,
    ]);
    const key = createHash('sha256').update(signature).digest('hex');
    const dir = `${root}/${key}`;
    const entry = await exclusive(async () => {
      await Deno.mkdir(root, { recursive: true });
      let entry = entries.get(dir);
      if (!entry) {
        let resolve!: (facts: HlsFacts | null) => void;
        entry = {
          users: 0,
          running: true,
          failed: false,
          ready: new Promise((r) => resolve = r),
        };
        entries.set(dir, entry);
        const current = entry;
        // Install the admission entry before the asynchronous worker begins.
        current.completion = (async () => {
          try {
            try {
              const facts = JSON.parse(
                await Deno.readTextFile(`${dir}/facts.json`),
              ) as HlsFacts;
              if ((await manifest(dir)).complete) {
                resolve(facts);
                return;
              }
            } catch {
              /* Absent/interrupted output is rebuilt, never a cache hit. */
            }
            await Deno.remove(dir, { recursive: true }).catch((error) => {
              if (!(error instanceof Deno.errors.NotFound)) {
                throw error;
              }
            });
            let announced = false;
            const facts = await produce(
              path,
              dir,
              options,
              config,
              async (facts) => {
                if (announced) return;
                try {
                  await manifest(dir);
                  announced = true;
                  resolve(facts);
                } catch { /* Not yet published. */ }
              },
            );
            if (!facts || !(await manifest(dir)).complete) {
              throw new Error('HLS encode failed');
            }
            await Deno.writeTextFile(
              `${dir}/facts.json`,
              JSON.stringify(facts),
            );
            resolve(facts);
          } catch {
            current.failed = true;
            resolve(null);
          } finally {
            current.running = false;
            await exclusive(async () => {
              if (current.failed && !current.users) {
                await Deno.remove(dir, { recursive: true }).catch(() => {});
                entries.delete(dir);
              }
              await prune(root);
            });
          }
        })().catch(() => {
          current.failed = true;
          resolve(null);
        });
      }
      entry.users++;
      return entry;
    });
    let released = false;
    const release = () =>
      exclusive(async () => {
        if (released) return;
        released = true;
        entry.users--;
        if (entry.failed && !entry.users && !entry.running) {
          await Deno.remove(dir, { recursive: true }).catch(() => {});
          entries.delete(dir);
        }
        await prune(root);
      });
    try {
      const facts = await entry.ready;
      if (!facts || entry.failed) {
        await release();
        return null;
      }
      const view = await manifest(dir);
      // A complete view also proves native teardown and cache bookkeeping have
      // settled. Event views deliberately keep their shared producer running.
      if (view.complete) await entry.completion;
      if (entry.failed) {
        await release();
        return null;
      }
      await Deno.utime(dir, new Date(), new Date());
      return {
        ...facts,
        ...view,
        release,
        async segment(index) {
          const segment = view.segments[index];
          if (!segment || released) return null;
          // A separate read lease survives release of the playlist's lease.
          await exclusive(() => {
            entry.users++;
          });
          let done = false;
          const finish = async () => {
            if (done) return;
            done = true;
            await exclusive(async () => {
              entry.users--;
              await prune(root);
            });
          };
          try {
            const file = await Deno.open(`${dir}/${segment.name}`);
            const reader = file.readable.getReader();
            return new ReadableStream<Uint8Array>({
              async pull(controller) {
                try {
                  const next = await reader.read();
                  if (next.done) {
                    await finish();
                    controller.close();
                  } else controller.enqueue(next.value);
                } catch (error) {
                  await finish();
                  controller.error(error);
                }
              },
              async cancel(reason) {
                try {
                  await reader.cancel(reason);
                } finally {
                  await finish();
                }
              },
            });
          } catch (error) {
            await finish();
            throw error;
          }
        },
      };
    } catch {
      await release();
      return null;
    }
  };

  async function hlsRenditions(
    path: string,
    root: string,
    requested: HlsOptions[],
  ): Promise<HlsView[] | null> {
    const admission = await settings(ADMISSION_DEFAULTS);
    const encoding = await settings(ENCODING_DEFAULTS);
    // Snapshot the whole request before source inspection or producer admission. Hats
    // cannot start an earlier valid rung before a later rung has been checked.
    if (!requested.length || requested.length > admission.maxRenditions) {
      throw new HlsError('HLS rendition count exceeds media.hls.maxRenditions');
    }
    const options = requested.map((option) => ({ ...option }));
    for (const option of options) {
      if (
        Object.values(option).some((value) =>
          value !== undefined && (!Number.isSafeInteger(value) || value < 0)
        ) || option.kbps === 0 ||
        (option.width === undefined) !== (option.height === undefined) ||
        (option.width !== undefined &&
          (option.width < 2 || option.height! < 2 || option.width % 2 ||
            option.height! % 2))
      ) throw new HlsError('Invalid HLS rendition or audio track');
      if (
        (option.kbps ?? encoding.videoKbps) > admission.maxKbps ||
        encoding.audioKbps > admission.maxKbps
      ) {
        throw new HlsError('HLS bitrate exceeds media.hls.maxKbps');
      }
      if (
        (option.width ?? 0) > admission.maxDimension ||
        (option.height ?? 0) > admission.maxDimension
      ) {
        throw new HlsError('HLS dimensions exceed media.hls.maxDimension');
      }
    }
    const source = await inspect(path);
    if (!source) return null;
    for (const option of options) {
      const { width, height } = hlsDimensions(source, option, encoding);
      if (width > admission.maxDimension || height > admission.maxDimension) {
        throw new HlsError('HLS dimensions exceed media.hls.maxDimension');
      }
    }
    const views: HlsView[] = [];
    try {
      for (const option of options) {
        const view = await acquire(path, root, option, encoding);
        if (!view) return null;
        views.push(view);
      }
      return views;
    } finally {
      if (views.length !== options.length) {
        for (const view of views) await view.release();
      }
    }
  }
  return {
    hlsRenditions,
    async hls(path: string, root: string, options: HlsOptions = {}) {
      return (await hlsRenditions(path, root, [options]))?.[0] ?? null;
    },
  };
}
