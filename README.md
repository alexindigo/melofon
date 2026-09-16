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

## License

AGPL-3.0-or-later. See LICENSE.
