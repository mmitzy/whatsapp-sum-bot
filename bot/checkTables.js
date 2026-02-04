const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const dbPath = path.resolve(__dirname, '..', 'data', 'bot.sqlite');

console.log('Checking DB at:', dbPath);
console.log('Exists?', fs.existsSync(dbPath));

if (!fs.existsSync(dbPath)) {
  console.log('Files in bot/data:', fs.existsSync(path.resolve(__dirname, 'data'))
    ? fs.readdirSync(path.resolve(__dirname, 'data'))
    : '(data folder missing)');
  process.exit(1);
}

const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
  if (err) {
    console.error('Open failed:', err);
    process.exit(1);
  }
});

db.all("SELECT name FROM sqlite_master WHERE type='table'", (err, rows) => {
  if (err) console.error('Query failed:', err);
  else console.log('Tables:', rows.map(r => r.name));
  db.close();
});
