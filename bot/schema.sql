-- bot/schema.sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

-- All messages for all groups live here
CREATE TABLE IF NOT EXISTS messages (
  chat_id        TEXT NOT NULL,         -- "...@g.us"
  msg_id         TEXT NOT NULL,         -- message.id._serialized (plus :text/:media if you split)
  ts             INTEGER NOT NULL,      -- unix seconds
  author_id      TEXT,                  -- "...@lid" or "...@c.us"
  author_name    TEXT,                  -- resolved display at time of insert
  body           TEXT,
  has_media      INTEGER DEFAULT 0,
  entry_type     TEXT DEFAULT 'text',   -- 'text' | 'media'
  media_type     TEXT,
  media_mimetype TEXT,
  media_filename TEXT,
  media_size     INTEGER,

  PRIMARY KEY (chat_id, msg_id)
);

CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages(chat_id, ts);
CREATE INDEX IF NOT EXISTS idx_messages_chat_author ON messages(chat_id, author_id);
CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts);

-- Alias mapping (author_id -> label) + economy fields
CREATE TABLE IF NOT EXISTS identities (
  author_id     TEXT PRIMARY KEY,  -- same value you store in messages.author_id
  label         TEXT NOT NULL,
  updated_ts    INTEGER NOT NULL,
  balance       INTEGER NOT NULL DEFAULT 0,
  last_daily_ts INTEGER
);

CREATE INDEX IF NOT EXISTS idx_identities_updated ON identities(updated_ts);
CREATE INDEX IF NOT EXISTS idx_identities_label ON identities(label);

-- Future: store summaries
CREATE TABLE IF NOT EXISTS summaries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id     TEXT NOT NULL,
  window_from INTEGER NOT NULL,
  window_to   INTEGER NOT NULL,
  created_ts  INTEGER NOT NULL,
  summary     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_summaries_chat_created ON summaries(chat_id, created_ts);

-- Per-group "inside jokes" watchlist
CREATE TABLE IF NOT EXISTS jokes (
  chat_id     TEXT NOT NULL,
  phrase      TEXT NOT NULL,
  added_by    TEXT,
  created_ts  INTEGER NOT NULL,
  PRIMARY KEY (chat_id, phrase)
);

CREATE INDEX IF NOT EXISTS idx_jokes_chat_created ON jokes(chat_id, created_ts);

-- Media objects: one row per stored blob (dedupe by sha256)
CREATE TABLE IF NOT EXISTS media_objects (
  media_id       INTEGER PRIMARY KEY AUTOINCREMENT,
  sha256         TEXT NOT NULL UNIQUE,
  kind           TEXT NOT NULL,              -- 'image' (for now)
  mime           TEXT NOT NULL,              -- image/jpeg, image/png, image/webp
  size           INTEGER NOT NULL,           -- bytes
  width          INTEGER,
  height         INTEGER,
  storage        TEXT NOT NULL,              -- 'local' now, 'r2' later
  ref            TEXT NOT NULL,              -- local://images/2026/02/<sha>.jpg  OR  r2://...
  status         TEXT NOT NULL DEFAULT 'stored',  -- 'stored' | 'deleted' | 'missing'
  created_ts     INTEGER NOT NULL,
  last_access_ts INTEGER,
  extra_json     TEXT
);

CREATE INDEX IF NOT EXISTS idx_media_objects_created ON media_objects(created_ts);
CREATE INDEX IF NOT EXISTS idx_media_objects_last_access ON media_objects(last_access_ts);
