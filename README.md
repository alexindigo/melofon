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
not a guessed model policy. Unknown model identity does not prevent playback.

Recovery is finite per explicit demand: initial attempt plus at most seven
automatic slots, default seconds `0,2,5,10,20,30,60`. Pause/Stop/no-op commands
cancel retry authority; catalog/volume/PIN/settings/connected updates do not
refill its budget. `airplay.retry=off` cancels retry work. Exhaustion preserves
queue and selected-speaker preference and requires new explicit demand.
Local release has a five-second final-write budget; failure blocks replacement
until a separately authorized process restart. Local close proves neither
remote acknowledgment nor sound/other-controller availability. Normal decoder
EOF does not truncate buffered audio or change engine track-end semantics.

## License

AGPL-3.0-or-later. See LICENSE.
