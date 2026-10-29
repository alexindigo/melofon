import type { Store } from './store/index.ts';
import type { FolderPageOptions } from './store/folders.ts';
import { LibraryError } from './library-errors.ts';
export type {
  FolderPageOptions,
  FolderPages,
  FolderRow,
} from './store/folders.ts';

/** A folder is addressed by source id and canonical library-relative path.
 * Never normalize traversal into a different successful request. */
export function createFolders(store: Store) {
  return {
    browse(options: FolderPageOptions) {
      const path = options.path ?? '';
      if (
        typeof path !== 'string' || path.includes('\\') ||
        Array.from(path).some((c) =>
          c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127
        ) ||
        /^[a-z]:/i.test(path) ||
        (path !== '' &&
          path.split('/').some((part) =>
            !part || part === '.' || part === '..'
          )) ||
        (options.libraryId === undefined && path !== '')
      ) {
        throw new LibraryError('invalid_field', 'Invalid folder path');
      }
      for (const page of [options.folders, options.songs]) {
        if (
          !Number.isSafeInteger(page.offset) || page.offset < 0 ||
          !Number.isSafeInteger(page.limit) || page.limit < 1
        ) {
          throw new LibraryError('invalid_field', 'Invalid folder page');
        }
      }
      return store.folders.browse({ ...options, path });
    },
  };
}
