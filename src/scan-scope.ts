import { isAbsolute, relative, resolve } from 'node:path';
import { LibraryError } from './library-errors.ts';

export interface ScanScope {
  libraries?: string[];
  folder?: { library: string; path: string };
}
/** A union is needed when queued folder requests are disjoint. Never widen it. */
export type ScanSelection = ScanScope & { scopes?: ScanScope[] };

export function mergeScanScopes(
  a: ScanSelection,
  b: ScanSelection,
): ScanSelection {
  const scopes = [...(a.scopes ?? [a]), ...(b.scopes ?? [b])];
  if (scopes.some((s) => !s.libraries && !s.folder)) return {};
  const libraries = [...new Set(scopes.flatMap((s) => s.libraries ?? []))]
    .sort();
  const folders = scopes.flatMap((s) => s.folder ? [s.folder] : [])
    .filter((f, i, all) =>
      !libraries.includes(f.library) &&
      !all.some((p, j) =>
        p.library === f.library && withinScanPath(f.path, p.path) &&
        (p.path !== f.path || j < i)
      )
    ).sort((x, y) =>
      x.library.localeCompare(y.library) || x.path.localeCompare(y.path)
    );
  const union: ScanScope[] = [
    ...(libraries.length ? [{ libraries }] : []),
    ...folders.map((folder) => ({ folder })),
  ];
  return union.length === 1 ? union[0] : { scopes: union };
}

export function scanTargets(scope: ScanSelection, sources: { id: string }[]) {
  const scopes = scope.scopes ?? [scope];
  return sources.flatMap((source) => {
    if (
      scopes.some((s) =>
        !s.folder && (!s.libraries || s.libraries.includes(source.id))
      )
    ) {
      return [{ library: source.id, path: '' }];
    }
    return scopes.flatMap((s) =>
      s.folder?.library === source.id ? [s.folder] : []
    );
  });
}
export interface ScanCoverage {
  libraries: string[];
  folder?: { library: string; path: string };
  targets?: { library: string; path: string }[];
  excluded: { library: string; path: string }[];
}
export const withinScanPath = (path: string, parent: string) =>
  parent === '' || path === parent || path.startsWith(`${parent}/`);

/** The same effective coverage governs deletion, retention and move eligibility. */
export function covered(coverage: ScanCoverage, library: string, path: string) {
  return coverage.libraries.includes(library) &&
    (!coverage.targets ||
      coverage.targets.some((t) =>
        t.library === library && withinScanPath(path, t.path)
      )) &&
    (!coverage.folder || (coverage.folder.library === library &&
      withinScanPath(path, coverage.folder.path))) &&
    !coverage.excluded.some((e) =>
      e.library === library && withinScanPath(path, e.path)
    );
}

export async function validateScanScope(
  input: ScanScope,
  sources: { id: string; path: string }[],
): Promise<ScanScope> {
  const invalid = () => {
    throw new LibraryError('invalid_field', 'Invalid scan scope');
  };
  const exists = (id: unknown) => {
    if (typeof id !== 'string' || !id) return invalid();
    const source = sources.find((s) => s.id === id);
    if (!source) throw new LibraryError('not_found', 'Library not found');
    return source;
  };
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return invalid();
  }
  if (input.libraries !== undefined && input.folder !== undefined) {
    return invalid();
  }
  if (input.libraries !== undefined) {
    if (!Array.isArray(input.libraries) || !input.libraries.length) {
      return invalid();
    }
    for (const id of input.libraries) exists(id);
    return { libraries: [...new Set(input.libraries)] };
  }
  if (input.folder !== undefined) {
    const folder = input.folder;
    if (
      !folder || typeof folder !== 'object' || Array.isArray(folder) ||
      Object.keys(folder).some((k) => !['library', 'path'].includes(k)) ||
      typeof folder.path !== 'string' || folder.path.includes('\0')
    ) return invalid();
    const source = exists(folder.library);
    const outside = () => {
      throw new LibraryError(
        'path_outside_library',
        'Folder is outside its library',
      );
    };
    if (isAbsolute(folder.path)) return outside();
    const rel = relative(source.path, resolve(source.path, folder.path));
    if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) {
      return outside();
    }
    if (rel.split('/').some((part) => part.startsWith('.'))) return invalid();
    try {
      const actual = await Deno.realPath(resolve(source.path, rel));
      const root = await Deno.realPath(source.path);
      const canonical = relative(root, actual);
      if (
        canonical === '..' || canonical.startsWith('../') ||
        isAbsolute(canonical)
      ) return outside();
      if (canonical.split('/').some((part) => part.startsWith('.'))) {
        return invalid();
      }
      if (!(await Deno.stat(actual)).isDirectory) return invalid();
      return { folder: { library: source.id, path: canonical } };
    } catch (error) {
      if (error instanceof LibraryError) throw error;
      if (error instanceof Deno.errors.NotFound) {
        throw new LibraryError('not_found', 'Folder not found');
      }
      // An unreadable existing folder is a valid scope: the scan records it.
      if (error instanceof Deno.errors.PermissionDenied) {
        return { folder: { library: source.id, path: rel } };
      }
      return invalid();
    }
  }
  return {};
}
