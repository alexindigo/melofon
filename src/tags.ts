// The sole taglib-wasm boundary. Edit a private sibling, verify the complete
// preservation contract through both readers, then atomically publish it.
import { TagLib } from 'taglib-wasm';
import { Buffer } from 'node:buffer';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  type IAudioMetadata,
  type ILyricsTag,
  parseFile,
} from 'music-metadata';
import { createMedia } from './media.ts';

export interface TagChange {
  picture?: { bytes: Uint8Array; mime: string };
  lyrics?: {
    text: string;
    lang?: string;
    synced?: { timeMs: number; text: string }[];
  };
}

let instance: Promise<TagLib> | undefined;
const taglib = () =>
  instance ??= TagLib.initialize({ forceWasmType: 'wasi' })
    .catch((error) => {
      instance = undefined;
      throw error;
    });

const pictureKey =
  /^(APIC|PIC|covr|METADATA_BLOCK_PICTURE|COVERART|COVERARTMIME)$/i;
const lyricsKey = /^(USLT|ULT|SYLT|LYRICS|©lyr)$/i;
type ChangedFields = { picture?: unknown; lyrics?: unknown };
const changed = (id: string, change: ChangedFields) =>
  (change.picture !== undefined && pictureKey.test(id)) ||
  (change.lyrics !== undefined && lyricsKey.test(id));

/** Full property map, not the handful of commonly projected fields. */
async function properties(path: string, change: TagChange) {
  using file = await (await taglib()).open(resolve(path));
  return {
    format: file.getFormat(),
    properties: Object.fromEntries(
      Object.entries(file.properties()).filter(([key]) =>
        !changed(key, change)
      ),
    ),
  };
}

/** Keep duplicate native entries too. Tag family versions may change (v2.3 to
 * v2.4), but no unrelated parsed tag may be added, removed or changed. */
export function unchangedTagFacts(meta: IAudioMetadata, change: ChangedFields) {
  const common = { ...meta.common };
  if (change.picture) delete common.picture;
  if (change.lyrics) delete common.lyrics;
  return {
    common,
    tool: meta.format.tool,
    native: Object.values(meta.native).flat()
      .filter((tag) => !changed(tag.id, change))
      .map((tag) => JSON.stringify(tag)).sort(),
  };
}

const signature = (
  s: Deno.FileInfo,
) => [s.dev, s.ino, s.size, s.mtime?.getTime(), s.mode];

/** Only inspect the trailer's fixed positions, never search audio for TAG. */
async function id3v1(path: string): Promise<Uint8Array> {
  using file = await Deno.open(path, { read: true });
  const { size } = await file.stat();
  const tail = new Uint8Array(Math.min(355, size));
  await file.seek(size - tail.length, Deno.SeekMode.Start);
  let at = 0;
  while (at < tail.length) {
    const n = await file.read(tail.subarray(at));
    if (n === null) throw new Error('Truncated ID3v1 trailer');
    at += n;
  }
  const text = (at: number, length: number) =>
    new TextDecoder().decode(tail.subarray(at, at + length));
  if (tail.length < 128 || text(tail.length - 128, 3) !== 'TAG') {
    return new Uint8Array();
  }
  return tail.slice(
    tail.length === 355 && text(0, 4) === 'TAG+' ? 0 : tail.length - 128,
  );
}

async function restoreId3v1(path: string, original: Uint8Array) {
  const saved = await id3v1(path);
  using file = await Deno.open(path, { read: true, write: true });
  await file.truncate((await file.stat()).size - saved.length);
  await file.seek(0, Deno.SeekMode.End);
  let at = 0;
  while (at < original.length) at += await file.write(original.subarray(at));
}

function language(lyrics: NonNullable<TagChange['lyrics']>) {
  const lang = lyrics.lang ?? 'xxx';
  if (!/^[A-Za-z]{3}$/.test(lang)) {
    throw new Error('Invalid ID3 lyrics language');
  }
  return lang;
}

function syncBody(lyrics: NonNullable<TagChange['lyrics']>) {
  return Buffer.concat([
    Buffer.from([3]), // ID3v2.4 UTF-8
    Buffer.from(language(lyrics)),
    Buffer.from([2, 1, 0]), // milliseconds, lyrics, empty descriptor
    ...lyrics.synced!.map(({ timeMs, text }) => {
      if (!Number.isSafeInteger(timeMs) || timeMs < 0 || timeMs > 0xffffffff) {
        throw new Error('Invalid SYLT millisecond timestamp');
      }
      if (text.includes('\0')) throw new Error('NUL in SYLT text');
      const time = Buffer.alloc(4);
      time.writeUInt32BE(timeMs);
      return Buffer.concat([Buffer.from(text), Buffer.from([0]), time]);
    }),
  ]);
}

async function editCopy(path: string, change: TagChange) {
  using file = await (await taglib()).open(path);
  if (change.picture) {
    // Legacy Vorbis art is a text property; replace it alongside PICTURE.
    for (const key of ['COVERART', 'COVERARTMIME']) file.removeProperty(key);
    file.setPictures([{
      data: change.picture.bytes,
      mimeType: change.picture.mime,
      type: 'FrontCover',
      description: '',
    }]);
  }
  if (change.lyrics) {
    const lyrics = change.lyrics;
    if (file.getFormat() === 'MP3') {
      // setLyrics() is text-only in 2.4.0: raw USLT retains the language.
      file.setId3v2Frames('USLT', [Buffer.concat([
        Buffer.from([3]),
        Buffer.from(language(lyrics)),
        Buffer.from([0]),
        Buffer.from(lyrics.text),
      ])]);
      file.setId3v2Frames('SYLT', lyrics.synced ? [syncBody(lyrics)] : []);
    } else file.setLyrics([{ text: lyrics.text }]);
  }
  await file.saveToFile();
}

function verifyRequested(
  meta: IAudioMetadata,
  change: TagChange,
  mp3: boolean,
) {
  if (change.picture) {
    const pictures = meta.common.picture;
    if (
      pictures?.length !== 1 ||
      !isDeepStrictEqual(pictures[0].data, change.picture.bytes) ||
      pictures[0].format !== change.picture.mime
    ) throw new Error('Tag write did not embed the exact chosen picture');
  }
  if (!change.lyrics) return;
  const lyrics = change.lyrics;
  const tags = Object.values(meta.native).flat().filter((tag) =>
    lyricsKey.test(tag.id)
  );
  const textTags = tags.filter((tag) => tag.id !== 'SYLT');
  const value = textTags[0]?.value as string | ILyricsTag | undefined;
  if (
    textTags.length !== 1 ||
    (typeof value === 'string' ? value : value?.text) !== lyrics.text ||
    (mp3 && (value as ILyricsTag)?.language !== language(lyrics))
  ) throw new Error('Tag write did not embed the exact chosen lyrics');
  if (mp3) {
    const synced = tags.filter((tag) => tag.id === 'SYLT');
    const value = synced[0]?.value as ILyricsTag | undefined;
    if (
      synced.length !== (lyrics.synced ? 1 : 0) ||
      (lyrics.synced && (
        value?.language !== language(lyrics) || value?.timeStampFormat !== 2 ||
        value?.contentType !== 1 ||
        !isDeepStrictEqual(
          value?.syncText,
          lyrics.synced.map((part) => ({
            text: part.text,
            timestamp: part.timeMs,
          })),
        )
      ))
    ) throw new Error('Tag write did not embed the exact chosen SYLT');
  }
}

/** A replaceable copy editor permits failure injection without bypassing the
 * writer's verification/publication owner. Production always uses TagLib. */
export function createTagWriter(options: { editCopy?: typeof editCopy } = {}) {
  const edit = options.editCopy ?? editCopy;
  return async (
    input: string,
    change: TagChange,
    signal?: AbortSignal,
  ): Promise<void> => {
    const path = resolve(input);
    signal?.throwIfAborted();
    const stat = await Deno.lstat(path);
    if (!stat.isFile || stat.isSymlink) {
      throw new Error('Tag target is not a regular file');
    }
    await access(path, constants.W_OK);
    const beforeMeta = await parseFile(path);
    const beforeProperties = await properties(path, change);
    const media = createMedia();
    const beforeFingerprint = await media.fingerprint(path);
    if (!beforeFingerprint.fingerprint) throw new Error('No afp/1 fingerprint');
    const mp3 = beforeProperties.format === 'MP3';
    const trailer = mp3 ? await id3v1(path) : undefined;
    const temporary = await Deno.makeTempFile({
      dir: dirname(path),
      prefix: '.tags-',
    });
    try {
      await Deno.copyFile(path, temporary);
      await Deno.chmod(temporary, 0o600);
      // The WASI snapshot merges v1 fallback fields into its property map and
      // writes them into v2 even for a picture-only edit. Hide the archived v1
      // trailer from that snapshot; restore its exact bytes after the save.
      if (trailer) await restoreId3v1(temporary, new Uint8Array());
      signal?.throwIfAborted();
      await edit(temporary, change);
      if (trailer) await restoreId3v1(temporary, trailer);
      signal?.throwIfAborted();
      if (
        !isDeepStrictEqual(
          await media.fingerprint(temporary),
          beforeFingerprint,
        )
      ) {
        throw new Error('Tag write changed afp/1 fingerprint');
      }
      const afterMeta = await parseFile(temporary);
      if (
        !isDeepStrictEqual(
          await properties(temporary, change),
          beforeProperties,
        ) ||
        !isDeepStrictEqual(
          unchangedTagFacts(afterMeta, change),
          unchangedTagFacts(beforeMeta, change),
        )
      ) throw new Error('Tag write changed an unrelated tag');
      verifyRequested(afterMeta, change, mp3);
      signal?.throwIfAborted();
      if (
        !isDeepStrictEqual(signature(await Deno.lstat(path)), signature(stat))
      ) {
        throw new Error('Track changed during tag write');
      }
      await access(path, constants.W_OK);
      await Deno.chmod(temporary, stat.mode! & 0o777);
      {
        using file = await Deno.open(temporary, { read: true });
        await file.sync();
      }
      await Deno.rename(temporary, path);
    } finally {
      await Deno.remove(temporary).catch((error) => {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      });
    }
  };
}

export const writeTags = createTagWriter();
