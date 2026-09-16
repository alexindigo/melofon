// layers/opensubsonic/00-subsonic.ts — the opensubsonic hat's shared module:
// Subsonic envelope (ok/failed, XML+JSON), merged query+form params, the op
// dispatch table, and the hat's structural types. This file is a pathfinder
// middleware by filename grammar (the layer folder is the tree root — a plain
// `subsonic.ts` would silently compile as a `SUBSONIC /` route, and any other
// name is a build error). The default export is a no-op; the named exports
// are the module. See m1-scan-stream/plan-amendment-1.md.

export default () => {};

// --- Structural types (the hat is self-sufficient: no src/ imports) ----------

export interface StateUser {
  username: string;
  displayName: string;
}

export interface HatRequest {
  params: Record<string, string>;
  query: URLSearchParams;
  method: string;
  headers: Headers;
  body: {
    form(): Promise<FormData>;
  };
  _raw: Request;
}

export interface HatContext {
  app: {
    cfg: {
      version?: string;
    };
    user: {
      auth(username: string, password: string): Promise<StateUser | null>;
      authMd5(
        username: string,
        token: string,
        salt: string,
      ): Promise<StateUser | null>;
    };
    libraries: {
      list(): Promise<LibraryFolderRow[]>;
    };
    scan: {
      status(): Promise<ScanStatusRow>;
      /** Background scan; resolves when done (the op does not await it). */
      start(): Promise<void>;
    };
    library: {
      listArtists(folderId?: string): Promise<ArtistRow[]>;
      getArtist(id: string): Promise<ArtistRow | null>;
      albumsByArtist(artistId: string): Promise<AlbumRow[]>;
      listAlbums(opts: {
        sort:
          | 'name'
          | 'artist'
          | 'random'
          | 'newest'
          | 'starred'
          | 'highest'
          | 'frequent'
          | 'recent'
          | 'genre';
        size: number;
        offset: number;
        folderId?: string;
        genre?: string;
        username?: string;
      }): Promise<AlbumRow[]>;
      getAlbum(
        id: string,
      ): Promise<{ album: AlbumRow; songs: SongRow[] } | null>;
      getSong(id: string): Promise<SongRow | null>;
      search3(
        query: string,
        opts: {
          artistCount: number;
          artistOffset: number;
          albumCount: number;
          albumOffset: number;
          songCount: number;
          songOffset: number;
          folderId?: string;
        },
      ): Promise<
        { artists: ArtistRow[]; albums: AlbumRow[]; songs: SongRow[] }
      >;
      /** Absolute path of a song's audio file (null when unknown). */
      songPath(id: string): Promise<string | null>;
      /** Random songs from the catalog (getRandomSongs pull-forward). */
      randomSongs(size: number, folderId?: string): Promise<SongRow[]>;
      listGenres(): Promise<GenreRow[]>;
      songsByGenre(
        genre: string,
        opts: { size: number; offset: number; folderId?: string },
      ): Promise<SongRow[]>;
      lyrics(query: {
        artist?: string;
        title?: string;
      }): Promise<LyricsRow | null>;
    };
    annotation: {
      star(
        username: string,
        targetId: string,
        targetType: string,
      ): Promise<void>;
      unstar(
        username: string,
        targetId: string,
        targetType: string,
      ): Promise<void>;
      /** Subsonic 1..5; 0 clears. */
      setRating(
        username: string,
        targetId: string,
        rating: number,
      ): Promise<void>;
      starred(username: string): Promise<StarredRow[]>;
    };
    listens: {
      record(
        username: string,
        trackId: string,
        opts: {
          source: string;
          playedAtMs?: number;
          durationMs?: number;
        },
      ): Promise<void>;
    };
    playlists: {
      list(username: string): Promise<PlaylistRow[]>;
      get(username: string, id: string): Promise<PlaylistWithTracks | null>;
      create(
        username: string,
        name: string,
        trackIds: string[],
      ): Promise<PlaylistWithTracks>;
      setTracks(
        username: string,
        id: string,
        trackIds: string[],
      ): Promise<PlaylistWithTracks | null>;
      update(
        username: string,
        id: string,
        opts: {
          name?: string;
          comment?: string;
          addTrackIds?: string[];
          removeAtPositions?: number[];
        },
      ): Promise<PlaylistWithTracks | null>;
      delete(username: string, id: string): Promise<boolean>;
    };
    clientQueue: {
      get(username: string): Promise<PlayQueueRow | null>;
      save(
        username: string,
        queue: {
          trackIds: string[];
          currentId?: string;
          positionMs?: number;
        },
      ): Promise<void>;
    };
    bookmarks: {
      list(username: string): Promise<BookmarkRow[]>;
      set(
        username: string,
        trackId: string,
        positionMs: number,
        comment?: string,
      ): Promise<void>;
      remove(username: string, trackId: string): Promise<void>;
    };
    stream: {
      file(request: Request, path: string): Promise<Response>;
    };
    artwork: {
      cover(id: string): Promise<Response>;
      placeholder(): Response;
    };
  };
  state: {
    user?: StateUser;
    params?: URLSearchParams;
  };
}

// Domain rows, declared structurally (the hat does not import src/).
export interface LibraryFolderRow {
  id: string;
  name: string;
  path: string;
}

export interface ArtistRow {
  id: string;
  name: string;
  albumCount: number;
}

export interface AlbumRow {
  id: string;
  name: string;
  artistId: string;
  artistName: string;
  songCount: number;
  durationMs: number;
}

export interface SongRow {
  id: string;
  path: string;
  libraryId: string | null;
  libraryPath: string | null;
  title: string;
  albumId: string | null;
  albumName: string | null;
  artistId: string | null;
  artistName: string | null;
  track: number | null;
  disc: number | null;
  durationMs: number | null;
  size: number | null;
  genre: string | null;
  suffix: string;
  contentType: string;
}

export interface GenreRow {
  name: string;
  songCount: number;
  albumCount: number;
}

export interface StarredRow {
  targetId: string;
  targetType: string; // 'song' | 'album' | 'artist'
  starredAtMs: number; // epoch milliseconds
}

export interface PlaylistRow {
  id: string;
  name: string;
  comment: string | null;
  createdAtMs: number;
  changedAtMs: number;
  songCount: number;
  durationMs: number;
}

export interface PlaylistWithTracks extends PlaylistRow {
  trackIds: string[];
}

export interface PlayQueueRow {
  trackIds: string[];
  currentId: string | null;
  positionMs: number | null;
  changedAtMs: number;
}

export interface ScanStatusRow {
  scanning: boolean;
  count: number;
  folderCount: number;
  lastScanMs: number | null;
}

export interface BookmarkRow {
  trackId: string;
  positionMs: number;
  comment: string | null;
  createdAtMs: number;
  changedAtMs: number;
}

export interface LyricsRow {
  artist: string | null;
  title: string | null;
  text: string;
}

// --- Params ------------------------------------------------------------------

// Merged request params, Navidrome's postFormToQueryParams model: form body
// first (wins), query string appended after. Credentials and op args arrive
// identically via GET query or POST form.
export async function params(request: HatRequest): Promise<URLSearchParams> {
  const merged = new URLSearchParams();
  if (request.method === 'POST') {
    const contentType = request.headers.get('content-type') ?? '';
    if (contentType.startsWith('application/x-www-form-urlencoded')) {
      const form = await request.body.form();
      for (const [key, value] of form) {
        if (typeof value === 'string') merged.append(key, value);
      }
    }
  }
  for (const [key, value] of request.query) merged.append(key, value);
  return merged;
}

// `op` arrives without `.view` when the #op.view pattern matched, but the
// bare #op pattern captures the whole segment — which pattern wins depends on
// route registration order (pathfinder's fs walk is unsorted). Normalizing
// here makes dispatch correct under either order.
export function normalizeOp(op: string): string {
  return op.endsWith('.view') ? op.slice(0, -'.view'.length) : op;
}

// --- Envelope ----------------------------------------------------------------

const API_VERSION = '1.16.1';

function base(context: HatContext): Record<string, unknown> {
  return {
    status: 'ok',
    version: API_VERSION,
    type: 'melofon',
    serverVersion: context.app.cfg.version ?? '0.0.0-dev',
    openSubsonic: true,
  };
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' ||
    typeof value === 'boolean';
}

// Subsonic XML convention: objects are elements, scalar fields are
// attributes, arrays repeat the key as the item element (`index`, `artist`,
// `album`, `song` all name their items after the key). One exception: a
// scalar `value` key is mixed content — the element's text, not an attribute
// (genre, lyrics).
function xmlElement(tag: string, value: unknown): string {
  if (Array.isArray(value)) {
    return value.map((item) => xmlElement(tag, item)).join('');
  }
  if (isScalar(value)) {
    return `<${tag}>${escapeXml(String(value))}</${tag}>`;
  }
  const obj = value as Record<string, unknown>;
  let attrs = '';
  let children = '';
  let text: string | null = null;
  for (const [key, val] of Object.entries(obj)) {
    if (val === null || val === undefined) continue;
    if (key === 'value' && isScalar(val)) {
      text = String(val);
      continue;
    }
    if (isScalar(val)) attrs += ` ${key}="${escapeXml(String(val))}"`;
    else children += xmlElement(key, val);
  }
  const inner = children + (text === null ? '' : escapeXml(text));
  return inner === ''
    ? `<${tag}${attrs}/>`
    : `<${tag}${attrs}>${inner}</${tag}>`;
}

function render(
  context: HatContext,
  envelope: Record<string, unknown>,
  status: number,
): Response {
  const f = context.state.params?.get('f') ?? 'xml';
  if (f === 'json') {
    return Response.json({ 'subsonic-response': envelope }, { status });
  }
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n${
    xmlElement('subsonic-response', envelope)
  }`;
  return new Response(xml, {
    status,
    headers: { 'content-type': 'application/xml; charset=utf-8' },
  });
}

export function okResponse(
  context: HatContext,
  payload: Record<string, unknown>,
): Response {
  return render(context, { ...base(context), ...payload }, 200);
}

// Subsonic errors ship in the envelope, Navidrome-style: HTTP 200 with
// status="failed" (auth failures, missing params). Outcome pages (404/500)
// pass their own HTTP status.
export function failResponse(
  context: HatContext,
  code: number,
  message: string,
  status = 200,
): Response {
  return render(
    context,
    { ...base(context), status: 'failed', error: { code, message } },
    status,
  );
}

export function hexDecode(hex: string): string {
  if (!/^([0-9a-fA-F]{2})*$/.test(hex)) throw new Error('bad hex');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return new TextDecoder().decode(bytes);
}

// --- ID3 payload mapping -------------------------------------------------------

const IGNORED_ARTICLES = 'The El La Los Las Le Les';

function artistId3Of(artist: ArtistRow): Record<string, unknown> {
  return {
    id: artist.id,
    name: artist.name,
    albumCount: artist.albumCount,
  };
}

function albumId3Of(album: AlbumRow): Record<string, unknown> {
  return {
    id: album.id,
    name: album.name,
    artist: album.artistName,
    artistId: album.artistId,
    coverArt: album.id, // getCoverArt resolves album IDs
    songCount: album.songCount,
    duration: Math.round(album.durationMs / 1000),
  };
}

// Pre-ID3 album shape (getAlbumList / search2): the ID3 fields plus the
// legacy duplicates old clients read.
function albumV1Of(album: AlbumRow): Record<string, unknown> {
  return {
    ...albumId3Of(album),
    album: album.name,
    title: album.name,
    isDir: true,
  };
}

// The wire `path` is relative to the song's own source root — the simulated
// Navidrome tree ("Artist/Album/01 - Song.mp3"), never the absolute path.
function childOf(song: SongRow): Record<string, unknown> {
  const root = song.libraryPath;
  const path = root !== null && song.path.startsWith(root)
    ? song.path.slice(root.length).replace(/^\/+/, '')
    : song.path;
  return {
    id: song.id,
    isDir: false,
    title: song.title,
    album: song.albumName ?? undefined,
    artist: song.artistName ?? undefined,
    track: song.track ?? undefined,
    coverArt: song.albumId ?? undefined,
    size: song.size ?? undefined,
    contentType: song.contentType,
    suffix: song.suffix,
    duration: song.durationMs === null
      ? undefined
      : Math.round(song.durationMs / 1000),
    genre: song.genre ?? undefined,
    path,
    albumId: song.albumId ?? undefined,
    artistId: song.artistId ?? undefined,
    type: 'music',
    isVideo: false,
  };
}

function intParam(
  params: URLSearchParams,
  name: string,
  fallback: number,
): number {
  const raw = params.get(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) return fallback;
  return value;
}

// getAlbumList/getAlbumList2 share the type table. byYear is the only
// documented type without data behind it (no year tag in the catalog) — it
// gets the same clean "not implemented" envelope as unknown types.
const ALBUM_LIST_SORTS: Record<
  string,
  | 'name'
  | 'artist'
  | 'random'
  | 'newest'
  | 'starred'
  | 'highest'
  | 'frequent'
  | 'recent'
  | 'genre'
> = {
  alphabeticalByName: 'name',
  alphabeticalByArtist: 'artist',
  random: 'random',
  newest: 'newest',
  starred: 'starred',
  highest: 'highest',
  frequent: 'frequent',
  recent: 'recent',
  byGenre: 'genre',
};

async function albumListAlbums(
  context: HatContext,
): Promise<AlbumRow[] | Response> {
  const params = context.state.params!;
  const type = requiredParam(context, 'type');
  if (type instanceof Response) return type;
  const sort = ALBUM_LIST_SORTS[type];
  if (sort === undefined) {
    return failResponse(context, 0, `album list type not implemented: ${type}`);
  }
  const opts: Parameters<HatContext['app']['library']['listAlbums']>[0] = {
    sort,
    size: intParam(params, 'size', 10),
    offset: intParam(params, 'offset', 0),
    folderId: params.get('musicFolderId') ?? undefined,
    username: context.state.user!.username,
  };
  if (sort === 'genre') {
    const genre = requiredParam(context, 'genre');
    if (genre instanceof Response) return genre;
    opts.genre = genre;
  }
  return await context.app.library.listAlbums(opts);
}

// Subsonic playlist payload. No coverArt: getCoverArt does not resolve
// playlist IDs in M2. `public` is always false (single-household server).
function playlistOf(
  playlist: PlaylistRow,
  owner: string,
): Record<string, unknown> {
  return {
    id: playlist.id,
    name: playlist.name,
    comment: playlist.comment ?? undefined,
    owner,
    public: false,
    songCount: playlist.songCount,
    duration: Math.round(playlist.durationMs / 1000),
    created: new Date(playlist.createdAtMs).toISOString(),
    changed: new Date(playlist.changedAtMs).toISOString(),
  };
}

async function entriesFor(
  context: HatContext,
  trackIds: string[],
): Promise<Record<string, unknown>[]> {
  const entries: Record<string, unknown>[] = [];
  for (const trackId of trackIds) {
    const song = await context.app.library.getSong(trackId);
    if (song !== null) {
      entries.push(childOf(song));
    }
  }
  return entries;
}

function indexName(name: string): string {
  const ch = name.charAt(0).toUpperCase();
  return ch >= 'A' && ch <= 'Z' ? ch : '#';
}

// --- Op dispatch ---------------------------------------------------------------

// Handlers return a payload object (wrapped in the ok envelope) or a Response
// (an already-rendered failure).
type OpHandler = (
  request: HatRequest,
  context: HatContext,
) =>
  | Record<string, unknown>
  | Response
  | Promise<Record<string, unknown> | Response>;

function requiredParam(
  context: HatContext,
  name: string,
): string | Response {
  const value = context.state.params?.get(name);
  if (value === null || value === undefined || value === '') {
    return failResponse(context, 10, 'Required parameter is missing');
  }
  return value;
}

function notFound(context: HatContext): Response {
  return failResponse(context, 70, 'The requested data was not found');
}

async function scanStatusOf(
  context: HatContext,
): Promise<Record<string, unknown>> {
  const s = await context.app.scan.status();
  return {
    scanning: s.scanning,
    count: s.count,
    folderCount: s.folderCount,
    lastScan: s.lastScanMs === null
      ? undefined
      : new Date(s.lastScanMs).toISOString(),
  };
}

const OPS: Record<string, OpHandler> = {
  ping: () => ({}),
  getLicense: () => ({ license: { valid: true } }),
  getMusicFolders: async (_request, context) => {
    const folders = await context.app.libraries.list();
    return {
      musicFolders: {
        musicFolder: folders.map((f) => ({ id: f.id, name: f.name })),
      },
    };
  },
  getOpenSubsonicExtensions: () => ({
    openSubsonicExtensions: { openSubsonicExtension: [] },
  }),

  getArtists: async (_request, context) => {
    const folderId = context.state.params!.get('musicFolderId') ?? undefined;
    const artists = await context.app.library.listArtists(folderId);
    const byIndex = new Map<string, Record<string, unknown>[]>();
    for (const artist of artists) {
      const name = indexName(artist.name);
      const list = byIndex.get(name) ?? [];
      list.push(artistId3Of(artist));
      byIndex.set(name, list);
    }
    const names = [...byIndex.keys()].sort((a, b) =>
      a === '#' ? -1 : b === '#' ? 1 : a.localeCompare(b)
    );
    return {
      artists: {
        ignoredArticles: IGNORED_ARTICLES,
        index: names.map((name) => ({ name, artist: byIndex.get(name)! })),
      },
    };
  },

  // Simulated browse-by-folder (Navidrome: "no plans to support
  // browse-by-folder… returns a simulated directory tree, using the format
  // /Artist/Album/01 - Song.mp3"). There is no folders table: top-level
  // directories are the album artists (same set as getArtists), directory
  // ids borrow the real artist/album ids. Songs with no album tag are not
  // in the tree (no Album dir to hang them under) — they stay reachable via
  // search3/getSong/stream. No shortcuts, no top-level child elements.
  getIndexes: async (_request, context) => {
    const folderId = context.state.params!.get('musicFolderId') ?? undefined;
    const artists = await context.app.library.listArtists(folderId);
    const byIndex = new Map<string, Record<string, unknown>[]>();
    for (const artist of artists) {
      const name = indexName(artist.name);
      const list = byIndex.get(name) ?? [];
      list.push({ id: artist.id, name: artist.name });
      byIndex.set(name, list);
    }
    const names = [...byIndex.keys()].sort((a, b) =>
      a === '#' ? -1 : b === '#' ? 1 : a.localeCompare(b)
    );
    return {
      indexes: {
        ignoredArticles: IGNORED_ARTICLES,
        index: names.map((name) => ({ name, artist: byIndex.get(name)! })),
      },
    };
  },

  getMusicDirectory: async (_request, context) => {
    const id = requiredParam(context, 'id');
    if (id instanceof Response) return id;
    const artist = await context.app.library.getArtist(id);
    if (artist !== null) {
      const albums = await context.app.library.albumsByArtist(id);
      return {
        directory: {
          id: artist.id,
          name: artist.name,
          child: albums.map((album) => ({
            id: album.id,
            isDir: true,
            title: album.name,
            album: album.name,
            artist: album.artistName,
            artistId: album.artistId,
            coverArt: album.id,
            parent: artist.id,
          })),
        },
      };
    }
    const got = await context.app.library.getAlbum(id);
    if (got !== null) {
      return {
        directory: {
          id: got.album.id,
          name: got.album.name,
          parent: got.album.artistId,
          child: got.songs.map((song) => ({
            ...childOf(song),
            parent: got.album.id,
          })),
        },
      };
    }
    return notFound(context);
  },

  getArtist: async (_request, context) => {
    const id = requiredParam(context, 'id');
    if (id instanceof Response) return id;
    const artist = await context.app.library.getArtist(id);
    if (artist === null) return notFound(context);
    const albums = await context.app.library.albumsByArtist(id);
    return {
      artist: {
        ...artistId3Of(artist),
        album: albums.map(albumId3Of),
      },
    };
  },

  getAlbum: async (_request, context) => {
    const id = requiredParam(context, 'id');
    if (id instanceof Response) return id;
    const got = await context.app.library.getAlbum(id);
    if (got === null) return notFound(context);
    return {
      album: {
        ...albumId3Of(got.album),
        song: got.songs.map((song) => childOf(song)),
      },
    };
  },

  getSong: async (_request, context) => {
    const id = requiredParam(context, 'id');
    if (id instanceof Response) return id;
    const song = await context.app.library.getSong(id);
    if (song === null) return notFound(context);
    return { song: childOf(song) };
  },

  search3: async (_request, context) => {
    const params = context.state.params!;
    const query = requiredParam(context, 'query');
    if (query instanceof Response) return query;
    const result = await context.app.library.search3(query, {
      artistCount: intParam(params, 'artistCount', 20),
      artistOffset: intParam(params, 'artistOffset', 0),
      albumCount: intParam(params, 'albumCount', 20),
      albumOffset: intParam(params, 'albumOffset', 0),
      songCount: intParam(params, 'songCount', 20),
      songOffset: intParam(params, 'songOffset', 0),
      folderId: params.get('musicFolderId') ?? undefined,
    });
    return {
      searchResult3: {
        artist: result.artists.map(artistId3Of),
        album: result.albums.map(albumId3Of),
        song: result.songs.map((song) => childOf(song)),
      },
    };
  },

  search2: async (_request, context) => {
    const params = context.state.params!;
    const query = requiredParam(context, 'query');
    if (query instanceof Response) return query;
    const result = await context.app.library.search3(query, {
      artistCount: intParam(params, 'artistCount', 20),
      artistOffset: intParam(params, 'artistOffset', 0),
      albumCount: intParam(params, 'albumCount', 20),
      albumOffset: intParam(params, 'albumOffset', 0),
      songCount: intParam(params, 'songCount', 20),
      songOffset: intParam(params, 'songOffset', 0),
      folderId: params.get('musicFolderId') ?? undefined,
    });
    return {
      searchResult2: {
        artist: result.artists.map(artistId3Of),
        album: result.albums.map(albumV1Of),
        song: result.songs.map(childOf),
      },
    };
  },

  getGenres: async (_request, context) => {
    const genres = await context.app.library.listGenres();
    return {
      genres: {
        genre: genres.map((g) => ({
          value: g.name,
          songCount: g.songCount,
          albumCount: g.albumCount,
        })),
      },
    };
  },

  getSongsByGenre: async (_request, context) => {
    const params = context.state.params!;
    const genre = requiredParam(context, 'genre');
    if (genre instanceof Response) return genre;
    const songs = await context.app.library.songsByGenre(genre, {
      size: intParam(params, 'count', 10),
      offset: intParam(params, 'offset', 0),
      folderId: params.get('musicFolderId') ?? undefined,
    });
    return { songsByGenre: { song: songs.map(childOf) } };
  },

  getAlbumList: async (_request, context) => {
    const albums = await albumListAlbums(context);
    if (albums instanceof Response) return albums;
    return { albumList: { album: albums.map(albumV1Of) } };
  },

  getAlbumList2: async (_request, context) => {
    const albums = await albumListAlbums(context);
    if (albums instanceof Response) return albums;
    return { albumList2: { album: albums.map(albumId3Of) } };
  },

  // Original file bytes, Range-aware; transcode params are ignored in M1.
  // Not a scrobble — playing does not mark anything.
  stream: async (request, context) => {
    const id = requiredParam(context, 'id');
    if (id instanceof Response) return id;
    const path = await context.app.library.songPath(id);
    if (path === null) return notFound(context);
    return await context.app.stream.file(request._raw, path);
  },

  // Song ids only in M3: Navidrome also accepts album/artist/playlist ids
  // (zipped), but the household apps only download songs — zip can wait.
  // Same bytes as stream, plus Content-Disposition so the client saves a
  // file instead of playing it.
  download: async (request, context) => {
    const id = requiredParam(context, 'id');
    if (id instanceof Response) return id;
    const path = await context.app.library.songPath(id);
    if (path === null) return notFound(context);
    const res = await context.app.stream.file(request._raw, path);
    const name = (path.split('/').pop() ?? 'download').replaceAll('"', '');
    const headers = new Headers(res.headers);
    headers.set('content-disposition', `attachment; filename="${name}"`);
    return new Response(res.body, { status: res.status, headers });
  },

  // Embedded (USLT) lyrics only — no external agent. Empty lyrics element
  // when the song or the tag is missing (Subsonic's own "no lyrics" shape).
  getLyrics: async (_request, context) => {
    const params = context.state.params!;
    const row = await context.app.library.lyrics({
      artist: params.get('artist') ?? undefined,
      title: params.get('title') ?? undefined,
    });
    if (row === null) return { lyrics: {} };
    return {
      lyrics: {
        artist: row.artist ?? undefined,
        title: row.title ?? undefined,
        value: row.text,
      },
    };
  },

  // Navidrome extras ride along: folderCount, lastScan.
  getScanStatus: async (_request, context) => {
    return { scanStatus: await scanStatusOf(context) };
  },

  // fullScan is accepted and ignored: every scan is a full rebuild.
  startScan: async (_request, context) => {
    void context.app.scan.start(); // answers while the scan runs
    return { scanStatus: await scanStatusOf(context) };
  },

  // Album cover.jpg or the placeholder — always an image. `size` is ignored
  // in M1 (no rescaling).
  getCoverArt: async (_request, context) => {
    const id = requiredParam(context, 'id');
    if (id instanceof Response) return id;
    return await context.app.artwork.cover(id);
  },

  // --- M2: annotation (star / rate / scrobble) --------------------------------

  // star/unstar targets: repeated `id` = songs, `albumId` = albums,
  // `artistId` = artists (modern Subsonic split).
  star: async (_request, context) => {
    const params = context.state.params!;
    const targets: [string, string][] = [
      ...params.getAll('id').map((id): [string, string] => [id, 'song']),
      ...params.getAll('albumId').map((id): [string, string] => [id, 'album']),
      ...params.getAll('artistId').map((
        id,
      ): [string, string] => [id, 'artist']),
    ];
    if (targets.length === 0) {
      return failResponse(context, 10, 'Required parameter is missing');
    }
    for (const [targetId, targetType] of targets) {
      await context.app.annotation.star(
        context.state.user!.username,
        targetId,
        targetType,
      );
    }
    return {};
  },

  unstar: async (_request, context) => {
    const params = context.state.params!;
    const targets: [string, string][] = [
      ...params.getAll('id').map((id): [string, string] => [id, 'song']),
      ...params.getAll('albumId').map((id): [string, string] => [id, 'album']),
      ...params.getAll('artistId').map((
        id,
      ): [string, string] => [id, 'artist']),
    ];
    if (targets.length === 0) {
      return failResponse(context, 10, 'Required parameter is missing');
    }
    for (const [targetId, targetType] of targets) {
      await context.app.annotation.unstar(
        context.state.user!.username,
        targetId,
        targetType,
      );
    }
    return {};
  },

  // rating 1..5; 0 clears (Subsonic convention).
  setRating: async (_request, context) => {
    const id = requiredParam(context, 'id');
    if (id instanceof Response) return id;
    const raw = context.state.params!.get('rating');
    const rating = raw === null ? NaN : Number(raw);
    if (!Number.isInteger(rating) || rating < 0 || rating > 5) {
      return failResponse(context, 10, 'rating must be an integer 0-5');
    }
    await context.app.annotation.setRating(
      context.state.user!.username,
      id,
      rating,
    );
    return {};
  },

  // Append-only: submission=true inserts one listens row per id (never a
  // play_count update; never from stream). submission=false is a now-playing
  // notification — ignored until M3 (getNowPlaying stays empty).
  scrobble: async (_request, context) => {
    const params = context.state.params!;
    const ids = params.getAll('id');
    if (ids.length === 0) {
      return failResponse(context, 10, 'Required parameter is missing');
    }
    if (params.get('submission') === 'false') return {};
    const times = params.getAll('time').map((t) => Number(t));
    for (let i = 0; i < ids.length; i++) {
      const playedAtMs = Number.isFinite(times[i]) && times[i] > 0
        ? times[i]
        : undefined;
      await context.app.listens.record(context.state.user!.username, ids[i], {
        source: 'opensubsonic',
        playedAtMs,
      });
    }
    return {};
  },

  // Stub: now-playing state is not tracked (submission=false is ignored
  // above; a real now-playing list is not in the M3 plan).
  getNowPlaying: () => ({ nowPlaying: { entry: [] } }),

  // --- M3: empty-ok stubs ---------------------------------------------------
  // Features melofon is not building (plan: don't-die beats
  // implement-for-real). Each returns the correct empty payload — an app
  // renders "no podcasts / no chat / nothing similar", never an error.
  // Mutations for these surfaces (createPodcastChannel, addChatMessage,
  // createShare, …) stay on the dispatch fallback's clean code-0 envelope.

  getPodcasts: () => ({ podcasts: { channel: [] } }),
  getNewestPodcasts: () => ({ newestPodcasts: { episode: [] } }),
  getChatMessages: () => ({ chatMessages: { chatMessage: [] } }),
  getShares: () => ({ shares: { share: [] } }),
  getInternetRadioStations: () => ({
    internetRadioStations: { internetRadioStation: [] },
  }),

  // No Last.fm, no recommendations (plan: do not add a network agent).
  getSimilarSongs: () => ({ similarSongs: { song: [] } }),
  getSimilarSongs2: () => ({ similarSongs2: { song: [] } }),
  getTopSongs: () => ({ topSongs: { song: [] } }),
  getArtistInfo: () => ({ artistInfo: {} }),
  getArtistInfo2: () => ({ artistInfo2: {} }),
  getAlbumInfo: () => ({ albumInfo: {} }),
  getAlbumInfo2: () => ({ albumInfo2: {} }),

  // No avatars (no Gravatar, no uploads): the same placeholder tile as
  // getCoverArt's fallback. The username param is ignored, Navidrome-style.
  getAvatar: (_request, context) => context.app.artwork.placeholder(),

  // Navidrome quirk: the authenticated user, not a directory lookup.
  getUser: (_request, context) => ({
    user: {
      username: context.state.user!.username,
      scrobblingEnabled: true,
      adminRole: true,
      settingsRole: true,
      downloadRole: true,
      uploadRole: false,
      playlistRole: true,
      coverArtRole: true,
      commentRole: false,
      podcastRole: false,
      streamRole: true,
      jukeboxRole: false,
      shareRole: false,
      videoConversionRole: false,
      folder: [0],
    },
  }),

  getStarred2: async (_request, context) => {
    const rows = await context.app.annotation.starred(
      context.state.user!.username,
    );
    const artists: Record<string, unknown>[] = [];
    const albums: Record<string, unknown>[] = [];
    const songs: Record<string, unknown>[] = [];
    for (const row of rows) {
      const starred = new Date(row.starredAtMs).toISOString();
      if (row.targetType === 'song') {
        const song = await context.app.library.getSong(row.targetId);
        if (song !== null) {
          songs.push({
            ...childOf(song),
            starred,
          });
        }
      } else if (row.targetType === 'album') {
        const got = await context.app.library.getAlbum(row.targetId);
        if (got !== null) albums.push({ ...albumId3Of(got.album), starred });
      } else if (row.targetType === 'artist') {
        const artist = await context.app.library.getArtist(row.targetId);
        if (artist !== null) {
          artists.push({ ...artistId3Of(artist), starred });
        }
      }
    }
    return { starred2: { artist: artists, album: albums, song: songs } };
  },

  // Pull-forward for Symfonium: random songs from the catalog. genre/year
  // filters are not implemented in M2.
  getRandomSongs: async (_request, context) => {
    const params = context.state.params!;
    const songs = await context.app.library.randomSongs(
      intParam(params, 'size', 10),
      params.get('musicFolderId') ?? undefined,
    );
    return {
      randomSongs: {
        song: songs.map((song) => childOf(song)),
      },
    };
  },

  // --- M2: playlists ------------------------------------------------------------

  // Navidrome quirk: the `username` param is ignored — always the caller's.
  getPlaylists: async (_request, context) => {
    const username = context.state.user!.username;
    const rows = await context.app.playlists.list(username);
    return {
      playlists: { playlist: rows.map((p) => playlistOf(p, username)) },
    };
  },

  getPlaylist: async (_request, context) => {
    const id = requiredParam(context, 'id');
    if (id instanceof Response) return id;
    const username = context.state.user!.username;
    const playlist = await context.app.playlists.get(username, id);
    if (playlist === null) return notFound(context);
    return {
      playlist: {
        ...playlistOf(playlist, username),
        entry: await entriesFor(context, playlist.trackIds),
      },
    };
  },

  // With `playlistId`: replace that playlist's tracks. With `name`: create.
  createPlaylist: async (_request, context) => {
    const params = context.state.params!;
    const username = context.state.user!.username;
    const trackIds = params.getAll('songId');
    const playlistId = params.get('playlistId');
    if (playlistId !== null && playlistId !== '') {
      const updated = await context.app.playlists.setTracks(
        username,
        playlistId,
        trackIds,
      );
      if (updated === null) return notFound(context);
      return {
        playlist: {
          ...playlistOf(updated, username),
          entry: await entriesFor(context, updated.trackIds),
        },
      };
    }
    const name = requiredParam(context, 'name');
    if (name instanceof Response) return name;
    const created = await context.app.playlists.create(
      username,
      name,
      trackIds,
    );
    return {
      playlist: {
        ...playlistOf(created, username),
        entry: await entriesFor(context, created.trackIds),
      },
    };
  },

  updatePlaylist: async (_request, context) => {
    const params = context.state.params!;
    const playlistId = requiredParam(context, 'playlistId');
    if (playlistId instanceof Response) return playlistId;
    const removeAtPositions = params.getAll('songIndexToRemove')
      .map(Number)
      .filter((n) => Number.isInteger(n) && n >= 0);
    const updated = await context.app.playlists.update(
      context.state.user!.username,
      playlistId,
      {
        name: params.get('name') ?? undefined,
        comment: params.get('comment') ?? undefined,
        addTrackIds: params.getAll('songIdToAdd'),
        removeAtPositions,
      },
    );
    if (updated === null) return notFound(context);
    return {};
  },

  deletePlaylist: async (_request, context) => {
    const id = requiredParam(context, 'id');
    if (id instanceof Response) return id;
    const deleted = await context.app.playlists.delete(
      context.state.user!.username,
      id,
    );
    if (!deleted) return notFound(context);
    return {};
  },

  // --- M2: Subsonic play queue (the client's saved playback state) -----------

  // Navidrome quirk: `current` is a string. Nothing saved → bare ok envelope
  // (no playQueue key). No changedBy: the schema keeps no per-save client.
  getPlayQueue: async (_request, context) => {
    const queue = await context.app.clientQueue.get(
      context.state.user!.username,
    );
    if (queue === null) return {};
    return {
      playQueue: {
        entry: await entriesFor(context, queue.trackIds),
        current: queue.currentId ?? undefined,
        position: queue.positionMs ?? undefined,
        changed: new Date(queue.changedAtMs).toISOString(),
      },
    };
  },

  savePlayQueue: async (_request, context) => {
    const params = context.state.params!;
    const rawPosition = params.get('position');
    const position = rawPosition === null ? NaN : Number(rawPosition);
    await context.app.clientQueue.save(context.state.user!.username, {
      trackIds: params.getAll('id'),
      currentId: params.get('current') ?? undefined,
      positionMs: Number.isFinite(position) && position >= 0
        ? position
        : undefined,
    });
    return {};
  },

  // --- M3: bookmarks (per-user playback positions) ---------------------------

  getBookmarks: async (_request, context) => {
    const username = context.state.user!.username;
    const rows = await context.app.bookmarks.list(username);
    const bookmarks: Record<string, unknown>[] = [];
    for (const row of rows) {
      const song = await context.app.library.getSong(row.trackId);
      if (song === null) continue; // starred-then-removed track — skip
      bookmarks.push({
        entry: childOf(song),
        position: row.positionMs,
        username,
        comment: row.comment ?? undefined,
        created: new Date(row.createdAtMs).toISOString(),
        changed: new Date(row.changedAtMs).toISOString(),
      });
    }
    return { bookmarks: { bookmark: bookmarks } };
  },

  createBookmark: async (_request, context) => {
    const params = context.state.params!;
    const id = requiredParam(context, 'id');
    if (id instanceof Response) return id;
    const rawPosition = params.get('position');
    const position = rawPosition === null ? NaN : Number(rawPosition);
    if (!Number.isFinite(position) || position < 0) {
      return failResponse(
        context,
        10,
        'position must be a non-negative number',
      );
    }
    await context.app.bookmarks.set(
      context.state.user!.username,
      id,
      position,
      params.get('comment') ?? undefined,
    );
    return {};
  },

  // Unknown ids are ok, not 404: delete is idempotent (don't-die).
  deleteBookmark: async (_request, context) => {
    const id = requiredParam(context, 'id');
    if (id instanceof Response) return id;
    await context.app.bookmarks.remove(context.state.user!.username, id);
    return {};
  },
};

export async function dispatch(
  op: string,
  request: HatRequest,
  context: HatContext,
): Promise<Response> {
  const handler = OPS[op];
  if (handler === undefined) {
    return failResponse(context, 0, `Not implemented: ${op}`);
  }
  const result = await handler(request, context);
  return result instanceof Response ? result : okResponse(context, result);
}
