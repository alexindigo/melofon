// Core owns image files and hashing. Store operations only receive references.
import { link, mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
import type { LibraryRow } from './store/catalog.ts';

type ImageLibrary = Pick<LibraryRow, 'path'>;
export interface ImageReference {
  hash: string;
  ext: string;
}

export function isCoverFile(name: string): boolean {
  return /^cover\.(jpg|jpeg|png|webp)$/i.test(name);
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
): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(
      await readFile(candidateImagePath(library, hash, ext)),
    );
  } catch (error) {
    if (readOnly(error) || (error as { code?: string }).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}
