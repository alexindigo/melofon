# Melofon

Household music server: library + HTTP streamer + speaker control.
Greenfield replacement for Navidrome (OpenSubsonic stays so existing apps keep working).

## Start

```bash
export MELOFON_LISTEN=0.0.0.0:8000
export MELOFON_DATA=./data
export MELOFON_USER=admin
export MELOFON_PASSWORD=change-me
export MELOFON_SECRET=another-secret
mkdir -p "$MELOFON_DATA"
deno task start
```

For interactive first setup, omit `MELOFON_USER` and `MELOFON_PASSWORD`
(keep `MELOFON_SECRET`). With no admin, only setup and health are public.
Read the one-time code in the startup log and open `/setup`, then create the
admin with a matching Origin:

```bash
url=http://melofon.home:8000
curl -H 'content-type: application/json' -H "Origin: $url" \
  -d '{"code":"CODE-FROM-LOG","username":"admin","password":"your-password"}' \
  "$url/setup"
```

Melofon sends 201, shuts down and exits with code 75 after setup. Configure
systemd with `Restart=on-failure` (or `Restart=always`), or Docker Compose
with `restart: unless-stopped` (`docker run --restart unless-stopped`).
When started by hand, start it again. The next start serves the normal hats;
sign in with the admin you just created.

Scan sources live in the database (not env). Add each music folder once —
it persists and is scanned on every boot. Sign in as the env-seeded admin
(replace `melofon.home` with your server's address):

```bash
url=http://melofon.home:8000
curl -c cookies.txt -H 'content-type: application/json' -H "Origin: $url" \
  -d '{"username":"admin","password":"change-me"}' "$url/api/v1/session"
curl -b cookies.txt -H 'content-type: application/json' -H "Origin: $url" \
  -d '{"name": "Music", "path": "/path/to/music"}' \
  "$url/api/v1/admin/libraries"
```

`GET /api/v1/admin/libraries` lists sources; `PATCH` or `DELETE` its `/<id>`
edits or removes one. Paths must be absolute, readable, outside the data
directory and disjoint. Adding or moving a library starts a background scan;
moving keeps its id and song ids. Removal keeps stars, ratings and listens.
`POST /api/v1/admin/scans` with `{}` starts a full scan (or returns the running
one); `GET /api/v1/admin/scans/current` reads its status and last error.
`getMusicFolders` on `/rest` is the OpenSubsonic view of the same list.

`GET /_/health` returns `{"ok":true}` once the DuckDB index is open.
All other core `/_/` admin routes (config, libraries, outputs, last-command)
are loopback-only: call them from inside the server's container or VM. Requests
carrying a forwarded header never count as loopback.
Settings for LAN clients are at `/api/v1/admin/settings`, signed in as admin.
`MELOFON_LISTEN` unset → Deno.serve default. Never commit `.env`, `.envrc`,
or anything under `data/` — keep deployment secrets out of source control.

### Outbound response streams

Core-owned HTTP response streams share the outbound host checks, DNS pinning
and redirect policy used by buffered downloads. Their admin settings are
`net.streamOpenTimeoutSeconds` (default 10 seconds, covering rate waits, DNS
and all redirect headers), `net.streamBodyIdleSeconds` (default 10 seconds
per pending read) and `net.streamBufferBytes` (default 65536 bytes for the
transport's web-stream queue, plus native socket/decoder buffers). Consumer
backpressure does not count as upstream idleness. Core source owners may
supply their own open/read budgets. Healthy streams have no lifetime timer
or cumulative byte cap; body failures are surfaced without hidden retries.
Buffered lookup and file-download limits remain separate.

### Core radio playlist resolution

The core radio source resolver supports ordinary PLS/M3U wrappers around
HTTP(S) audio. Links are ordered alternatives for one station, visited lazily
within the caller's retry budget. Relative links use the final playlist URL.
Only the entered host grants LAN trust, including references back to that host;
redirects and playlist entries never grant another private host access. HLS
manifests and legacy `ICY 200 OK` status lines are rejected.

When constructed, the resolver declares `radio.resolveTimeoutSeconds` (default
10 seconds per resolution attempt), `radio.playlistMaxBytes` (65536 per
document), `radio.playlistMaxDepth` (4 nested playlist documents),
`radio.playlistMaxDocuments` (16) and `radio.playlistMaxEntries` (128). Document
and entry totals span the alternative traversal until it starts again at the
entered URL. `radio.playlistProbeBytes` (512) bounds wrapper-prefix inspection;
`radio.sourceRequestsPerMinute` (600) bounds request frequency through the net
owner. Final audio retains its inspection bytes and streams under the net
owner's pending-read idle budget, without the resolution lifetime/byte caps.
This is a core byte-source facility; queue admission and playback integration
follow separately.

### Ignoring discovered speakers

Any signed-in user can hide an unadopted speaker with
`POST /api/v1/speakers/{id}/ignore` and JSON `{}`. Deselect it first, even when
playback is paused. Adopted speakers must be forgotten before they can be ignored.
Ignore saves only an identity marker, which survives advertisements and restarts.
It does not save the discovered speaker's configuration or credentials.

Normal speaker reads and OwnTone output lists omit ignored devices. Use
`GET /api/v1/speakers?includeIgnored=true` (or the same query on a detail read)
to see them. An ignored device without a current observation has only `id`,
`ignored:true`, `adopted:false` and `discovered:false`; no stale endpoint is restored.
`DELETE /api/v1/speakers/{id}/ignore` undoes ignore, including while offline.
Fresh observations become visible again. Explicit adoption also replaces ignore.
Writes use the usual cookie/Bearer authentication and Origin checks.

### Hat-private images

Core stores hats' image records as files in the server data directory, alongside
the database. Back up both together. Images stay private to their hat and owner.
The admin settings `hatData.maxImageBytes` (default 20971520, 20 MiB) and
`hatData.maxImagePixels` (default 64000000) bound accepted image bytes and
header dimensions. Supported headers are PNG, JPEG, GIF and WebP.

### Serving in a sub-folder

The core setting `server.baseUrl` is empty by default. Set it through the
admin settings API to a path such as `/music` or an HTTP(S) URL such as
`https://myhome.example/music`. Its path becomes the default listen's serving
prefix immediately; a trailing slash is normalized away. Paths must start
with one `/`, cannot be `/` alone or start with `/_`, and cannot contain a
query, fragment or dot segments. `MELOFON_BASE_URL` seeds this setting on
first boot only; it never replaces a stored choice.

With `/music`, use `/music/setup`, `/music/rest/...` and `/music/api/v1/...`.
Configure a reverse proxy to pass that prefix through. `GET /` redirects to
`/music/`; health answers at both `/music/_/health` and `/_/health`. Other
unprefixed paths return 404. Session cookies use `Path=/music`. OwnTone's
own listens keep their root paths (`/api/...`). For the curl examples above,
append `/music` to the request URL, while keeping `Origin` as just the scheme,
host and port.

A reverse proxy **must set or append at least one** of `X-Forwarded-For`,
`X-Forwarded-Host`, `X-Forwarded-Proto`, `X-Real-IP` or `Forwarded` on every
request it forwards. Melofon treats a loopback peer without one as local
administration. This applies to any same-host proxy, with or without a prefix.
Most proxies add a forwarded header; nginx needs the `X-Forwarded-For` line below
(replace `<port>` with Melofon's listen port):

```nginx
location /music/ {
    proxy_pass http://127.0.0.1:<port>;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

The proxy must pass the public `Host` (including port) for Melofon's generated
addresses and `Origin` checks; if it cannot, configure a full `server.baseUrl`
for those instead.

Generated artist-image and share addresses include the serving prefix. A full
`server.baseUrl` supplies their public origin; a path-only setting uses the
request's own origin. `server.publicUrl`, when set, remains the separate share
address override and receives no base-URL prefix.

Change requests and WebSockets accept either the request's own Origin or the
configured full base URL's Origin. Cookies carry `Secure` on HTTPS requests,
or when the configured base URL is HTTPS and its host (including port) matches
the request's host. Forwarded headers never supply an origin, scheme or client
address.

### Speaker credential storage

Saved speaker passwords and pairing keys use authenticated encryption in DuckDB,
with a separate, versioned key derived from `MELOFON_SECRET`. Keep that deployment
secret stable and back it up separately from the database. Restoring credentials
requires the same secret. A missing secret refuses saved credential writes/reads;
a wrong secret or modified ciphertext fails authentication. Neither case creates
a new key or falls back to plaintext. Losing the secret means re-entering speaker
passwords and pairing again. Changing it is not automatic key rotation.

Credentials for unadopted speakers stay in memory until their session identity is
released or the server exits. Explicit adoption encrypts them atomically with the
saved speaker configuration; forget deletes both credential kinds with that
configuration. PINs are transient commands, not stored credentials. Public speaker
reads and notifications contain no password or pairing key.

Any signed-in user can set a receiver password with
`PUT /api/v1/speakers/{id}/password` and JSON `{ "password": "..." }`, or clear it
with `DELETE` on the same route. Both return only `{ "passwordSet": true|false }`.
An empty password is distinct from clearing it; passwords must contain no NUL and
fit the native bridge's 4096-byte UTF-8 limit. Replacement retires old credential
sessions and can recover an existing play intent after saving. It never overrides
Pause, Stop, deselection or forgetting. `has_password` in OwnTone remains the
receiver's advertised requirement, not whether Melofon has a password saved.

Any signed-in user can start PIN pairing without playing music:
`POST /api/v1/speakers/{id}/pair` with `{}`, then wait for
`state.pairing.state` to become `awaiting_pin` on the speaker read. Submit the
four displayed digits with `POST /api/v1/speakers/{id}/pin` and `{ "pin": "1234" }`.
Both commands return 202 with `{ "pairing": ... }`; acceptance is not completion.
The states are `preparing`, `awaiting_pin`, `pairing`, `complete`, `failed` and
`cancelled`. Only `complete` with `saved:true` reports an adopted key saved to
disk. Temporary speakers keep the result in memory; adoption can save it later.

Pair uses a control-only probe, does not select a speaker or start the player,
and requests a fresh PIN even if a previous key exists. The setting
`airplay.pairingSeconds` bounds the whole operation (default 120 seconds).
Pause, Stop, selection changes, endpoint replacement and forget cancel it.
A current playback PIN challenge can also accept a PIN through the same owner;
OwnTone's existing output `pin` field uses that owner. A PIN without either
an explicit pairing operation or a current challenge fails instead of succeeding
silently. Key export is acknowledged only after durable storage (or temporary
memory acceptance). Rejected keys clear saved state; network outages do not.
Real Apple TV pairing interoperability remains unverified by the automated fake
receiver, which does not implement cryptographic fruit pairing.

### Native artwork metadata

Song, album, artist, playlist, station and podcast reads expose `artwork` with a
versioned local `url`, original dimensions, `thumbHash` and `dominantColor`.
Missing ordinary artwork is `null`. Facts are lazy: a cache miss returns null
hash/colour fields while computing them; the next read includes the saved facts.

Read-only lists/details are available at `/api/v1/playlists`,
`/api/v1/radio-stations` and `/api/v1/podcasts` (append `/{id}` for details).
Playlist reads follow core visibility and remain private/no-store. Podcast
episodes at `/api/v1/podcasts/{id}/episodes` and
`/api/v1/podcast-episodes/{id}` use their channel's artwork. These projections
expose no server file paths. Cookie and Bearer credentials both work for the
metadata and image URLs; repeat image requests can use `If-None-Match` for 304.

### Radio artwork uploads

Signed-in users can send raw PNG, JPEG, GIF or WebP bytes to
`PUT /api/v1/radio-stations/{id}/artwork`. Core validates and durably stores the
image; the response's `artwork` includes its versioned local `url` and original
dimensions. Cookie and Bearer authentication work over plain HTTP; change
requests follow the usual Origin policy. `DELETE` removes the override.
`radio.maxArtworkBytes` (default 20971520) and `radio.maxArtworkPixels` (default
64000000) bound uploads. Invalid images leave the previous override intact.
Back up `radio-images/` together with the database, just like `hat-images/`.

Without an override, core renders the station name as a PNG tile on a plain,
stream-URL-derived background. All hats share the same source, versions and
pixel/resize paths. `artwork.radioTileSize` defaults to 512 (64-2048 pixels);
`artwork.radioTileCharacters` defaults to 512 graphemes. Names wrap and shrink
to fit, with an ellipsis for overflow. The bundled GNU Unifont bitmap font
supports printable BMP Latin, Cyrillic, Greek and CJK names without system fonts
or network services; its licence is in `src/fonts/`. Unsupported characters use
a replacement glyph; complex-script shaping is not provided. Removing an upload
reveals the tile again. Generated images are disposable cache data.

### Now-playing expiry

Apps explicitly report playback; fetching media does not report a play.
Signed-in clients can read the household view at `GET /api/v1/now-playing`
and re-fetch when `/api/v1/events` sends a `nowPlaying` invalidation.
Core expires playing/starting reports after their projected end plus
`playback.sessionGraceMinutes`, and paused reports after
`playback.pausedSessionMinutes` since the last report (both default to 30).
Expiry never records a listen. A background sweep removes expired reports
and notifies observers even when nobody reads the view. Its live setting
`playback.sessionSweepSeconds` defaults to 1 second (range 0.01–3600),
configurable through the admin settings API. Reads hide expired reports
without deleting them; retained app-player identities survive expiry.

### Device playback abilities

`PUT /api/v1/me/playback-capabilities` replaces the current login's audio
declaration; `GET` returns `{capabilities: ...}` (`null` before registration).
Send an object with `name`, `platform`, optional bitrate ceilings in bits/s,
`directPlayProfiles`, `transcodingProfiles` and `codecProfiles`. Core trims
names, normalizes profile tokens to lowercase and removes duplicate token
values. Other logins keep independent declarations, even with the same device
name. Declarations survive restart and disappear with the login on sign-out,
revocation, password change or observed idle expiry. They are not published in
household events. `stream.capabilitiesMaxBytes` (default 65536) limits both the
submitted and normalized JSON's UTF-8 bytes; invalid or oversized replacements
leave the previous declaration intact. This records client-declared abilities,
not evidence of a connected speaker or a guarantee that a profile is supported.

### Song streams

`GET` and `HEAD /api/v1/songs/{id}/stream` authenticate with the current
cookie or Bearer login. Each request negotiates against that login's latest
declaration and current encoder settings. Without a declaration, the server
encodes MP3; an unavailable encoder or incompatible declaration returns a native
`incompatible_media` error (422), never arbitrary original bytes. Catalog video
ids on this route deliver audio only. Podcast ids are not song ids.

Optional query parameters are `format=mp3|aac|opus|ogg`, `maxBitRate` (positive
integer kbps), and `offset` (nonnegative integer seconds). Unknown, repeated or
malformed parameters fail with 400. An explicit format replaces registered
profile/codec preferences and forces that encoder; an unavailable encoder fails
with 422. An explicit bitrate ceiling replaces registered bitrate ceilings,
still bounded by the encoder's configured default. Without a format override,
the cap uses only declared profiles (MP3 when undeclared), never inventing a
different codec to satisfy it. Registration itself is unchanged.

Allowed originals retain byte ranges, ETag and conditional requests. Transcodes
have `Accept-Ranges: none`, no ETag or estimated length; `offset` seeks encoded
audio and at/past EOF returns an empty 200. Original bytes ignore `offset`.
HEAD never starts an encoder. Media reads, EOF and disconnects never update
now playing or record listens. Browser media uses same-origin cookies; this
route does not mint casting URLs.

### Video HLS

`GET /api/v1/videos/{id}/hls.m3u8` returns an authenticated H.264/AAC HLS
playlist. With no rendition request, compatible sources are remuxed. Optional
`bitRate` is a positive safe integer in kbps, optionally followed by exact even
dimensions (`1000@640x360`); repeating it returns a master playlist. Alternatively
use `size=640x360`. `audioTrack` is a nonnegative demuxer stream index from the
video's indexed audio facts. Unknown/repeated parameters (except master
`bitRate`), conflicting sizes, invalid dimensions and unknown audio tracks fail
with 400; audio-only and unknown ids return 404.

Core admits a complete HLS ladder before encoding any rung, for both native
and OpenSubsonic requests. Owner settings `media.hls.maxRenditions` (8),
`media.hls.maxDimension` (4096 pixels per dimension) and `media.hls.maxKbps`
(100000 kbps) bound requests. Explicit dimensions must not exceed the source.
Excessive requests are rejected, never clamped; native errors are 400
`invalid_field`, and OpenSubsonic admission errors are XML code 0.

Follow playlist-relative links as returned, including
`hls/segments/{index}.ts`. Every playlist and segment request needs its own
cookie or Bearer authentication; URLs contain only rendition/track choices.
Links preserve root, configured base-prefix and forced-hat mounts. Playlists
use EVENT while encoding and VOD with ENDLIST when complete; segments are
`video/MP2T`. Both are `no-store`. Core owns encoding, the bounded cache and
read leases through EOF or cancellation. Audio ability declarations do not
negotiate video renditions.

`GET /api/v1/videos/{id}/playback` discovers `audioTracks` (actual demuxer
stream indices), safe `captions` descriptors and a relative `hls` link. Choose
an audio track with `audioTrack=<index>` on that HLS URL; each output multiplexes
one selected audio stream, rather than alternate-audio master groups. Caption
`href` links resolve against the discovery URL and default to WebVTT for an
HTML `<track>`. `GET /api/v1/videos/{id}/captions?key=<opaque-key>&format=vtt`
reads only that video's scanned sidecar or embedded text track; `format=srt`
is also supported. Keys must be passed unchanged, never interpreted as paths.
Both resources require cookie or Bearer authentication and are `no-store`.

## Catalog identity

### Browse ordering

The core setting `catalog.ignoredArticles` is an array of leading words ignored
by native catalog name ordering and OpenSubsonic artist indexes/alphabetical
album lists. Its default is `The, El, La, Los, Las, Le, Les, Os, As, O, A`,
preserving the OpenSubsonic defaults. Edit it through
`PATCH /api/v1/admin/settings` with, for example,
`{"changes":[{"key":"catalog.ignoredArticles","value":["The","A"]}]}`.
Each entry is one nonempty word (no whitespace or commas); `[]` disables
article stripping while retaining case/accent folding. Changes apply without a
scan or restart, invalidate native list validators, and send signed-in clients
a `library` change event. `reference.ignoredArticles` remains independent: it
controls matching external reference names, not browse order.

Native catalog collections, artist album memberships and search accept
`natural=true` (default off; `natural=false` retains lexical ordering). For
example, `/api/v1/songs?sort=name&natural=true` puts `Episode 2` before
`Episode 10`, before paging. The locale-independent core key folds case and
accents after resolving articles/optional sort tags, then compares ASCII digit
runs by numeric magnitude without a fixed precision limit. Leading zeros are
insignificant; equal keys use the entity id (the literal name for genres).
Punctuation and non-ASCII digits are ordinary text, not signs or decimals.
Other hats keep their existing defaults.

Native artists, albums, songs, artist-album memberships and search accept
`sortTags=true|false`, default **off**. A nonblank tagged sort name/title wins;
otherwise the normal article and filesystem-fallback key applies. Tagged sort
values are folded but are not article-stripped. Core still defaults off; each
hat chooses its own policy.

On artists and artist-album memberships, `sort=-name` reverses name order.
Album/song collections also accept `-artist`, `-year`, `-newest` and `-genre`
(genre still requires its filter). A minus reverses the existing mode, so
`-newest` is oldest-first. Missing values stay last; final ID ties stay ascending.
Random and personal selection modes keep their existing sort names.

Those name-ordered pages additionally accept `index=true` (default off), for
example `/api/v1/artists?sort=-name&natural=true&sortTags=true&index=true`.
The response adds the effective `ignoredArticles` list and
`index: [{key,label,offset,count}, ...]`: contiguous runs in
the **whole eligible sequence**, not just the current page. A–Z keys follow the
same resolved article/tag key as paging; other scripts and numeric initials
are retained, with `#` for an empty key. Numeric initials can recur under
natural ordering, so separate runs are not merged. Present Unknown/Various
artist groups have their own native keys/labels and remain last. Offsets/counts
are scoped and computed in the same catalog snapshot as rows and total.
Index metadata requires name order; it is not offered for other sort modes.
All options are strict booleans/allow-listed sorts and participate in validators.

### Stable identities

Scanning records an `afp/1` audio fingerprint from compressed audio packets,
excluding tags. Unchanged stat tuples reuse the cached fingerprint, including
same-filesystem moves. Song ids stay stable across tag edits and automatically
linked moves/renames, keeping stars, ratings and listens attached. External moves
link only when exactly one missing identity and one new path share a fingerprint;
links and ambiguous candidates are kept as history. First-seen is recorded once
when a scan first sees a file and carried across moves. Core indexes exact-audio
duplicate groups and retains missing identities; API/UI access comes later.

## OpenSubsonic capabilities and form POST

`GET` or form `POST /rest/getOpenSubsonicExtensions` (also `.view`) is public:
no credentials, `v` or `c` are required, and invalid supplied credentials do not
change its server-wide response. The existing `/_opensubsonic/` force prefix
works too. Other OpenSubsonic operations retain their authentication checks;
discovery is unavailable on OwnTone-exclusive listens.

JSON returns `subsonic-response.openSubsonicExtensions` as
`[{"name":"formPost","versions":[1]}]`. XML repeats `openSubsonicExtensions`
elements with a `name` attribute and `versions` children. Only `formPost` version1
is advertised. This does not advertise missing operations or other extensions.

Existing GET/POST operations accept `application/x-www-form-urlencoded` arguments,
including percent-encoded credentials/text and repeated fields such as star `id`.
The POST media-type essence is matched exactly and case-insensitively, allowing
ordinary token/quoted parameters. Suffixed lookalikes and unrelated media types
leave query parameters available and do not invoke the form decoder. The original
header and body still go through the native form decoder.
Form values precede query values: scalar getters use the first form value;
an empty first value stays empty (the login fields below treat it as not sent).
Repeated getters retain form values followed
by query values, including duplicates and their order. Both methods reach
the same injected core services and canonical state.

## OpenSubsonic versions, logins and JSONP

Every response reports `version` 1.16.1, the implemented protocol, with
`type`, `serverVersion` and `openSubsonic` unchanged. The client's `v` is compared
with it by major and minor (the patch part is ignored; there is no minimum): an
older major gets code20, a newer major or a newer minor within major 1 gets code30.
A `v` that is not `digits.digits[.digits…]` is accepted without comparison.

Logins follow the specification. A password `p` together with a token `t` or salt
`s` is code43. API keys are not supported: `apiKey` alone is code42, and together
with any of `u`/`p`/`t`/`s` it is code43. Missing `u`, `v` or `c`, or no `p` and not
both `t` and `s`, is code10. Then comes the version check, then verification
(code40). The first value wins as above, but an empty `u`, `v`, `c`, `p`, `t`, `s`
or `apiKey` counts as not sent and never falls back to a later query value.
Public capability discovery is unaffected. Errors stay HTTP 200 envelopes.
XML errors from `stream`, `download`, `getCoverArt`, `getAvatar` and `hls.m3u8`
use `text/xml; charset=utf-8`; JSON errors there still follow `f`.

JSONP is off by default. With it off, `f=jsonp` is an unrecognized format and
answers XML. Enable it with
`PUT /_/config/opensubsonic.jsonp {"value":"on"}`; any other value disables it.
When it's on, a valid `callback` (`^[a-zA-Z_$][a-zA-Z0-9_$.]*$`) gets
`callback(json)` as `application/javascript` with `X-Content-Type-Options: nosniff`,
with U+2028/U+2029 escaped. A missing callback is code10 and an invalid one is
code0 `invalid callback parameter`. Both are plain JSON and never echo the callback.

## OpenSubsonic favourites, ratings and plays

Every star and unstar is kept as an event; nothing is overwritten or deleted, and
existing stars became events with their original dates. An item is starred while
its latest event is a star. Each star counts as a like, so starring an item again
moves it to the top: `starred` is the date of the most recent like (Navidrome's
rule), and `getStarred`, `getStarred2` and `getAlbumList(2)` `type=starred` list
newest like first.

Songs, albums and artists carry the requesting user's `starred`, `userRating`,
`averageRating` (all users, two decimals) and, for songs, albums and directories,
`playCount` and `played` (the latest scrobble time). Play counts are read through
the current catalog: an album counts its songs' plays, an artist the songs
crediting it as track artist. Fields without data are omitted, except the OpenSubsonic additions, which
are always sent: `played` (`""` when never played) on songs and albums, and
`userRating` (`0` when unrated) on ID3 albums.

`getStarred` answers the legacy folder-style shape (artists with id and name,
albums as directory children, songs) next to `getStarred2`; both honour
`musicFolderId`, and an unmatched folder lists nothing. Old-style IDs are looked
up, so `star?id=<albumId>` stars the album. `star`, `unstar` and `scrobble` skip
IDs that are not in the catalog and still answer ok; an item that has left the
catalog can still be unstarred. `setRating` on an unknown ID is code70, and a
`rating` that is not an integer 0–5 is code0 (missing is code10). `scrobble`
treats `submission` as true when missing or empty and otherwise only for
`true`/`on`/`1`; `time` values, when sent, must match the number of IDs (code0).

## OpenSubsonic catalog sync and selection

`search3` requires the `query` parameter, but `query=` enumerates the catalog for
offline sync. Artists, albums and songs have independent count/offset pairs
(defaults20/0); zero suppresses a group. Counts and offsets are nonnegative safe
integers, with invalid/unsafe values falling back to those defaults. Search has
no500 ceiling. Deterministic pages sort by label and canonical ID, so duplicate
labels do not skip or repeat rows over an **unchanged catalog**. There is no
cross-request snapshot guarantee during rescans. Nonempty search keeps the
existing case-insensitive substring/ILIKE behavior.

`getRandomSongs` applies indexed genre equality, independently optional inclusive
`fromYear`/`toYear` and `musicFolderId` together **before** sampling. Unknown years
do not satisfy a supplied bound; reversed random bounds return an empty pool.
Music videos and albumless songs remain eligible. Each response has unique song
IDs; requests do not share an exclusion list or promise a weighted/seeded shuffle.
Supplied malformed/unsafe years fail with code10 rather than broadening selection.

Random `size`, `getSongsByGenre.count` and both album-list `size` parameters
default to10 and cap valid positive values at500; zero returns an empty list.
Invalid/unsafe counts retain the default fallback. Genre/album offsets default
to0 and require nonnegative safe integers. Album `byYear` keeps its documented
reverse chronological behavior when `fromYear > toYear`. Core and OwnTone
whole-catalog consumers are not subject to these OpenSubsonic wire caps.

The existing physical-source integer/hash compatibility remains in place;
unmatched folders return empty selections. This documents catalog selection,
not complete source-qualified artist/album aggregate or date/history semantics.

Whole-number request fields establish mathematical integrality before conversion
to a JavaScript Number. Whole-valued decimal/exponent forms (`1.0`, `.1e1`,
`1000e-3`) and unsigned hexadecimal/binary/octal integers remain valid where the
field's range permits. Rounded fractions (`1.0000000000000001`) and nonzero
underflow (`1e-400`) are invalid and follow that field's existing fallback/error
policy. Required years still reject blanks; legacy blank-zero and negative-zero
behavior is preserved in the fields that already allowed it.

Safe-integer catalog fields retain their documented range. Legacy fields—search2
counts/offsets, playlist removal indexes, HLS segment indexes and OwnTone integer
arguments—continue accepting finite unsafe whole numbers with their previous
rounded Number representation. This is not lossless representation or a new
safe-only limit. OwnTone signed values, paging `-1` sentinel and first-valid
absolute/relative command precedence remain in place. Fractional bookmark/client
queue positions and scrobble seconds retain their separate number contracts.

## OpenSubsonic browsing

Every advertised artist ID resolves in `getArtist` and `getMusicDirectory`,
including track-only performers: they have zero albums and empty album/child
lists, and can appear in both favourites endpoints. Artist indexes still list
album artists. `getArtist` albums sort by year ascending, then name and ID.

Artist indexes and alphabetical album lists ignore the leading articles
`The El La Los Las Le Les Os As O A`, fold accents and lowercase their sort key.
Article matching is case-sensitive and requires a following space, as in
Navidrome. Index groups are A–W, X-Z (X/Y/Z), [Unknown] (names starting with `[`) and
`#` for unmatched names; group labels sort ascending. `getIndexes.lastModified`
is the last scan's start time in epoch milliseconds. `ifModifiedSince` at or
after it omits `index`, while retaining `lastModified` and `ignoredArticles`.

Album and song `created` dates are first-seen dates, retained across retags and
moves. An album uses the earliest first-seen among its listed files; `newest`
orders that date descending, with ID ties. `recent` and `frequent` include only
albums the requesting user has played. `byGenre` and `byYear` select album
membership and count/time the whole album, rather than only matching songs.
Existing music-folder aggregate scope and empty unmatched-folder behavior stay
in place. Song Child `parent` points to its album, and album Child `parent` to
its album artist across browsing, lists and legacy search.

## Native last-command snapshot

`GET /_/last-command` reads the playback and output owners' current command
records through the native API, with `Cache-Control: no-store`:

```bash
curl http://127.0.0.1:8000/_/last-command
```

Before either owner has recorded a command, the response is
`{"playback":null,"outputs":null}`. Each missing record is independently null.
A populated snapshot can look like:

```json
{
  "playback": {
    "kind": "seek",
    "detail": "position_ms=75000",
    "source": { "kind": "http", "client": "example-controller" },
    "atMs": 1791408896789,
    "intent": "play",
    "queueCleared": false
  },
  "outputs": {
    "kind": "setEnabled",
    "source": { "kind": "internal", "via": "example-controller" },
    "selection": [{ "id": "example-output", "selected": true }]
  }
}
```

`kind` names the existing command; optional playback `detail` keeps its legacy
detail string. `source.kind` is `http` or `internal`; existing optional `via`,
`peer`, `userAgent`, `user` and `client` identify the stored attribution.
Playback `atMs` is the command's Unix timestamp in milliseconds, not the GET
time. `intent` is `play`, `pause`, `stop` or `none`; `queueCleared` records the
existing queue-clear flag. Outputs expose only `kind`, `source` and optional
`selection` entries (`id`, `selected`), with no output timestamp, target,
volume or PIN payload inferred.

These are independent latest records, not a transaction, total chronology or
durable history. They last only for the process lifetime; restart begins empty
or records commands actually performed by boot/restore. Internal discovery,
preparation or restoration can replace the latest output record. Accepted/no-op
commands may be recorded without changing state. Reading does not record a
command. The endpoint is unauthenticated but loopback-only. OwnTone `/api/player` retains its eight existing
keys and has no `last_command` field. This is a Melofon-specific diagnostic view.

## AirPlay connection strategies

AirPlay runs in-process via `helper/raop/libmelofon_raop.so` and Deno FFI.
Each registered speaker has a persisted `connectionStrategy`, exposed on
native `GET /_/outputs` and updated with
`PUT /_/outputs/<id> {"connectionStrategy":"melofon"}`. Registration accepts
the optional same field. OwnTone wire payloads remain unchanged.

| Choice              | Idle / restart                                                                        | Detected seek / queue-entry transition                                   |
| ------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `melofon` (default) | Release locally on Pause/Stop; fresh session on Play                                  | Retire and replace after proven local close                              |
| `owntone`           | FLUSH once, retain up to ten seconds from local idle entry, quick reuse; then release | FLUSH/re-pump existing connection                                        |
| `audiostation`      | Immediate release/fresh resume under its distinct saved identity                      | Conservative Melofon fallback, not measured Synology seek/track behavior |

Set the default for **genuinely new IDs only** with native
`PUT /_/config/airplay.connectionStrategy.default {"value":"owntone"}`.
Legacy rows migrate to Melofon and existing choices survive discovery gaps,
same-ID registrations and unrelated settings writes. Only the three exact
lowercase values are accepted. The UI face is later work.

Playing strategy changes apply at the next discontinuity/idle transition;
switching an OwnTone idle hold to immediate release retires it now. Deselect,
unregister and queue clear release immediately for every choice. OwnTone's
FLUSH compatibility path can be problematic on ATV3; it is an operator choice,
not a guessed model policy. A recognized Apple model is not required for
playback; a complete supported receiver profile is required.

Recovery is finite per explicit demand: initial attempt plus at most seven
automatic slots, default seconds `0,2,5,10,20,30,60`. Pause/Stop/no-op commands
cancel retry authority; catalog/volume/PIN/settings/connected updates do not
refill its budget. `airplay.retry=off` cancels retry work. Exhaustion preserves
queue and selected-speaker preference and requires new explicit demand.
Local release has a five-second final-write budget; failure blocks replacement
until a separately authorized process restart. Local close proves neither
remote acknowledgment nor sound/other-controller availability. Normal decoder
EOF does not truncate buffered audio or change engine track-end semantics.

## Output preparation

Registered speakers, prepared targets, connected sessions and audible playback
are distinct. The shared `src/output-admission.ts` boundary owns preparation,
endpoint revisions, cancellation and single-use activation permits. Protocol
adapters validate acquired facts; the AirPlay coordinator cannot start from a
bare registered address or restore a prepared permit from disk.

Native POST/GET outputs include `preparation`: `unresolved`, `preparing`,
`ready` or `failed`, with target revision and evidence/failure information.
Selection and volume remain operator preferences even when preparation fails.
The OwnTone output/player wire shape is unchanged.

`GET /api/v1/speakers` and its detail route expose independent
`state.preparation`, `state.connection` (`disconnected`, `connecting`,
`connected`, `failed`) and `state.authentication` (`none`,
`authentication_required`). The native helper's generic auth challenge does
not identify a bad password versus a pending PIN. A completed handshake clears
that pending action. Session failures include a safe `state.error`.

`abilities` is null until fresh supported receiver facts are available and
becomes null again when they expire. AirPlay reports volume and source seek,
PIN when receiver verification requires it, password input when the receiver
advertises password protection, and the bridge input format `pcm`, not AAC or
the ALAC wire encoding. Set or clear passwords with the password route above.
These facts do not imply connection or audio delivery. Clients refetch
on `/api/v1/events` `speakers` invalidations, including fact expiry; OwnTone
keeps its `outputs` notification and snake_case auth fields. Reading or
publishing status never creates a playback demand or renews retry authority.

Any signed-in user can `POST /api/v1/speakers/{id}/retry` with JSON `{}`.
It refreshes preparation and renews the bounded retry budget only for that
speaker's current failed playback demand. An explicit Pause or Stop remains
paused or stopped; retry does not select or adopt a speaker. The response is a
current `{speaker}` snapshot, not a promise of connection or sound. Pause, Stop,
forget, deselection or an endpoint change cancels pending playback preparation.

Playback starts require a selected target. No selection or a known-gone idle
speaker fails before changing the clock, queue or bookmark; queue-add-with-play
also leaves the old queue and options intact on refusal. Unknown restored
targets get bounded preparation (`speakers.preparationSeconds`, default 5).
OwnTone reports start refusals as HTTP 500 with explanatory text; an empty
play remains a no-op. Connection and authentication failures after preparation
appear in speaker state. Healthy peers keep playing; loss of the last selected
or usable target pauses at the bookmark. Discovery withdrawal alone does not
interrupt an already connected session. Restart resumes only after fresh target
preparation; otherwise it restores the queue paused at the saved position.

AirPlay manual registration and `MELOFON_AIRPLAY_HOST` perform bounded,
target-specific unicast DNS-SD lookup independently of automatic browsing.
`airplay.mdns=off` disables browsing, not explicit preparation. TXT/SRV/address
completion and supported UDP/44100-Hz/16-bit/stereo configuration are required.
Missing receiver facts never become guessed metadata/auth/encryption settings;
a received optional key's absence can use its documented protocol default.
Password-required receivers can be prepared; the session uses the privately
stored password. Missing or rejected credentials surface as an authentication
challenge in speaker state. Preparation failures follow the existing finite
recovery policy.

### Wi-Fi / Ethernet source changes

Established AirPlay sessions check the kernel's preferred sender source every
two seconds. If a receiver's preferred source changes (including a metric-only
switch with both interfaces still up), the obsolete session is released and
the existing finite `airplay.retry` policy may reconnect at the retained/current
playback position. Startup spanning incompatible RTSP/RTP sources is rejected.
Other receivers whose preferred source is unchanged continue playing.

`airplay.retry=off` still permits detection and local release, but prevents
automatic reconnection. Pause, Stop and deselection cancel recovery authority;
successful reconnects do not refill the demand's retry budget. If no usable
output remains, the existing paused bookmark is retained. OwnTone idle hold
can release obsolete sockets without resuming a user-paused/stopped player.

This detects a preferred-source change, not every network or receiver failure.
Same-source route changes and arbitrary policy routing are outside this check;
recovery may have an audible gap. VM timing bounds are not hardware audibility
or gapless-playback guarantees.

Future server-controlled protocol adapters use this same admission contract
and reusable tests, with their own reachability/auth/format checks. HTTP pull
streams retain their existing decision/preflight boundary. Prepared/connected
status and synthetic receiver tests do not establish sound on a real speaker.

## Structured logging

Application, RAOP and supported dependency diagnostics use one core-owned
raw-event → normalization/redaction → logfmt boundary. Each record is one
physical UTF-8 line with full UTC milliseconds and fixed leading fields:

```text
time=2026-10-07T21:34:56.789Z level=warn component=airplay event=session_failed message="Output session failed" output=123 generation=12 reason=helper_event
```

Debug/info/notice/warning records use stdout; errors/fatals use stderr. Journal
priorities are respectively 7/6/5/4/3/2. Under systemd, use
`StandardOutput=journal`, `StandardError=inherit`, `SyslogLevelPrefix=yes`.
The logger validates each destination's device/inode against `JOURNAL_STREAM`
before emitting a priority prefix; redirected pipes get plain logfmt. Separate
stderr journal sockets/output overrides require review because that environment
variable does not identify them. Melofon does not manage diagnostic log files.

Request/header and query tracing retain their existing opt-in controls:
`MELOFON_DEBUG_LOG_REQUEST=1`, `MELOFON_DEBUG_LOG_HEADERS=1`. HTTP credential
queries/headers and nested password/PIN/key/token fields are redacted centrally.
Request bodies and SQL bind values are not logged; SQL tracing emits only safe
operation/identifier facts. Command attribution remains distinct from login
credentials. Config events name the key, never the value.
Public command identities (`kind`, `via`, peer, username and client) keep their
attribution meaning even when their spelling overlaps an authentication value;
opaque User-Agent/error/dependency text remains subject to known-value masking.

Bootstrap registers configured password/server-secret values before application
or dependency evaluation, scrubbing them from opaque messages and Error stacks.
Normalization snapshots bounded data without custom getters, inspection or
`toJSON`. Ordinary Error stacks use guarded intrinsic projection; custom unsafe
stack paths carry explicit `stack_unavailable`. Loss, truncation and normalization
failures have diagnostic metadata. Quotes/controls use JSON-compatible escaping
following go-logfmt 0.6.0 conventions, not every informal logfmt dialect.

RAOP diagnostics have capture timestamps and native sequence/drop/truncation
facts, separate from control events and audio pacing. `nativeDevice` is the
native identity, not invented core request/output attribution. node-av supplies
only asynchronously observed `(level,message)` payloads (`time_basis=observed`),
with a 4096-byte native formatting limit and no flush acknowledgement. Metadata
`debug` payloads may already be formatted. Arbitrary opaque third-party text is
not provably secret-free. Sequence fields aid diagnosis; separate destinations
and asynchronous delivery do not imply a total event ordering.

Unavoidable Deno diagnostics before bootstrap/internal runtime failures, native
assertion/loader/allocator failures, and unsupported DuckDB/libgcrypt diagnostics
remain raw. They are preserved, not suppressed or represented as redacted logfmt.
Standalone native probes also retain their diagnostic transport.

For diagnosis, correlate `event`, `output`, `generation`, `command`, provenance
and native sequence/loss facts; inspect the original error and preceding events.
`tests/logging-boundary.test.ts` enforces owned TypeScript output boundaries;
ordinary integration consumers also check the compiled native writer inventory.
Journald priority prefixes are covered by `tests/logging.test.ts` and
`tests/logging-integration.test.ts`.

## License

AGPL-3.0-or-later. See LICENSE.
