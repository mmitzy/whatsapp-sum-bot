-- bot/schema.sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

-- All messages for all groups live here
CREATE TABLE IF NOT EXISTS messages (
  chat_id       TEXT NOT NULL,         -- "...@g.us"
  msg_id        TEXT NOT NULL,         -- message.id._serialized (plus :text/:media if you split)
  ts            INTEGER NOT NULL,      -- unix seconds
  author_id     TEXT,                  -- "...@lid" or "...@c.us"
  author_name   TEXT,                  -- resolved display at time of insert
  body          TEXT,
  has_media     INTEGER DEFAULT 0,
  entry_type    TEXT DEFAULT 'text',   -- 'text' | 'media'
  media_type    TEXT,
  media_mimetype TEXT,
  media_filename TEXT,
  media_size     INTEGER,

  PRIMARY KEY (chat_id, msg_id)
);

CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages(chat_id, ts);
CREATE INDEX IF NOT EXISTS idx_messages_chat_author ON messages(chat_id, author_id);
CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts);

-- Alias mapping (author_id -> label)
CREATE TABLE IF NOT EXISTS identities (
  author_id  TEXT PRIMARY KEY,  -- same value you store in messages.author_id
  label      TEXT NOT NULL,
  updated_ts INTEGER NOT NULL
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
