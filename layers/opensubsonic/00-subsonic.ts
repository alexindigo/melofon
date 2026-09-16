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
}

export interface HatContext {
  app: {
    cfg: {
      version?: string;
      library?: string;
    };
    user: {
      auth(username: string, password: string): Promise<StateUser | null>;
      authMd5(
        username: string,
        token: string,
        salt: string,
      ): Promise<StateUser | null>;
    };
    library: {
      listArtists(): Promise<ArtistRow[]>;
      getArtist(id: string): Promise<ArtistRow | null>;
      albumsByArtist(artistId: string): Promise<AlbumRow[]>;
      listAlbums(opts: {
        sort: 'name' | 'random' | 'newest';
        size: number;
        offset: number;
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
        },
      ): Promise<
        { artists: ArtistRow[]; albums: AlbumRow[]; songs: SongRow[] }
      >;
    };
  };
  state: {
    user?: StateUser;
    params?: URLSearchParams;
  };
}

// Domain rows, declared structurally (the hat does not import src/).
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
  title: string;
  albumId: string | null;
  albumName: string | null;
  artistId: string | null;
  artistName: string | null;
  track: number | null;
  disc: number | null;
  durationMs: number | null;
  size: number | null;
  suffix: string;
  contentType: string;
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
// `album`, `song` all name their items after the key).
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
  for (const [key, val] of Object.entries(obj)) {
    if (val === null || val === undefined) continue;
    if (isScalar(val)) attrs += ` ${key}="${escapeXml(String(val))}"`;
    else children += xmlElement(key, val);
  }
  return children === ''
    ? `<${tag}${attrs}/>`
    : `<${tag}${attrs}>${children}</${tag}>`;
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

function childOf(song: SongRow, libraryRoot?: string): Record<string, unknown> {
  const path = libraryRoot !== undefined && song.path.startsWith(libraryRoot)
    ? song.path.slice(libraryRoot.length).replace(/^\/+/, '')
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

const OPS: Record<string, OpHandler> = {
  ping: () => ({}),
  getLicense: () => ({ license: { valid: true } }),
  getMusicFolders: () => ({
    musicFolders: { musicFolder: [{ id: 0, name: 'Music' }] },
  }),
  getOpenSubsonicExtensions: () => ({
    openSubsonicExtensions: { openSubsonicExtension: [] },
  }),

  getArtists: async (_request, context) => {
    const artists = await context.app.library.listArtists();
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
        song: got.songs.map((song) => childOf(song, context.app.cfg.library)),
      },
    };
  },

  getSong: async (_request, context) => {
    const id = requiredParam(context, 'id');
    if (id instanceof Response) return id;
    const song = await context.app.library.getSong(id);
    if (song === null) return notFound(context);
    return { song: childOf(song, context.app.cfg.library) };
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
    });
    return {
      searchResult3: {
        artist: result.artists.map(artistId3Of),
        album: result.albums.map(albumId3Of),
        song: result.songs.map((song) =>
          childOf(song, context.app.cfg.library)
        ),
      },
    };
  },

  getAlbumList2: async (_request, context) => {
    const params = context.state.params!;
    const type = requiredParam(context, 'type');
    if (type instanceof Response) return type;
    const sort = type === 'alphabeticalByName'
      ? 'name'
      : type === 'random'
      ? 'random'
      : type === 'newest'
      ? 'newest'
      : null;
    if (sort === null) {
      return failResponse(
        context,
        0,
        `getAlbumList2 type not implemented: ${type}`,
      );
    }
    const albums = await context.app.library.listAlbums({
      sort,
      size: intParam(params, 'size', 10),
      offset: intParam(params, 'offset', 0),
    });
    return { albumList2: { album: albums.map(albumId3Of) } };
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
