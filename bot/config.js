const path = require('path');

module.exports = {
  // Allowed group IDs, comma-separated
  // Example: "120363...@g.us,120363...@g.us"
  ALLOWED_GROUP_IDS: (process.env.ALLOWED_GROUP_IDS || '120363422504843223@g.us')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean),

  // Admin DM sender IDs allowed to run DM admin commands (!alias/!aliases/!myid)
  // Example: "196099...@lid,243537...@lid"
  ADMIN_DM_IDS: (process.env.ADMIN_DM_IDS || '196099767820421@lid,243537614471375@lid')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean),

  // Where all sqlite DB files live (group DBs + identities.sqlite)
  // Default: <project>/data
  DATA_DIR: process.env.DATA_DIR || path.join(__dirname, '..', 'data'),

  // Identity DB filename (inside DATA_DIR)
  IDENTITIES_DB_FILE: process.env.IDENTITIES_DB_FILE || 'identities.sqlite',

  // python entrypoint for summarization (future step)
  PY_SUMMARY_SCRIPT: process.env.PY_SUMMARY_SCRIPT || '../main.py',

  // safety: don’t let the bot spam (future step)
  MAX_SUMMARY_CHARS: parseInt(process.env.MAX_SUMMARY_CHARS || '3500', 10),

  // LocalAuth clientId (so sessions are stable)
  CLIENT_ID: process.env.CLIENT_ID || 'bot1',
};
