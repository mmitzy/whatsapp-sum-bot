module.exports = {
  // Put your group id here after you see it in logs: 1203...@g.us
  ALLOWED_GROUP_ID: process.env.ALLOWED_GROUP_ID || 'YOUR_GROUP_ID_HERE',

  // where the sqlite will live
  DB_PATH: process.env.DB_PATH || '../data/whatsapp.sqlite',

  // python entrypoint for summarization
  PY_SUMMARY_SCRIPT: process.env.PY_SUMMARY_SCRIPT || '../main.py',

  // safety: don’t let the bot spam
  MAX_SUMMARY_CHARS: 3500
};
