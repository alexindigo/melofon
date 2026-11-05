// Core-only durable image backing. Keys, owners and persisted paths are never
// filesystem authority. Each publication owns a fresh file, never shared bytes.
import { join, resolve } from 'node:path';
import { open } from 'node:fs/promises';
import { imageHeader, withinPixels } from './image-header.ts';
import { readImage } from './images.ts';

interface Reference {
  file: string;
  contentType: string;
  byteLength: number;
}

/** Expected loss of readable source bytes, distinct from invalid references,
 * unsafe storage and unexpected I/O faults. Messages never expose core paths. */
export class ImageFileUnavailable extends Error {
  constructor(
    label: string,
    readonly reason: 'missing' | 'unreadable' | 'too_large' | 'incomplete',
  ) {
    super(`Cannot access ${label} storage`);
  }
}

const owned = (name: string) =>
  /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\.(image|part)$/.test(name);

function reference(payload: string): Reference {
  const ref = JSON.parse(payload);
  if (
    !ref || typeof ref.file !== 'string' || !owned(ref.file) ||
    !ref.file.endsWith('.image') ||
    !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(
      ref.contentType,
    ) ||
    !Number.isSafeInteger(ref.byteLength) || ref.byteLength <= 0
  ) throw new Error('Invalid hat image reference');
  return ref;
}

export function createImageFiles(
  dataDir: string,
  folder: string,
  label: string,
) {
  const root = resolve(dataDir, folder);
  async function safe<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof ImageFileUnavailable) throw error;
      // The scoped API must not leak core paths through filesystem errors.
      throw new Error(`Cannot access ${label} storage`);
    }
  }
  async function directory(create = false) {
    if (create) await Deno.mkdir(dataDir, { recursive: true });
    if (create) {
      try {
        await Deno.mkdir(root, { mode: 0o700 });
      } catch (error) {
        if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
      }
    }
    const stat = await Deno.lstat(root);
    if (!stat.isDirectory || stat.isSymlink) {
      throw new Error('Unsafe hat image directory');
    }
    return root;
  }
  async function remove(name: string) {
    if (!owned(name)) throw new Error('Invalid hat image file');
    try {
      // Unlink only the owned entry, never follow a persisted path or symlink.
      await Deno.remove(join(await directory(), name));
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  return {
    save(bytes: Uint8Array, maxBytes: number, maxPixels: number) {
      return safe(async () => {
        if (!(bytes instanceof Uint8Array) || bytes.byteLength > maxBytes) {
          throw new Error('Invalid or oversized hat image');
        }
        // Own the input before awaiting, so caller mutation cannot change it.
        bytes = bytes.slice();
        const header = imageHeader(bytes);
        if (!withinPixels(header, maxPixels)) {
          throw new Error('Invalid hat image');
        }
        const dir = await directory(true);
        const name = crypto.randomUUID();
        const temporary = `${name}.part`;
        const file = `${name}.image`;
        let published = false;
        try {
          const output = await open(join(dir, temporary), 'wx', 0o600);
          try {
            await output.writeFile(bytes);
            await output.sync();
          } finally {
            await output.close();
          }
          await Deno.rename(join(dir, temporary), join(dir, file));
          published = true;
          // The directory entry, as well as the bytes, precedes SQL publication.
          const parent = await open(dir, 'r');
          try {
            await parent.sync();
          } finally {
            await parent.close();
          }
          return JSON.stringify(
            {
              file,
              contentType: `image/${header.format}`,
              byteLength: bytes.byteLength,
            } satisfies Reference,
          );
        } catch (error) {
          if (published) await remove(file);
          throw error;
        } finally {
          await remove(temporary);
        }
      });
    },
    read(payload: string, maxBytes: number) {
      return safe(async () => {
        const ref = reference(payload);
        try {
          const path = join(await directory(), ref.file);
          const stat = await Deno.lstat(path);
          if (!stat.isFile || stat.isSymlink) {
            throw new Error('Invalid hat image file');
          }
          if (ref.byteLength > maxBytes) {
            throw new ImageFileUnavailable(label, 'too_large');
          }
          const value = await readImage(path, ref.byteLength);
          if (!value || value.byteLength !== ref.byteLength) {
            throw new ImageFileUnavailable(label, 'incomplete');
          }
          return { value, contentType: ref.contentType };
        } catch (error) {
          if (error instanceof Deno.errors.NotFound) {
            throw new ImageFileUnavailable(label, 'missing');
          }
          if (error instanceof Deno.errors.PermissionDenied) {
            throw new ImageFileUnavailable(label, 'unreadable');
          }
          throw error;
        }
      });
    },
    retire: (payload: string) => safe(() => remove(reference(payload).file)),
    prune(payloads: string[]) {
      return safe(async () => {
        // Parse all live references before deleting anything. Only unreferenced,
        // service-generated entries can be retired, including interrupted writes.
        const live = new Set(payloads.map((p) => reference(p).file));
        try {
          for await (const entry of Deno.readDir(await directory())) {
            if (entry.isFile && owned(entry.name) && !live.has(entry.name)) {
              await remove(entry.name);
            }
          }
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        }
      });
    },
  };
}
