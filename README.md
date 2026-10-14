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
Form values precede query values: scalar getters use the first form value;
repeated getters retain form values followed by query values. Both methods reach
the same injected core services and canonical state.

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
The contained journal acceptance tool is `dev/logging/verify-service.ts`, for the
identified development VM only, never the household service.

## License

AGPL-3.0-or-later. See LICENSE.
