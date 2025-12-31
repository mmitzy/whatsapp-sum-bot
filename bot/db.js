const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();

const DATA_DIR = path.join(__dirname, '..', 'data');

// cache open connections so we don't reopen on every message
const dbCache = new Map();

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// make chat id safe as a filename
function dbPathForChat(chatId) {
  const safe = chatId.replace(/[@:]/g, '_');
  return path.join(DATA_DIR, `${safe}.sqlite`);
}

function initSchema(db) {
  db.serialize(() => {
    db.run(`
      CREATE TABLE IF NOT EXISTS messages (
        msg_id      TEXT PRIMARY KEY,
        ts          INTEGER NOT NULL,
        author_id   TEXT,
        author_name TEXT,
        body        TEXT
      )
    `);
    db.run(`CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts)`);
  });
}

function getDb(chatId) {
  ensureDataDir();

  if (dbCache.has(chatId)) return dbCache.get(chatId);

  const p = dbPathForChat(chatId);
  const db = new sqlite3.Database(p);
  initSchema(db);

  dbCache.set(chatId, db);
  return db;
}

function insertMessage(chatId, row) {
  const db = getDb(chatId);
  db.run(
    `INSERT OR IGNORE INTO messages (msg_id, ts, author_id, author_name, body)
     VALUES (?, ?, ?, ?, ?)`,
    [row.msg_id, row.ts, row.author_id, row.author_name, row.body]
  );
}

function countMessages(chatId) {
  const db = getDb(chatId);
  return new Promise((resolve, reject) => {
    db.get(`SELECT COUNT(*) AS cnt FROM messages`, (err, row) => {
      if (err) return reject(err);
      resolve(row?.cnt ?? 0);
    });
  });
}

module.exports = { getDb, insertMessage, countMessages, dbPathForChat };
