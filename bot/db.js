// bot/db.js
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const config = require('./config');

const DATA_DIR = config.DATA_DIR;
const DB_FILE = process.env.DB_FILE || 'bot.sqlite'; // single DB file name in DATA_DIR

let db = null;

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function dbPath() {
  return path.join(DATA_DIR, DB_FILE);
}

function getDb() {
  ensureDataDir();
  if (db) return db;

  const p = dbPath();
  db = new sqlite3.Database(p);

  // Initialize schema.sql (source of truth)
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf8');
  db.exec(schemaSql);

  return db;
}

// ---- Inserts / queries ----

function insertRow(chatId, row) {
  const db = getDb();

  db.run(
    `INSERT OR IGNORE INTO messages
      (chat_id, msg_id, ts, author_id, author_name, body, has_media, entry_type,
       media_type, media_mimetype, media_filename, media_size)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      chatId,
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
  const db = getDb();
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT COUNT(*) AS cnt
       FROM messages
       WHERE chat_id = ?
         AND NOT (entry_type='text' AND body LIKE '!%')`,
      [chatId],
      (err, row) => {
        if (err) return reject(err);
        resolve(row?.cnt ?? 0);
      }
    );
  });
}

function getRanks(chatId, limit = 10) {
  const db = getDb();
  const lim = Math.max(1, Math.min(limit, 30));

  return new Promise((resolve, reject) => {
    db.all(
      `
      SELECT
        COALESCE(NULLIF(TRIM(author_name), ''), 'Unknown') AS who,
        COUNT(*) AS cnt
      FROM messages
      WHERE chat_id = ?
        AND NOT (entry_type='text' AND body LIKE '!%')
      GROUP BY who
      ORDER BY cnt DESC
      LIMIT ?
      `,
      [chatId, lim],
      (err, rows) => {
        if (err) return reject(err);
        resolve(rows || []);
      }
    );
  });
}

function getLastRows(chatId, limit = 5) {
  const db = getDb();
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
      WHERE chat_id = ?
        AND NOT (entry_type='text' AND body LIKE '!%')
      ORDER BY ts DESC
      LIMIT ?
      `,
      [chatId, lim],
      (err, rows) => {
        if (err) return reject(err);
        resolve(rows || []);
      }
    );
  });
}

function getMessagesSince(chatId, sinceTs, limit = 5000) {
  const db = getDb();
  const lim = Math.max(1, Math.min(parseInt(limit || 5000, 10), 5000));

  return new Promise((resolve, reject) => {
    db.all(
      `
      SELECT ts, author_id, author_name, body, entry_type, media_type
      FROM messages
      WHERE chat_id = ?
        AND ts >= ?
        AND NOT (entry_type='text' AND body LIKE '!%')
      ORDER BY ts ASC
      LIMIT ?
      `,
      [chatId, sinceTs, lim],
      (err, rows) => {
        if (err) return reject(err);
        resolve(rows || []);
      }
    );
  });
}

// Random quote from a specific author in a chat
function getRandomQuoteByAuthor(chatId, authorId) {
  const db = getDb();
  return new Promise((resolve, reject) => {
    db.get(
      `
      SELECT ts, author_name, body
      FROM messages
      WHERE chat_id = ?
        AND author_id = ?
        AND entry_type = 'text'
        AND body IS NOT NULL
        AND LENGTH(TRIM(body)) >= 4
        AND body NOT LIKE '!%'
      ORDER BY RANDOM()
      LIMIT 1
      `,
      [chatId, authorId],
      (err, row) => {
        if (err) return reject(err);
        resolve(row || null);
      }
    );
  });
}

// For ghosts: last message time per author within a chat
function getLastTsByAuthors(chatId, authorIds = []) {
  const db = getDb();
  const ids = (authorIds || []).filter(Boolean);
  if (!ids.length) return Promise.resolve([]);

  // Build (?,?,?,...) placeholders safely
  const placeholders = ids.map(() => '?').join(',');
  const params = [chatId, ...ids];

  return new Promise((resolve, reject) => {
    db.all(
      `
      SELECT author_id, MAX(ts) AS last_ts
      FROM messages
      WHERE chat_id = ?
        AND author_id IN (${placeholders})
        AND NOT (entry_type='text' AND body LIKE '!%')
      GROUP BY author_id
      `,
      params,
      (err, rows) => {
        if (err) return reject(err);
        resolve(rows || []);
      }
    );
  });
}

// For streaks: distinct message days per author (last N days)
function getAuthorDaysSince(chatId, sinceTs) {
  const db = getDb();
  return new Promise((resolve, reject) => {
    db.all(
      `
      SELECT
        author_id,
        date(ts, 'unixepoch', 'localtime') AS day
      FROM messages
      WHERE chat_id = ?
        AND ts >= ?
        AND NOT (entry_type='text' AND body LIKE '!%')
      GROUP BY author_id, day
      `,
      [chatId, sinceTs],
      (err, rows) => {
        if (err) return reject(err);
        resolve(rows || []);
      }
    );
  });
}

// For emojis: pull recent text messages (last N seconds)
function getTextBodiesSince(chatId, sinceTs, limit = 5000) {
  const db = getDb();
  const lim = Math.max(1, Math.min(parseInt(limit || 5000, 10), 5000));

  return new Promise((resolve, reject) => {
    db.all(
      `
      SELECT author_id, author_name, body
      FROM messages
      WHERE chat_id = ?
        AND ts >= ?
        AND entry_type='text'
        AND body IS NOT NULL
        AND LENGTH(TRIM(body)) > 0
        AND body NOT LIKE '!%'
      ORDER BY ts DESC
      LIMIT ?
      `,
      [chatId, sinceTs, lim],
      (err, rows) => {
        if (err) return reject(err);
        resolve(rows || []);
      }
    );
  });
}

// ---- Identity mapping API ----

function setIdentity(authorId, label) {
  const db = getDb();
  const ts = Math.floor(Date.now() / 1000);

  return new Promise((resolve, reject) => {
    db.run(
      `
      INSERT INTO identities (author_id, label, updated_ts)
      VALUES (?, ?, ?)
      ON CONFLICT(author_id) DO UPDATE SET
        label=excluded.label,
        updated_ts=excluded.updated_ts
      `,
      [authorId, label, ts],
      (err) => {
        if (err) return reject(err);
        resolve(true);
      }
    );
  });
}

function getIdentity(authorId) {
  const db = getDb();
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT label FROM identities WHERE author_id = ?`,
      [authorId],
      (err, row) => {
        if (err) return reject(err);
        resolve(row?.label || null);
      }
    );
  });
}

function listIdentities(limit = 20) {
  const db = getDb();
  const lim = Math.max(1, Math.min(parseInt(limit || 20, 10), 100));

  return new Promise((resolve, reject) => {
    db.all(
      `
      SELECT author_id, label, updated_ts
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

// Exact (case-insensitive) match by label
function findIdentityByLabel(label, limit = 10) {
  const db = getDb();
  const lim = Math.max(1, Math.min(parseInt(limit || 10, 10), 50));
  const needle = String(label || '').trim().toLowerCase();

  return new Promise((resolve, reject) => {
    db.all(
      `
      SELECT author_id, label, updated_ts
      FROM identities
      WHERE LOWER(TRIM(label)) = ?
      ORDER BY updated_ts DESC
      LIMIT ?
      `,
      [needle, lim],
      (err, rows) => {
        if (err) return reject(err);
        resolve(rows || []);
      }
    );
  });
}

/**
 * Update message history in this single DB:
 * set author_name = label where author_id = ? (across all chats)
 */
function relabelAuthorEverywhere(authorId, label) {
  const db = getDb();
  return new Promise((resolve, reject) => {
    db.run(
      `UPDATE messages SET author_name = ? WHERE author_id = ?`,
      [label, authorId],
      function (err) {
        if (err) return reject(err);
        resolve({ changed: this.changes || 0 });
      }
    );
  });
}

// ---- Jokes API ----

function addJoke(chatId, phrase, addedBy) {
  const db = getDb();
  const ts = Math.floor(Date.now() / 1000);

  return new Promise((resolve, reject) => {
    db.run(
      `
      INSERT INTO jokes (chat_id, phrase, added_by, created_ts)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(chat_id, phrase) DO UPDATE SET
        created_ts=excluded.created_ts,
        added_by=excluded.added_by
      `,
      [chatId, phrase, addedBy || null, ts],
      (err) => {
        if (err) return reject(err);
        resolve(true);
      }
    );
  });
}

function listJokes(chatId, limit = 30) {
  const db = getDb();
  const lim = Math.max(1, Math.min(parseInt(limit || 30, 10), 100));

  return new Promise((resolve, reject) => {
    db.all(
      `
      SELECT phrase, added_by, created_ts
      FROM jokes
      WHERE chat_id = ?
      ORDER BY created_ts DESC
      LIMIT ?
      `,
      [chatId, lim],
      (err, rows) => {
        if (err) return reject(err);
        resolve(rows || []);
      }
    );
  });
}

// count occurrences of a phrase in messages (case-insensitive, per chat)
function countPhraseOccurrences(chatId, phrase, sinceTs = null) {
  const db = getDb();
  const needle = `%${String(phrase).toLowerCase()}%`;

  const whereSince = sinceTs ? `AND ts >= ?` : '';
  const params = sinceTs ? [chatId, needle, sinceTs] : [chatId, needle];

  return new Promise((resolve, reject) => {
    db.get(
      `
      SELECT COUNT(*) AS cnt
      FROM messages
      WHERE chat_id = ?
        AND entry_type='text'
        AND body IS NOT NULL
        AND LOWER(body) LIKE ?
        AND body NOT LIKE '!%'
        ${whereSince}
      `,
      params,
      (err, row) => {
        if (err) return reject(err);
        resolve(row?.cnt ?? 0);
      }
    );
  });
}

module.exports = {
  insertRow,
  countMessages,
  getRanks,
  getLastRows,
  getMessagesSince,
  getRandomQuoteByAuthor,
  getLastTsByAuthors,
  getAuthorDaysSince,
  getTextBodiesSince,
  setIdentity,
  getIdentity,
  listIdentities,
  findIdentityByLabel,
  relabelAuthorEverywhere,
  addJoke,
  listJokes,
  countPhraseOccurrences,
  dbPath
};
