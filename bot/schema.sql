CREATE TABLE IF NOT EXISTS messages (
  msg_id      TEXT PRIMARY KEY,
  chat_id     TEXT NOT NULL,
  chat_name   TEXT,
  ts          INTEGER NOT NULL,
  author_id   TEXT,
  author_name TEXT,
  body        TEXT,
  has_media   INTEGER DEFAULT 0,
  raw_json    TEXT
);

CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages(chat_id, ts);

CREATE TABLE IF NOT EXISTS summaries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id     TEXT NOT NULL,
  window_from INTEGER NOT NULL,
  window_to   INTEGER NOT NULL,
  created_ts  INTEGER NOT NULL,
  summary     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_summaries_chat_ts ON summaries(chat_id, created_ts);
