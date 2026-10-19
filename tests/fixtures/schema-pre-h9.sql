-- Verbatim affected table definitions from 4f9b861:src/store/schema.sql.
-- Other tables are recreated by normal openStore initialization.
CREATE TABLE IF NOT EXISTS users (
  id VARCHAR PRIMARY KEY,
  name VARCHAR UNIQUE NOT NULL,
  password_enc VARCHAR NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
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
