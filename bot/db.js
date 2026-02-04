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
  db.exec(schemaSql, (err) => {
    if (err) {
      console.error('schema.sql exec failed:', err);
    } else {
      console.log('schema.sql applied OK');
    }
  });


  // Lightweight migrations
  db.serialize(() => {
    db.all(`PRAGMA table_info(identities)`, (err, cols) => {
      if (err) {
        console.error('PRAGMA table_info(identities) failed:', err);
        return;
      }
      const names = new Set((cols || []).map(c => c.name));

      // Add balance column if missing
      if (!names.has('balance')) {
        db.run(`ALTER TABLE identities ADD COLUMN balance INTEGER NOT NULL DEFAULT 0`);
      }
      // Add last_daily_ts column if missing
      if (!names.has('last_daily_ts')) {
        db.run(`ALTER TABLE identities ADD COLUMN last_daily_ts INTEGER`);
      }
    });

    db.all(`PRAGMA table_info(messages)`, (err, cols) => {
      if (err) return console.error('PRAGMA table_info(messages) failed:', err);
      const names = new Set((cols || []).map(c => c.name));

      if (!names.has('media_id')) {
        db.run(`ALTER TABLE messages ADD COLUMN media_id INTEGER`);
      }
      if (!names.has('media_ref')) {
        db.run(`ALTER TABLE messages ADD COLUMN media_ref TEXT`);
      }
      if (!names.has('media_status')) {
        db.run(`ALTER TABLE messages ADD COLUMN media_status TEXT`);
      }
    });

  });

  return db;
}

// ---- Inserts / queries ----

function insertRow(chatId, row) {
  const db = getDb();

  // Ensure an identity row exists for this author so "give by alias" works reliably.
  // This does NOT overwrite existing aliases.
  if (row?.author_id && row?.author_name) {
    const tsNow = Math.floor(Date.now() / 1000);
    db.run(
      `INSERT OR IGNORE INTO identities (author_id, label, updated_ts, balance, last_daily_ts)
       VALUES (?, ?, ?, 0, NULL)`,
      [row.author_id, String(row.author_name).trim() || row.author_id, tsNow]
    );
  }

    db.run(
      `INSERT OR IGNORE INTO messages
        (chat_id, msg_id, ts, author_id, author_name, body, has_media, entry_type,
        media_type, media_mimetype, media_filename, media_size,
        media_id, media_ref, media_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        row.media_size ?? null,
        row.media_id ?? null,
        row.media_ref ?? null,
        row.media_status ?? null,
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

// Ensure identity row exists (no overwrite). Useful for balance commands.
function ensureIdentity(authorId, labelIfNew = null) {
  const db = getDb();
  const ts = Math.floor(Date.now() / 1000);
  const label = (String(labelIfNew || '').trim() || authorId);

  return new Promise((resolve, reject) => {
    db.run(
      `
      INSERT OR IGNORE INTO identities (author_id, label, updated_ts, balance, last_daily_ts)
      VALUES (?, ?, ?, 0, NULL)
      `,
      [authorId, label, ts],
      (err) => {
        if (err) return reject(err);
        resolve(true);
      }
    );
  });
}



function getBalance(authorId) {
  const db = getDb();
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT balance FROM identities WHERE author_id = ?`,
      [authorId],
      (err, row) => {
        if (err) return reject(err);
        resolve(Number.isFinite(row?.balance) ? row.balance : 0);
      }
    );
  });
}

function addBalance(authorId, delta) {
  const db = getDb();
  const d = parseInt(delta, 10);
  if (!Number.isFinite(d)) return Promise.reject(new Error('delta must be int'));

  return new Promise((resolve, reject) => {
    db.run(
      `UPDATE identities SET balance = balance + ? WHERE author_id = ?`,
      [d, authorId],
      function (err) {
        if (err) return reject(err);
        resolve({ changed: this.changes || 0 });
      }
    );
  });
}

async function transferBalance(fromAuthorId, toAuthorId, amount) {
  const db = getDb();
  const amt = parseInt(amount, 10);
  if (!Number.isFinite(amt) || amt <= 0) throw new Error('amount must be positive int');

  // SQLite transaction
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run('BEGIN IMMEDIATE TRANSACTION');

      db.get(
        `SELECT balance FROM identities WHERE author_id = ?`,
        [fromAuthorId],
        (err, row) => {
          if (err) {
            db.run('ROLLBACK');
            return reject(err);
          }

          const bal = parseInt(row?.balance ?? 0, 10);
          if (!Number.isFinite(bal) || bal < amt) {
            db.run('ROLLBACK');
            return resolve({ ok: false, reason: 'insufficient', balance: bal });
          }

          db.run(
            `UPDATE identities SET balance = balance - ? WHERE author_id = ?`,
            [amt, fromAuthorId],
            (err2) => {
              if (err2) {
                db.run('ROLLBACK');
                return reject(err2);
              }

              db.run(
                `UPDATE identities SET balance = balance + ? WHERE author_id = ?`,
                [amt, toAuthorId],
                (err3) => {
                  if (err3) {
                    db.run('ROLLBACK');
                    return reject(err3);
                  }
                  db.run('COMMIT', (err4) => {
                    if (err4) {
                      db.run('ROLLBACK');
                      return reject(err4);
                    }
                    resolve({ ok: true, amount: amt, from_balance_before: bal });
                  });
                }
              );
            }
          );
        }
      );
    });
  });
}

function claimDaily(authorId, nowTs, amount = 100) {
  const db = getDb();
  const now = parseInt(nowTs, 10);
  const amt = parseInt(amount, 10);
  if (!Number.isFinite(now) || !Number.isFinite(amt)) return Promise.reject(new Error('bad args'));

  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run('BEGIN IMMEDIATE TRANSACTION');

      db.get(
        `SELECT balance, last_daily_ts FROM identities WHERE author_id = ?`,
        [authorId],
        (err, row) => {
          if (err) {
            db.run('ROLLBACK');
            return reject(err);
          }

          const last = parseInt(row?.last_daily_ts ?? 0, 10);
          const can = !last || (now - last) >= 86400;
          if (!can) {
            const remaining = 86400 - (now - last);
            db.run('ROLLBACK');
            return resolve({ ok: false, remaining_sec: remaining, last_daily_ts: last, balance: row?.balance ?? 0 });
          }

          db.run(
            `UPDATE identities
             SET balance = balance + ?, last_daily_ts = ?
             WHERE author_id = ?`,
            [amt, now, authorId],
            function (err2) {
              if (err2) {
                db.run('ROLLBACK');
                return reject(err2);
              }
              db.run('COMMIT', (err3) => {
                if (err3) {
                  db.run('ROLLBACK');
                  return reject(err3);
                }
                resolve({ ok: true, amount: amt });
              });
            }
          );
        }
      );
    });
  });
}

function getTopBalances(limit = 10) {
  const db = getDb();
  const lim = Math.max(1, Math.min(parseInt(limit || 10, 10), 30));
  return new Promise((resolve, reject) => {
    db.all(
      `
      SELECT author_id, label, balance
      FROM identities
      ORDER BY balance DESC, updated_ts DESC
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

function upsertMediaObject(obj) {
  const db = getDb();
  const createdTs = obj.created_ts || Math.floor(Date.now() / 1000);

  return new Promise((resolve, reject) => {
    db.run(
      `
      INSERT INTO media_objects
        (sha256, kind, mime, size, width, height, storage, ref, status, created_ts, last_access_ts, extra_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'stored', ?, ?, ?)
      ON CONFLICT(sha256) DO UPDATE SET
        last_access_ts=excluded.last_access_ts
      `,
      [
        obj.sha256,
        obj.kind || 'image',
        obj.mime,
        obj.size,
        obj.width ?? null,
        obj.height ?? null,
        obj.storage || 'local',
        obj.ref,
        createdTs,
        obj.last_access_ts ?? createdTs,
        obj.extra_json ?? null
      ],
      function (err) {
        if (err) return reject(err);

        // fetch media_id (needed because upsert doesn't return it)
        db.get(
          `SELECT media_id, ref FROM media_objects WHERE sha256 = ?`,
          [obj.sha256],
          (err2, row) => {
            if (err2) return reject(err2);
            resolve(row); // { media_id, ref }
          }
        );
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

  ensureIdentity,
  getBalance,
  addBalance,
  transferBalance,
  claimDaily,
  getTopBalances,

  relabelAuthorEverywhere,

  addJoke,
  listJokes,
  countPhraseOccurrences,

  dbPath,
  upsertMediaObject
};
