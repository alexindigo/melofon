export type LibraryErrorCode =
  | 'path_not_absolute'
  | 'path_not_found'
  | 'path_not_directory'
  | 'path_unreadable'
  | 'path_overlaps'
  | 'path_duplicate'
  | 'path_in_data_dir'
  | 'invalid_field'
  | 'not_found';

export class LibraryError extends Error {
  override name = 'LibraryError';
  constructor(public readonly code: LibraryErrorCode, message: string) {
    super(message);
  }
}

/** Internal optimistic-snapshot retry; never a protocol error. */
export class LibrarySourcesChanged extends Error {
  override name = 'LibrarySourcesChanged';
}
