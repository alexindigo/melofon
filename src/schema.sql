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
CREATE TABLE IF NOT EXISTS albums (
  id VARCHAR PRIMARY KEY,
  name VARCHAR NOT NULL,
  album_artist_id VARCHAR
);
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
CREATE TABLE IF NOT EXISTS play_queues (
  user_id VARCHAR PRIMARY KEY,
  current_id VARCHAR,
  position_ms INTEGER,
  changed_at TIMESTAMPTZ NOT NULL,
  track_ids VARCHAR[] NOT NULL
);
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
CREATE TABLE IF NOT EXISTS now_playing (
  user_id VARCHAR NOT NULL,
  client VARCHAR NOT NULL,
  track_id VARCHAR NOT NULL,
  position_ms BIGINT,
  started_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (user_id, client)
);
