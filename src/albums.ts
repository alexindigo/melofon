// Album membership is a fact of the whole scan, after song identity resolution.
// This module is deterministic and has no filesystem or store dependencies.
import { encodeHex } from '@std/encoding/hex';

export type ArtistKind = 'tagged' | 'shared' | 'various' | 'unknown';
export interface AlbumInput {
  songId: string;
  libraryId: string;
  rel: string;
  albumName: string | null;
  albumArtistTag: string | null;
  trackArtist: string | null;
  disc: number | null;
}
export interface AlbumIdentity {
  id: string;
  libraryId: string;
  rootDir: string;
}
export interface Album extends AlbumIdentity {
  name: string | null;
  albumArtistId: string | null;
  artistName: string | null;
  artistKind: ArtistKind;
  folderName: string;
}
export interface AlbumEvent {
  kind: 'moved' | 'unlinked';
  albumId: string;
  from?: AlbumIdentity;
  to?: AlbumIdentity;
  candidates?: string[];
}
export interface AlbumGrouping {
  albums: Album[];
  fileAlbums: Map<string, string>;
  identities: AlbumIdentity[];
  events: AlbumEvent[];
}

export async function stableId(kind: string, key: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${kind}\n${key}`),
  );
  return encodeHex(new Uint8Array(digest)).slice(0, 32);
}
const parent = (path: string) =>
  path.slice(0, Math.max(0, path.lastIndexOf('/')));
const base = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const keyFor = (file: AlbumInput, dir: string) =>
  JSON.stringify([file.libraryId, dir, file.albumName, file.albumArtistTag]);
const codecs = new Set(
  'mp3 flac aac m4a alac ogg vorbis opus wav aiff ape wv wavpack dsd dsf dff'
    .split(' '),
);
const formatWords = new Set([
  ...codecs,
  ...'lossless lossy hi res hires cbr vbr v0 v1 v2 bit khz kbps'.split(' '),
]);
export function isAlbumFolderHint(name: string): boolean {
  if (
    /^(dis[ck]|cd|cassette|digital[\s_-]*media|vinyl|vol(ume)?|part|act|side)[\W_]*\d+(\b.*)?$/i
      .test(name)
  ) return true;
  const tokens = name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return tokens.every((t) =>
    formatWords.has(t) || /^\d+$/.test(t) || /^\d+(bit|khz|kbps|k)$/.test(t)
  ) &&
    tokens.some((t) => codecs.has(t) || /^\d+(bit|khz|kbps)$/.test(t));
}
function strictBest<K>(counts: Map<K, number>): K | undefined {
  let best: K | undefined;
  let maximum = 0;
  for (const [key, count] of counts) {
    if (count > maximum) {
      maximum = count;
      best = key;
    } else if (count === maximum) best = undefined;
  }
  return best;
}

export async function groupAlbums(
  files: readonly AlbumInput[],
  libraries: readonly { id: string; name: string }[],
  previous: ReadonlyMap<string, string | null>,
  retained: readonly AlbumIdentity[],
): Promise<AlbumGrouping> {
  const names = new Map(libraries.map((l) => [l.id, l.name]));
  const parts = new Map<string, { dir: string; files: AlbumInput[] }>();
  for (const file of files) {
    const dir = parent(file.rel), key = keyFor(file, dir);
    const part = parts.get(key) ?? { dir, files: [] };
    part.files.push(file);
    parts.set(key, part);
  }
  const siblings = new Map<string, { dir: string; files: AlbumInput[] }[]>();
  const groups: { root: string; files: AlbumInput[]; merged: boolean }[] = [];
  for (const part of parts.values()) {
    if (part.dir === '') {
      groups.push({ root: '', files: part.files, merged: false });
      continue;
    }
    const key = keyFor(part.files[0], parent(part.dir));
    const list = siblings.get(key) ?? [];
    list.push(part);
    siblings.set(key, list);
  }
  for (const list of siblings.values()) {
    const seen = new Set<number>();
    let merge = list.length > 1;
    for (const part of list) {
      const discs = new Set(part.files.map((f) => f.disc));
      for (const disc of discs) {
        if (disc === null || seen.has(disc)) merge = false;
        else seen.add(disc);
      }
    }
    if (merge) {
      groups.push({
        root: parent(list[0].dir),
        files: list.flatMap((p) => p.files),
        merged: true,
      });
    } else {
      for (const part of list) {
        groups.push({ root: part.dir, files: part.files, merged: false });
      }
    }
  }
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  groups.sort((a, b) =>
    compare(keyFor(a.files[0], a.root), keyFor(b.files[0], b.root)) ||
    compare(
      a.files.map((f) => f.songId).sort()[0],
      b.files.map((f) => f.songId).sort()[0],
    )
  );
  const counts = groups.map((g) => {
    const counts = new Map<string, number>();
    for (const f of g.files) {
      const prev = previous.get(f.songId);
      if (prev != null) counts.set(prev, (counts.get(prev) ?? 0) + 1);
    }
    return counts;
  });
  const inverse = new Map<string, Map<number, number>>();
  counts.forEach((counts, index) => {
    for (const [id, n] of counts) {
      const matches = inverse.get(id) ?? new Map<number, number>();
      matches.set(index, n);
      inverse.set(id, matches);
    }
  });
  const retainedById = new Map(retained.map((row) => [row.id, row]));
  const reserved = new Set(
    [...retainedById.keys(), ...previous.values()].filter((id): id is string =>
      id !== null
    ),
  );
  const result: AlbumGrouping = {
    albums: [],
    fileAlbums: new Map(),
    identities: [],
    events: [],
  };
  const kept = new Set<string>();
  for (const [index, group] of groups.entries()) {
    const sample = group.files[0], key = keyFor(sample, group.root);
    const candidate = strictBest(counts[index]);
    const keeps = candidate !== undefined &&
      strictBest(inverse.get(candidate)!) === index;
    let id: string;
    if (keeps) {
      id = candidate!;
      kept.add(id);
    } else {
      id = await stableId('album', key);
      for (let n = 1; reserved.has(id); n++) {
        id = await stableId('album', `${key}\n${n}`);
      }
    }
    reserved.add(id);
    const identity = { id, libraryId: sample.libraryId, rootDir: group.root };
    result.identities.push(identity);
    const before = retainedById.get(id);
    if (
      keeps && before &&
      (before.libraryId !== identity.libraryId ||
        before.rootDir !== identity.rootDir)
    ) {
      result.events.push({
        kind: 'moved',
        albumId: id,
        from: before,
        to: identity,
      });
    }
    const performers = new Set(
      group.files.map((f) => f.trackArtist).filter((n): n is string =>
        n !== null
      ),
    );
    const artistKind: ArtistKind = sample.albumArtistTag !== null
      ? 'tagged'
      : performers.size === 1
      ? 'shared'
      : performers.size > 1
      ? 'various'
      : 'unknown';
    const artistName = sample.albumArtistTag ??
      (performers.size === 1 ? [...performers][0] : null);
    const displayDir = !group.merged && isAlbumFolderHint(base(group.root))
      ? parent(group.root)
      : group.root;
    const folderName = displayDir === ''
      ? names.get(sample.libraryId)!
      : base(displayDir);
    result.albums.push({
      ...identity,
      name: sample.albumName,
      artistKind,
      artistName,
      albumArtistId: artistName === null
        ? null
        : await stableId('artist', artistName),
      folderName,
    });
    for (
      const file of [...group.files].sort((a, b) => compare(a.songId, b.songId))
    ) result.fileAlbums.set(file.songId, id);
  }
  for (const id of [...inverse.keys()].sort()) {
    if (!kept.has(id)) {
      result.events.push({
        kind: 'unlinked',
        albumId: id,
        candidates: [
          ...new Set(
            [...inverse.get(id)!.keys()].map((index) =>
              result.albums[index].id
            ),
          ),
        ].sort(),
      });
    }
  }
  return result;
}
