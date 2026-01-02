const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const config = require('./config');

const DATA_DIR = config.DATA_DIR;

// Per-group DB cache
const groupDbCache = new Map();

// Global identity DB cache
let identityDb = null;

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function dbPathForChat(chatId) {
  const safe = chatId.replace(/[@:]/g, '_');
  return path.join(DATA_DIR, `${safe}.sqlite`);
}

function identityDbPath() {
  return path.join(DATA_DIR, config.IDENTITIES_DB_FILE);
}

// ---- Group DB schema ----
function initGroupSchema(db) {
  db.serialize(() => {
    db.run(`
      CREATE TABLE IF NOT EXISTS messages (
        msg_id         TEXT PRIMARY KEY,
        ts             INTEGER NOT NULL,
        author_id      TEXT,
        author_name    TEXT,
        body           TEXT,
        has_media      INTEGER DEFAULT 0,
        entry_type     TEXT DEFAULT 'text',
        media_type     TEXT,
        media_mimetype TEXT,
        media_filename TEXT,
        media_size     INTEGER
      )
    `);

    db.run(`CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_messages_entry_type ON messages(entry_type)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_messages_author_id ON messages(author_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_messages_author_name ON messages(author_name)`);
  });
}

function getGroupDb(chatId) {
  ensureDataDir();

  if (groupDbCache.has(chatId)) return groupDbCache.get(chatId);

  const p = dbPathForChat(chatId);
  const db = new sqlite3.Database(p);
  initGroupSchema(db);

  groupDbCache.set(chatId, db);
  return db;
}

// ---- Identity DB schema ----
function initIdentitySchema(db) {
  db.serialize(() => {
    db.run(`
      CREATE TABLE IF NOT EXISTS identities (
        wa_id      TEXT PRIMARY KEY,
        label      TEXT NOT NULL,
        updated_ts INTEGER NOT NULL
      )
    `);
    db.run(`CREATE INDEX IF NOT EXISTS idx_identities_updated ON identities(updated_ts)`);
  });
}

function getIdentityDb() {
  ensureDataDir();

  if (identityDb) return identityDb;

  const p = identityDbPath();
  identityDb = new sqlite3.Database(p);
  initIdentitySchema(identityDb);

  return identityDb;
}

// ---- Inserts / queries ----
function insertRow(chatId, row) {
  const db = getGroupDb(chatId);
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

function countMessages(chatId) {
  const db = getGroupDb(chatId);
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
  const db = getGroupDb(chatId);
  const lim = Math.max(1, Math.min(limit, 30));

  return new Promise((resolve, reject) => {
    db.all(
      `
      SELECT
        COALESCE(NULLIF(TRIM(author_name), ''), 'Unknown') AS who,
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
  const db = getGroupDb(chatId);
  return new Promise((resolve, reject) => {
    db.all(`PRAGMA table_info(messages)`, (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

function getLastRows(chatId, limit = 5) {
  const db = getGroupDb(chatId);
  const lim = Math.max(1, Math.min(limit, 20));

  return new Promise((resolve, reject) => {
    db.all(
      `
      SELECT
        ts,
        entry_type,
        has_media,
        COALESCE(NULLIF(TRIM(author_name), ''), 'Unknown') AS who,
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

// ---- Identity mapping API ----
function setIdentity(waId, label) {
  const db = getIdentityDb();
  const ts = Math.floor(Date.now() / 1000);

  return new Promise((resolve, reject) => {
    db.run(
      `
      INSERT INTO identities (wa_id, label, updated_ts)
      VALUES (?, ?, ?)
      ON CONFLICT(wa_id) DO UPDATE SET
        label=excluded.label,
        updated_ts=excluded.updated_ts
      `,
      [waId, label, ts],
      (err) => {
        if (err) return reject(err);
        resolve(true);
      }
    );
  });
}

function getIdentity(waId) {
  const db = getIdentityDb();
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT label FROM identities WHERE wa_id = ?`,
      [waId],
      (err, row) => {
        if (err) return reject(err);
        resolve(row?.label || null);
      }
    );
  });
}

function listIdentities(limit = 20) {
  const db = getIdentityDb();
  const lim = Math.max(1, Math.min(parseInt(limit || 20, 10), 100));

  return new Promise((resolve, reject) => {
    db.all(
      `
      SELECT wa_id, label, updated_ts
      FROM identities
      ORDER BY updated_ts DESC
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

/**
 * Update ALL group DBs: set author_name = label where author_id = waId
 */
function relabelAuthorEverywhere(waId, label) {
  ensureDataDir();

  const identityFile = config.IDENTITIES_DB_FILE;

  const files = fs
    .readdirSync(DATA_DIR)
    .filter(f => f.endsWith('.sqlite') && f !== identityFile)
    .map(f => path.join(DATA_DIR, f));

  const updates = files.map(filePath => {
    return new Promise((resolve, reject) => {
      const db = new sqlite3.Database(filePath);
      db.run(
        `UPDATE messages SET author_name = ? WHERE author_id = ?`,
        [label, waId],
        function (err) {
          if (err) {
            db.close(() => reject(err));
            return;
          }
          const changed = this.changes || 0;
          db.close(() => resolve({ filePath, changed }));
        }
      );
    });
  });

  return Promise.all(updates);
}

module.exports = {
  insertRow,
  countMessages,
  getRanks,
  getSchema,
  getLastRows,
  dbPathForChat,
  setIdentity,
  getIdentity,
  listIdentities,
  relabelAuthorEverywhere
};
