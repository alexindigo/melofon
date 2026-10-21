// Core owns image files and hashing. Store operations only receive references.
import { constants } from 'node:fs';
import { access, link, mkdir, open, stat, unlink } from 'node:fs/promises';
import type { LibraryRow } from './store/catalog.ts';
import type { IAudioMetadata, IPicture } from 'music-metadata';
import type { State } from './state.ts';

/** One download cap for lookup pictures and other core-owned remote images. */
export function declareImageDownload(state: Pick<State, 'declare'>) {
  state.declare('lookups.imageMaxMegabytes', {
    type: 'integer',
    default: 20,
    minimum: 1,
    maximum: 200,
  });
}

type ImageLibrary = Pick<LibraryRow, 'path'>;
export interface ImageReference {
  hash: string;
  ext: string;
}

/** One picture reader for scan, artwork and unifying. music-metadata exposes
 * deprecated Vorbis COVERART only as a native tag, not as common.picture. */
export function embeddedPictures(meta: IAudioMetadata): IPicture[] {
  const pictures = [...meta.common.picture ?? []];
  const native = Object.values(meta.native).flat();
  const mime = native.find((tag) => tag.id.toUpperCase() === 'COVERARTMIME')
    ?.value;
  for (const tag of native) {
    if (tag.id.toUpperCase() !== 'COVERART') continue;
    if (typeof tag.value !== 'string') throw new Error('Invalid legacy cover');
    const data = Uint8Array.from(
      atob(tag.value.replace(/\s/g, '')),
      (c) => c.charCodeAt(0),
    );
    let format = typeof mime === 'string' ? mime : undefined;
    if (!format) {
      if (data[0] === 0xff && data[1] === 0xd8) format = 'image/jpeg';
      else if (data[0] === 0x89 && data[1] === 0x50) format = 'image/png';
    }
    if (!data.length || !format || !/^image\/[a-z0-9]+$/i.test(format)) {
      throw new Error('Invalid legacy cover MIME or data');
    }
    pictures.push({ data, format });
  }
  return pictures;
}

export function isCoverFile(name: string): boolean {
  return /^cover\.(jpg|jpeg|png|webp)$/i.test(name);
}

export function isArtistFile(name: string): boolean {
  return /^artist\.(jpg|jpeg|png|webp)$/i.test(name);
}

/** Extension priority is explicit, independent of directory enumeration/case. */
export async function artistImagePaths(directory: string): Promise<string[]> {
  const names: string[] = [];
  try {
    for await (const entry of Deno.readDir(directory)) {
      if (entry.isFile && isArtistFile(entry.name)) names.push(entry.name);
    }
  } catch (error) {
    if (
      !(error instanceof Deno.errors.NotFound ||
        error instanceof Deno.errors.PermissionDenied)
    ) throw error;
  }
  const rank = (name: string) =>
    ['jpg', 'jpeg', 'png', 'webp'].indexOf(
      name.split('.').pop()!.toLowerCase(),
    );
  return names.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)).map((
    name,
  ) => `${directory}/${name}`);
}

export function imageExtension(format: string): string {
  const ext = format.toLowerCase().replace(/^image\//, '');
  if (!/^[a-z0-9]+$/.test(ext)) throw new Error('Invalid image extension');
  return ext === 'jpeg' ? 'jpg' : ext;
}

export function imageContentType(ext: string): string {
  return `image/${
    imageExtension(ext) === 'jpg' ? 'jpeg' : imageExtension(ext)
  }`;
}

export async function imageHash(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    bytes as Uint8Array<ArrayBuffer>,
  );
  return Array.from(
    new Uint8Array(digest),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
}

function imageDirectory(library: ImageLibrary): string {
  return `${library.path.replace(/\/+$/, '')}/.melofon/candidates`;
}

export function candidateImagePath(
  library: ImageLibrary,
  hash: string,
  ext: string,
): string {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid image hash');
  return `${imageDirectory(library)}/${hash}.${imageExtension(ext)}`;
}

function readOnly(error: unknown): boolean {
  return ['EACCES', 'EROFS'].includes((error as { code?: string }).code ?? '');
}

/** Probe actual write access, including an already-existing candidate folder. */
export async function libraryImagesWritable(
  library: ImageLibrary,
): Promise<boolean> {
  const probe = `${imageDirectory(library)}/.probe-${crypto.randomUUID()}`;
  try {
    // An old writable cache is not authority to write into a now-read-only root.
    await access(library.path, constants.W_OK);
    await mkdir(imageDirectory(library), { recursive: true });
    const file = await open(probe, 'wx', 0o600);
    await file.close();
    await unlink(probe);
    return true;
  } catch (error) {
    if (readOnly(error)) return false;
    throw error;
  }
}

/** Publish complete bytes atomically, without replacing an existing hash file. */
export async function writeCandidateImage(
  library: ImageLibrary,
  bytes: Uint8Array,
  ext: string,
): Promise<ImageReference | null> {
  const reference = { hash: await imageHash(bytes), ext: imageExtension(ext) };
  const path = candidateImagePath(library, reference.hash, reference.ext);
  if (!await libraryImagesWritable(library)) return null;
  try {
    await stat(path);
    return reference;
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') throw error;
  }
  const temporary = `${imageDirectory(library)}/.write-${crypto.randomUUID()}`;
  let created = false;
  try {
    const file = await open(temporary, 'wx', 0o600);
    created = true;
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await link(temporary, path);
    } catch (error) {
      if ((error as { code?: string }).code !== 'EEXIST') throw error;
    }
    return reference;
  } catch (error) {
    if (readOnly(error)) return null;
    throw error;
  } finally {
    if (created) await unlink(temporary);
  }
}

export async function readCandidateImage(
  library: ImageLibrary,
  hash: string,
  ext: string,
  maxBytes = Infinity,
): Promise<Uint8Array | null> {
  try {
    return await readImage(candidateImagePath(library, hash, ext), maxBytes);
  } catch (error) {
    if (readOnly(error) || (error as { code?: string }).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

/** Bound allocation and reads even if the file grows after stat. */
export async function readImage(
  path: string,
  maxBytes: number,
): Promise<Uint8Array | null> {
  using file = await Deno.open(path, { read: true });
  const stat = await file.stat();
  if (!stat.isFile || stat.size > maxBytes) return null;
  const bytes = new Uint8Array(stat.size);
  let at = 0;
  while (at < bytes.length) {
    const n = await file.read(bytes.subarray(at));
    if (n === null) return null;
    at += n;
  }
  if (await file.read(new Uint8Array(1)) !== null) return null;
  return bytes;
}
