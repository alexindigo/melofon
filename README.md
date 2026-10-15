# Melofon

Household music server: library + HTTP streamer + speaker control.
Greenfield replacement for Navidrome (OpenSubsonic stays so existing apps keep working).

## Start

```bash
export MELOFON_LISTEN=127.0.0.1:8000
export MELOFON_DATA=./data
export MELOFON_USER=admin
export MELOFON_PASSWORD=change-me
export MELOFON_SECRET=another-secret
mkdir -p "$MELOFON_DATA"
deno task start
```

Scan sources live in the database (not env). Add each music folder once —
it persists and is scanned on every boot:

```bash
curl -X POST -H 'content-type: application/json' \
  -d '{"name": "Music", "path": "/path/to/music"}' \
  http://127.0.0.1:8000/_/libraries
```

`GET /_/libraries` lists sources, `DELETE /_/libraries/<id>` removes one
(and its catalog rows). `getMusicFolders` on `/rest` is the OpenSubsonic
view of the same list.

`GET /_/health` returns `{"ok":true}` once the DuckDB index is open.
`MELOFON_LISTEN` unset → Deno.serve default. Never commit `.env`, `.envrc`,
or anything under `data/` — the secret and the password live in env only.

## Catalog identity

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
the current catalog: an album counts its songs' plays, an artist those of its
albums. Fields without data are omitted, except the OpenSubsonic additions, which
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
command. The endpoint follows the existing trusted-network native `/_/` binds
and unauthenticated exposure. OwnTone `/api/player` retains its eight existing
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

AirPlay manual registration and `MELOFON_AIRPLAY_HOST` perform bounded,
target-specific unicast DNS-SD lookup independently of automatic browsing.
`airplay.mdns=off` disables browsing, not explicit preparation. TXT/SRV/address
completion and supported UDP/44100-Hz/16-bit/stereo configuration are required.
Missing receiver facts never become guessed metadata/auth/encryption settings;
a received optional key's absence can use its documented protocol default.
Password-required receivers remain unsupported and cannot receive an admitted
session. Preparation failures follow the existing finite recovery policy.

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
