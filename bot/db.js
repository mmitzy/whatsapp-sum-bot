const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();

const DB_PATH = path.join(__dirname, '..', 'data', 'whatsapp.sqlite');

function ensureDataDir() {
  const dir = path.dirname(DB_PATH);
  fs.mkdirSync(dir, { recursive: true });
}

function openDb() {
  ensureDataDir();
  const db = new sqlite3.Database(DB_PATH);

  db.serialize(() => {
    db.run(`
      CREATE TABLE IF NOT EXISTS messages (
        msg_id      TEXT PRIMARY KEY,
        chat_id     TEXT NOT NULL,
        chat_name   TEXT,
        ts          INTEGER NOT NULL,
        author_id   TEXT,
        author_name TEXT,
        body        TEXT
      )
    `);

    db.run(`CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages(chat_id, ts)`);
  });

  return db;
}

function insertMessage(db, msg) {
  const stmt = `
    INSERT OR IGNORE INTO messages
    (msg_id, chat_id, chat_name, ts, author_id, author_name, body)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `;
  db.run(stmt, [
    msg.msg_id,
    msg.chat_id,
    msg.chat_name,
    msg.ts,
    msg.author_id,
    msg.author_name,
    msg.body
  ]);
}

function getLastMessages(db, chatId, limit = 5) {
  return new Promise((resolve, reject) => {
    db.all(
      `
      SELECT ts, author_name, body
      FROM messages
      WHERE chat_id = ?
        AND body IS NOT NULL
        AND LENGTH(TRIM(body)) > 0
      ORDER BY ts DESC
      LIMIT ?
      `,
      [chatId, limit],
      (err, rows) => {
        if (err) return reject(err);
        resolve(rows);
      }
    );
  });
}

module.exports = { openDb, insertMessage, getLastMessages, DB_PATH };
