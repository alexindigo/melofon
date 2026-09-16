-- users + empty catalog tables. listens / stars / playlists wait for M2.
-- No play_count column anywhere: stats are GROUP BY at read time.
CREATE TABLE IF NOT EXISTS users (
  id VARCHAR PRIMARY KEY,
  name VARCHAR UNIQUE NOT NULL,
  password_enc VARCHAR NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
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
  mtime BIGINT,
  size BIGINT,
  title VARCHAR,
  album_id VARCHAR,
  artist_id VARCHAR,
  track INTEGER,
  disc INTEGER,
  duration_ms INTEGER
);
