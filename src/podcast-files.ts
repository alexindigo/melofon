// Only this core owner constructs, reads or removes podcast filesystem paths.
// Persisted paths and feed text are never authority to touch arbitrary files.
import { basename, join, resolve } from 'node:path';
import { readImage } from './images.ts';
import type { ReadArtworkSource } from './artwork-sources.ts';

const id = (value: string, prefix: string) => {
  if (!new RegExp(`^${prefix}-[a-f0-9-]{36}$`).test(value)) {
    throw new Error('Invalid podcast id');
  }
  return value;
};
const missing = (error: unknown) => error instanceof Deno.errors.NotFound;
export function createPodcastFiles(dataDir: string) {
  const root = resolve(dataDir, 'podcasts');
  async function directory(channelId: string, create = false) {
    const path = join(root, id(channelId, 'podcast'));
    if (create) await Deno.mkdir(dataDir, { recursive: true });
    for (const part of [root, path]) {
      try {
        if (create) await Deno.mkdir(part);
      } catch (error) {
        if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
      }
      const stat = await Deno.lstat(part);
      if (!stat.isDirectory || stat.isSymlink) {
        throw new Error('Unsafe podcast directory');
      }
    }
    return path;
  }
  async function remove(path: string) {
    try {
      await Deno.remove(path);
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
  function ownedName(episodeId: string, name: string) {
    id(episodeId, 'episode');
    return name.startsWith(`${episodeId}.`) && /^[a-z0-9.-]+$/.test(name) &&
      !name.includes('..');
  }
  return {
    async path(channelId: string, episodeId: string, extension: string) {
      id(episodeId, 'episode');
      if (!/^[a-z0-9]+$/.test(extension)) {
        throw new Error('Invalid podcast extension');
      }
      return join(
        await directory(channelId, true),
        `${episodeId}.${extension}`,
      );
    },
    async cleanup(channelId: string, episodeId: string) {
      let dir: string;
      try {
        dir = await directory(channelId);
      } catch (error) {
        if (missing(error)) return;
        throw error;
      }
      for await (const entry of Deno.readDir(dir)) {
        if (
          ownedName(episodeId, entry.name) &&
          (entry.name.endsWith('.part') || entry.name.endsWith('.download'))
        ) {
          await remove(join(dir, entry.name));
        }
      }
    },
    async episodePath(
      channelId: string,
      episodeId: string,
      path: string | null,
    ) {
      if (!path || !ownedName(episodeId, basename(path))) return null;
      try {
        const dir = await directory(channelId);
        if (path !== join(dir, basename(path))) return null;
        const stat = await Deno.lstat(path);
        return stat.isFile && !stat.isSymlink ? path : null;
      } catch (error) {
        if (missing(error)) return null;
        throw error;
      }
    },
    async deleteEpisode(
      channelId: string,
      episodeId: string,
      path: string | null,
    ) {
      // A malicious/stale persisted reference cannot delete outside this owner.
      if (path && ownedName(episodeId, basename(path))) {
        try {
          const dir = await directory(channelId);
          if (path === join(dir, basename(path))) await remove(path);
        } catch (error) {
          if (!missing(error)) throw error;
        }
      }
      await this.cleanup(channelId, episodeId);
    },
    async deleteChannel(channelId: string) {
      try {
        await Deno.remove(await directory(channelId), { recursive: true });
      } catch (error) {
        if (!missing(error)) throw error;
      }
    },
    async saveImage(channelId: string, bytes: Uint8Array, extension: string) {
      if (!['png', 'jpg', 'gif', 'webp'].includes(extension)) {
        throw new Error('Invalid podcast image');
      }
      const dir = await directory(channelId, true);
      const path = join(dir, `cover.${extension}`);
      const temporary = join(dir, `cover.${crypto.randomUUID()}.part`);
      try {
        await Deno.writeFile(temporary, bytes, { createNew: true });
        await Deno.rename(temporary, path);
      } finally {
        await remove(temporary);
      }
      return path;
    },
    async image(
      channelId: string,
      path: string | null,
      maxBytes: number,
      read?: ReadArtworkSource,
    ) {
      if (!path || !/^cover\.(png|jpg|gif|webp)$/.test(basename(path))) {
        return null;
      }
      try {
        if (path !== join(await directory(channelId), basename(path))) {
          return null;
        }
        if ((await Deno.lstat(path)).isSymlink) return null;
        const load = async () => {
          const bytes = await readImage(path, maxBytes);
          return bytes
            ? {
              bytes,
              format: `image/${
                path.endsWith('.jpg') ? 'jpeg' : path.split('.').pop()
              }`,
            }
            : null;
        };
        return read ? await read(path, 'image-v1', load) : await load();
      } catch (error) {
        if (missing(error)) return null;
        throw error;
      }
    },
  };
}
