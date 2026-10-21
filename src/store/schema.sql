-- users + catalog tables + M2 user-state tables. The scan rebuilds only the
-- catalog (files/albums/artists). User state and libraries are keep-on-rescan.
-- No play_count column anywhere: stats are GROUP BY at read time.
-- NB: db.ts splits this file on the semicolon character, so comments must
-- never contain one.
CREATE TABLE IF NOT EXISTS users (
  id VARCHAR PRIMARY KEY,
  name VARCHAR UNIQUE NOT NULL,
  password_enc VARCHAR NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
-- H9: users.ts migrates only unset roles, then installs the regular-user default.
ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR;
-- M3 scan sources: disjoint folders, one OpenSubsonic music folder per row.
-- Keep-on-rescan: the scan reads this table, never writes it.
CREATE TABLE IF NOT EXISTS libraries (
  id VARCHAR PRIMARY KEY,
  name VARCHAR NOT NULL,
  path VARCHAR UNIQUE NOT NULL
);
CREATE TABLE IF NOT EXISTS artists (
  id VARCHAR PRIMARY KEY,
  name VARCHAR NOT NULL
);
ALTER TABLE artists ADD COLUMN IF NOT EXISTS musicbrainz_id VARCHAR;
CREATE TABLE IF NOT EXISTS albums (
  id VARCHAR PRIMARY KEY,
  name VARCHAR NOT NULL,
  album_artist_id VARCHAR
);
ALTER TABLE albums ALTER COLUMN name DROP NOT NULL;
ALTER TABLE albums ADD COLUMN IF NOT EXISTS artist_kind VARCHAR;
ALTER TABLE albums ADD COLUMN IF NOT EXISTS library_id VARCHAR;
ALTER TABLE albums ADD COLUMN IF NOT EXISTS root_dir VARCHAR;
ALTER TABLE albums ADD COLUMN IF NOT EXISTS folder_name VARCHAR;
CREATE TABLE IF NOT EXISTS files (
  id VARCHAR PRIMARY KEY,
  path VARCHAR UNIQUE NOT NULL,
  library_id VARCHAR,
  mtime BIGINT,
  size BIGINT,
  title VARCHAR,
  album_id VARCHAR,
  artist_id VARCHAR,
  track INTEGER,
  disc INTEGER,
  duration_ms INTEGER,
  genre VARCHAR,
  year INTEGER
);
-- M3: existing M2 databases gain library_id without a rebuild.
ALTER TABLE files ADD COLUMN IF NOT EXISTS library_id VARCHAR;
-- M3: genre is the first TCON value (single-valued, like the track artist).
ALTER TABLE files ADD COLUMN IF NOT EXISTS genre VARCHAR;
-- M3 amendment: year from TDRC/TYER (byYear album lists).
ALTER TABLE files ADD COLUMN IF NOT EXISTS year INTEGER;
-- M4: music videos share the files row with audio (probe-decided, M3.5
-- app.media). NULL on rows scanned before M4 reads as not-video.
ALTER TABLE files ADD COLUMN IF NOT EXISTS is_video BOOLEAN;
-- H8: the first embedded picture, hashed by the scanner for local conflicts.
ALTER TABLE files ADD COLUMN IF NOT EXISTS picture_hash VARCHAR;

-- H7: scan-owned facts. Old catalog rows acquire them on their next scan.
ALTER TABLE files ADD COLUMN IF NOT EXISTS bit_rate DOUBLE;
ALTER TABLE files ADD COLUMN IF NOT EXISTS bit_depth INTEGER;
ALTER TABLE files ADD COLUMN IF NOT EXISTS sample_rate INTEGER;
ALTER TABLE files ADD COLUMN IF NOT EXISTS channels INTEGER;
ALTER TABLE files ADD COLUMN IF NOT EXISTS track_gain DOUBLE;
ALTER TABLE files ADD COLUMN IF NOT EXISTS track_peak DOUBLE;
ALTER TABLE files ADD COLUMN IF NOT EXISTS album_gain DOUBLE;
ALTER TABLE files ADD COLUMN IF NOT EXISTS album_peak DOUBLE;
ALTER TABLE files ADD COLUMN IF NOT EXISTS base_gain DOUBLE;
ALTER TABLE files ADD COLUMN IF NOT EXISTS recording_mbid VARCHAR;
ALTER TABLE files ADD COLUMN IF NOT EXISTS artist_mbid VARCHAR;
ALTER TABLE files ADD COLUMN IF NOT EXISTS album_artist_mbid VARCHAR;
ALTER TABLE files ADD COLUMN IF NOT EXISTS isrc VARCHAR[];
ALTER TABLE files ADD COLUMN IF NOT EXISTS genres VARCHAR[];
ALTER TABLE files ADD COLUMN IF NOT EXISTS moods VARCHAR[];
ALTER TABLE files ADD COLUMN IF NOT EXISTS comment VARCHAR;
ALTER TABLE files ADD COLUMN IF NOT EXISTS sort_title VARCHAR;
ALTER TABLE files ADD COLUMN IF NOT EXISTS bpm INTEGER;
ALTER TABLE files ADD COLUMN IF NOT EXISTS explicit VARCHAR;
ALTER TABLE files ADD COLUMN IF NOT EXISTS disc_subtitle VARCHAR;
ALTER TABLE files ADD COLUMN IF NOT EXISTS album_mbid VARCHAR;
ALTER TABLE files ADD COLUMN IF NOT EXISTS record_labels VARCHAR[];
ALTER TABLE files ADD COLUMN IF NOT EXISTS release_types VARCHAR[];
ALTER TABLE files ADD COLUMN IF NOT EXISTS release_date VARCHAR;
ALTER TABLE files ADD COLUMN IF NOT EXISTS original_release_date VARCHAR;
ALTER TABLE files ADD COLUMN IF NOT EXISTS compilation BOOLEAN;
ALTER TABLE files ADD COLUMN IF NOT EXISTS version VARCHAR;
ALTER TABLE files ADD COLUMN IF NOT EXISTS album_sort_name VARCHAR;
ALTER TABLE albums ADD COLUMN IF NOT EXISTS musicbrainz_id VARCHAR;
ALTER TABLE albums ADD COLUMN IF NOT EXISTS record_labels VARCHAR[];
ALTER TABLE albums ADD COLUMN IF NOT EXISTS release_types VARCHAR[];
ALTER TABLE albums ADD COLUMN IF NOT EXISTS genres VARCHAR[];
ALTER TABLE albums ADD COLUMN IF NOT EXISTS moods VARCHAR[];
ALTER TABLE albums ADD COLUMN IF NOT EXISTS release_date VARCHAR;
ALTER TABLE albums ADD COLUMN IF NOT EXISTS original_release_date VARCHAR;
ALTER TABLE albums ADD COLUMN IF NOT EXISTS compilation BOOLEAN;
ALTER TABLE albums ADD COLUMN IF NOT EXISTS version VARCHAR;
ALTER TABLE albums ADD COLUMN IF NOT EXISTS sort_name VARCHAR;
ALTER TABLE albums ADD COLUMN IF NOT EXISTS explicit VARCHAR;
ALTER TABLE albums ADD COLUMN IF NOT EXISTS disc_titles JSON;

-- M2 user state (keep-on-rescan: scan never deletes from these).
CREATE TABLE IF NOT EXISTS listens (
  user_id VARCHAR NOT NULL,
  track_id VARCHAR NOT NULL,
  played_at TIMESTAMPTZ NOT NULL,
  duration_ms INTEGER,
  source VARCHAR NOT NULL
);
CREATE TABLE IF NOT EXISTS stars (
  user_id VARCHAR NOT NULL,
  target_id VARCHAR NOT NULL,
  target_type VARCHAR NOT NULL,
  starred_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (user_id, target_id, target_type)
);
CREATE TABLE IF NOT EXISTS ratings (
  user_id VARCHAR NOT NULL,
  target_id VARCHAR NOT NULL,
  rating INTEGER NOT NULL,
  PRIMARY KEY (user_id, target_id)
);
CREATE TABLE IF NOT EXISTS playlists (
  id VARCHAR PRIMARY KEY,
  user_id VARCHAR NOT NULL,
  name VARCHAR NOT NULL,
  comment VARCHAR,
  created_at TIMESTAMPTZ NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS playlist_tracks (
  playlist_id VARCHAR NOT NULL,
  position INTEGER NOT NULL,
  track_id VARCHAR NOT NULL,
  PRIMARY KEY (playlist_id, position)
);
-- H9: existing and new playlists are private unless their owner publishes them.
ALTER TABLE playlists ADD COLUMN IF NOT EXISTS public BOOLEAN DEFAULT false;
CREATE TABLE IF NOT EXISTS play_queues (
  user_id VARCHAR PRIMARY KEY,
  current_index INTEGER,
  position_ms INTEGER,
  changed_at TIMESTAMPTZ NOT NULL,
  track_ids VARCHAR[] NOT NULL,
  changed_by VARCHAR
);
-- M4.5: the saving client's name (the Subsonic `c` param), for the required
-- PlayQueue.changedBy wire field. NULL on rows saved before M4.5.
ALTER TABLE play_queues ADD COLUMN IF NOT EXISTS changed_by VARCHAR;
-- M3: per-user playback-position bookmarks (keep-on-rescan).
CREATE TABLE IF NOT EXISTS bookmarks (
  user_id VARCHAR NOT NULL,
  track_id VARCHAR NOT NULL,
  position_ms BIGINT NOT NULL,
  comment VARCHAR,
  created_at TIMESTAMPTZ NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (user_id, track_id)
);
-- M3 amendment: now-playing, one row per (user, client) like Navidrome's
-- player-keyed NowPlaying. scrobble submission=false replaces the row;
-- submission=true never touches it (that path is append-only listens).
-- stream_id (playback-core): the stream/report that minted this row —
-- reportStopped clears only when its streamId is still the current one
-- (an older Range completing must not clear a newer stream).
CREATE TABLE IF NOT EXISTS now_playing (
  user_id VARCHAR NOT NULL,
  client VARCHAR NOT NULL,
  track_id VARCHAR NOT NULL,
  position_ms BIGINT,
  started_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (user_id, client)
);
ALTER TABLE now_playing ADD COLUMN IF NOT EXISTS stream_id VARCHAR;
-- G2: retained client identity is separate from the ephemeral playback session.
CREATE SEQUENCE IF NOT EXISTS client_player_number START 1;
CREATE TABLE IF NOT EXISTS client_players (
  user_id VARCHAR NOT NULL,
  client VARCHAR NOT NULL,
  player_id BIGINT DEFAULT nextval('client_player_number') UNIQUE NOT NULL,
  PRIMARY KEY (user_id, client)
);
ALTER TABLE now_playing ADD COLUMN IF NOT EXISTS state VARCHAR DEFAULT 'playing';
ALTER TABLE now_playing ADD COLUMN IF NOT EXISTS playback_rate DOUBLE DEFAULT 1;
ALTER TABLE now_playing ADD COLUMN IF NOT EXISTS reported_at TIMESTAMPTZ;
ALTER TABLE now_playing ADD COLUMN IF NOT EXISTS duration_ms BIGINT;
-- M6: internal state (app.state) — operator-owned live config. The /_/config
-- endpoints are its face, and the Settings UI (M5) will be a form on them.
CREATE TABLE IF NOT EXISTS state (
  key VARCHAR PRIMARY KEY,
  value VARCHAR NOT NULL
);
ALTER TABLE state ADD COLUMN IF NOT EXISTS revision BIGINT DEFAULT 0;
ALTER TABLE state ADD COLUMN IF NOT EXISTS declared BOOLEAN DEFAULT false;
-- Restart transparency (plan restart-transparency): the server engine's queue
-- and player state, keep-on-rescan user state. The queue stores library song
-- ids in order and rehydrates via the library at boot (missing tracks drop).
CREATE TABLE IF NOT EXISTS server_queue (
  pos INTEGER PRIMARY KEY,
  song_id VARCHAR NOT NULL
);
-- One-row table (id = 1): the last persisted engine snapshot. updated_at
-- (tz-aware, like now_playing.started_at) drives the resume-freshness
-- window (MELOFON_RESUME_MAX_AGE_SEC).
CREATE TABLE IF NOT EXISTS player_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  state VARCHAR NOT NULL,
  current_index INTEGER,
  position_ms BIGINT,
  repeat VARCHAR,
  shuffle BOOLEAN,
  consume BOOLEAN,
  updated_at TIMESTAMPTZ
);
-- The outputs' remotes, mDNS-discovered and hand-added alike: id is the
-- OwnTone digit id (airplayOutputId / mDNS id). unregister never deletes —
-- the row is the last-seen state a re-announced or rebooted device falls
-- back to. Session knobs (devtype/encrypt/…) are not here: discovery
-- re-derives them from TXT.
CREATE TABLE IF NOT EXISTS output_state (
  id VARCHAR PRIMARY KEY,
  host VARCHAR,
  port INTEGER,
  name VARCHAR,
  type VARCHAR,
  selected BOOLEAN NOT NULL,
  volume INTEGER NOT NULL
);
-- ATV3 session recycle (plan atv3-session-recycle): the raw device model
-- (TXT `am`, e.g. AppleTV3,1) is identity, persisted so the recycle policy
-- survives a restart. NULL on rows saved before this column reads unknown.
ALTER TABLE output_state ADD COLUMN IF NOT EXISTS model VARCHAR;
-- Connection strategies: legacy speakers retain the chosen Melofon policy.
ALTER TABLE output_state ADD COLUMN IF NOT EXISTS connection_strategy VARCHAR DEFAULT 'melofon';
UPDATE output_state SET connection_strategy = 'melofon' WHERE connection_strategy IS NULL;
-- H3 star history: every star and unstar is one appended event. Rows are
-- never updated or deleted. seq (from star_event_seq) orders a user's events
-- for an item. The latest event says whether the item is starred now, and
-- every star event is one like. The legacy stars table above is read only by
-- the one-time migration below, which copies existing stars as star events
-- with their original dates (only while star_events is still empty).
CREATE SEQUENCE IF NOT EXISTS star_event_seq;
CREATE TABLE IF NOT EXISTS star_events (
  seq BIGINT PRIMARY KEY DEFAULT nextval('star_event_seq'),
  user_id VARCHAR NOT NULL,
  target_id VARCHAR NOT NULL,
  target_type VARCHAR NOT NULL,
  action VARCHAR NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL
);
INSERT INTO star_events (user_id, target_id, target_type, action, occurred_at)
  SELECT user_id, target_id, target_type, 'star', starred_at FROM stars
  WHERE NOT EXISTS (SELECT 1 FROM star_events)
  ORDER BY starred_at, user_id, target_id;

-- Keep-on-rescan song identity: id is the files/song id first assigned on scan.
-- The scan is the sole writer and enforces one row per (library_id, rel_path).
-- No unique path index: DuckDB index updates on changed keys are fragile.
CREATE TABLE IF NOT EXISTS file_identity (
  id VARCHAR PRIMARY KEY,
  library_id VARCHAR NOT NULL,
  rel_path VARCHAR NOT NULL,
  present BOOLEAN NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  size BIGINT,
  mtime_ms BIGINT,
  dev BIGINT,
  ino BIGINT,
  fingerprint VARCHAR,
  pcm_md5 VARCHAR
);
-- Append-only history. kind is linked, ambiguous or audio_changed.
CREATE SEQUENCE IF NOT EXISTS file_event_seq;
CREATE TABLE IF NOT EXISTS file_events (
  seq BIGINT PRIMARY KEY DEFAULT nextval('file_event_seq'),
  occurred_at TIMESTAMPTZ NOT NULL,
  kind VARCHAR NOT NULL,
  file_id VARCHAR NOT NULL,
  fingerprint VARCHAR,
  from_library_id VARCHAR,
  from_path VARCHAR,
  to_library_id VARCHAR,
  to_path VARCHAR,
  candidates VARCHAR[]
);
ALTER TABLE file_identity ADD COLUMN IF NOT EXISTS album_id VARCHAR;
-- Retained album identity and append-only scan decisions.
CREATE TABLE IF NOT EXISTS album_identity (
  id VARCHAR PRIMARY KEY,
  library_id VARCHAR NOT NULL,
  root_dir VARCHAR NOT NULL,
  present BOOLEAN NOT NULL
);
CREATE SEQUENCE IF NOT EXISTS album_event_seq;
CREATE TABLE IF NOT EXISTS album_events (
  seq BIGINT PRIMARY KEY DEFAULT nextval('album_event_seq'),
  "at" TIMESTAMP NOT NULL,
  kind VARCHAR NOT NULL,
  album_id VARCHAR NOT NULL,
  from_library_id VARCHAR,
  from_root VARCHAR,
  to_library_id VARCHAR,
  to_root VARCHAR,
  candidates VARCHAR[]
);

-- Kept satellite proposals and persistent lookup work, never rebuilt by scans.
ALTER TABLE files ADD COLUMN IF NOT EXISTS has_lyrics BOOLEAN DEFAULT false;
CREATE SEQUENCE IF NOT EXISTS candidate_seq;
CREATE TABLE IF NOT EXISTS candidates (
  id VARCHAR PRIMARY KEY,
  seq BIGINT DEFAULT nextval('candidate_seq'),
  entity_type VARCHAR NOT NULL CHECK (entity_type IN ('album', 'song', 'artist')),
  entity_id VARCHAR NOT NULL,
  kind VARCHAR NOT NULL CHECK (kind IN ('cover', 'fields', 'lyrics')),
  source VARCHAR NOT NULL,
  confidence VARCHAR CHECK (confidence IN ('strong', 'medium', 'low')),
  state VARCHAR NOT NULL CHECK (state IN ('open', 'accepted', 'rejected', 'edited')),
  image_hash VARCHAR NOT NULL,
  image_ext VARCHAR NOT NULL,
  library_id VARCHAR,
  origin VARCHAR NOT NULL,
  found_at TIMESTAMPTZ NOT NULL,
  decided_at TIMESTAMPTZ,
  details JSON NOT NULL
);
CREATE SEQUENCE IF NOT EXISTS lookup_job_seq;
-- Reference knowledge is kept independently of catalog rebuilds and candidates.
CREATE TABLE IF NOT EXISTS reference_facts (
  entity_type VARCHAR NOT NULL CHECK (entity_type IN ('artist', 'track')),
  entity_id VARCHAR NOT NULL,
  name VARCHAR NOT NULL,
  plugin VARCHAR NOT NULL,
  value JSON,
  fetched_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (entity_type, entity_id, name, plugin)
);
CREATE TABLE IF NOT EXISTS lookup_jobs (
  id VARCHAR PRIMARY KEY,
  seq BIGINT DEFAULT nextval('lookup_job_seq'),
  plugin VARCHAR NOT NULL,
  entity_type VARCHAR NOT NULL CHECK (entity_type IN ('album', 'song', 'artist')),
  entity_id VARCHAR NOT NULL,
  facts_hash VARCHAR NOT NULL,
  mode VARCHAR NOT NULL CHECK (mode IN ('missing', 'all')),
  state VARCHAR NOT NULL CHECK (state IN ('waiting', 'active', 'done', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error VARCHAR,
  queued_at TIMESTAMPTZ NOT NULL,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  not_before TIMESTAMPTZ NOT NULL
);
