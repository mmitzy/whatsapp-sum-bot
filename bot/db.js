const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();

const DATA_DIR = path.join(__dirname, '..', 'data');

// Cache open connections (one per group DB)
const dbCache = new Map();

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Make chat id safe as a filename
function dbPathForChat(chatId) {
  const safe = chatId.replace(/[@:]/g, '_');
  return path.join(DATA_DIR, `${safe}.sqlite`);
}

// Create table + add new columns if DB already exists (simple migration)
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

    // Add/upgrade columns (ignore duplicate column errors)
    const addCols = [
      `ALTER TABLE messages ADD COLUMN has_media INTEGER DEFAULT 0`,
      `ALTER TABLE messages ADD COLUMN entry_type TEXT DEFAULT 'text'`,
      `ALTER TABLE messages ADD COLUMN media_type TEXT`,
      `ALTER TABLE messages ADD COLUMN media_mimetype TEXT`,
      `ALTER TABLE messages ADD COLUMN media_filename TEXT`,
      `ALTER TABLE messages ADD COLUMN media_size INTEGER`
    ];

    for (const sql of addCols) {
      db.run(sql, (err) => {
        if (err && !String(err.message || '').includes('duplicate column name')) {
          console.error('Schema update error:', err.message);
        }
      });
    }

    db.run(`CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_messages_entry_type ON messages(entry_type)`);
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

function insertRow(chatId, row) {
  const db = getDb(chatId);
  db.run(
    `INSERT OR IGNORE INTO messages
      (msg_id, ts, author_id, author_name, body, has_media, entry_type,
       media_type, media_mimetype, media_filename, media_size)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.msg_id,
      row.ts,
      row.author_id,
      row.author_name,
      row.body,
      row.has_media ? 1 : 0,
      row.entry_type || 'text',
      row.media_type || null,
      row.media_mimetype || null,
      row.media_filename || null,
      row.media_size ?? null
    ]
  );
}

// Exclude commands (text rows starting with "!")
function countMessages(chatId) {
  const db = getDb(chatId);
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT COUNT(*) AS cnt
       FROM messages
       WHERE NOT (entry_type='text' AND body LIKE '!%')`,
      (err, row) => {
        if (err) return reject(err);
        resolve(row?.cnt ?? 0);
      }
    );
  });
}

function getRanks(chatId, limit = 10) {
  const db = getDb(chatId);
  const lim = Math.max(1, Math.min(limit, 30));

  return new Promise((resolve, reject) => {
    db.all(
      `
      SELECT
        COALESCE(NULLIF(TRIM(author_name), ''), author_id, 'Unknown') AS who,
        COUNT(*) AS cnt
      FROM messages
      WHERE NOT (entry_type='text' AND body LIKE '!%')
      GROUP BY who
      ORDER BY cnt DESC
      LIMIT ?
      `,
      [lim],
      (err, rows) => {
        if (err) return reject(err);
        resolve(rows || []);
      }
    );
  });
}

function getSchema(chatId) {
  const db = getDb(chatId);
  return new Promise((resolve, reject) => {
    db.all(`PRAGMA table_info(messages)`, (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

function getLastRows(chatId, limit = 5) {
  const db = getDb(chatId);
  const lim = Math.max(1, Math.min(limit, 20));

  return new Promise((resolve, reject) => {
    db.all(
      `
      SELECT
        ts,
        entry_type,
        has_media,
        COALESCE(NULLIF(TRIM(author_name), ''), author_id, 'Unknown') AS who,
        body,
        media_type
      FROM messages
      WHERE NOT (entry_type='text' AND body LIKE '!%')
      ORDER BY ts DESC
      LIMIT ?
      `,
      [lim],
      (err, rows) => {
        if (err) return reject(err);
        resolve(rows || []);
      }
    );
  });
}

module.exports = {
  getDb,
  insertRow,
  countMessages,
  getRanks,
  getSchema,
  getLastRows,
  dbPathForChat
};
