// bot/config.js
const path = require('path');

module.exports = {
  // Allowed group IDs, comma-separated
  ALLOWED_GROUP_IDS: (process.env.ALLOWED_GROUP_IDS || '120363422504843223@g.us,120363048222575013@g.us,120363423071939359@g.us')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean),

  // Admin DM sender IDs allowed to run DM admin commands
  ADMIN_DM_IDS: (process.env.ADMIN_DM_IDS || '196099767820421@lid,243537614471375@lid')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean),

  // Allowed spam groups
  ALLOWED_SPAM_GROUP_IDS: (process.env.ALLOWED_SPAM_GROUP_IDS || '120363422504843223@g.us, 120363423071939359@g.us')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean),  

  DATA_DIR: process.env.DATA_DIR || path.join(__dirname, '..', 'data'),

  IDENTITIES_DB_FILE: process.env.IDENTITIES_DB_FILE || 'identities.sqlite',

  PY_SUMMARY_SCRIPT: process.env.PY_SUMMARY_SCRIPT || '../main.py',

  MAX_SUMMARY_CHARS: parseInt(process.env.MAX_SUMMARY_CHARS || '3500', 10),

  CLIENT_ID: process.env.CLIENT_ID || 'bot1',

  MAX_SUMMARY_CHARS: 1500,

  BJ_MAX_HANDS: 4,

  BJ_MAX_MS: 2 * 60 * 1000,

  MAX_IMAGE_BYTES: parseInt(process.env.MAX_IMAGE_BYTES || '', 10) || 10 * 1024 * 1024, // 10 MB

  MEDIA_DIRNAME: process.env.MEDIA_DIRNAME || 'media',

  ALLOWED_MIME: new Set(['image/jpeg', 'image/png', 'image/webp']),

  EXT_BY_MIME: {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp'
  },

  RETENTION_DAYS: parseInt(process.env.MEDIA_RETENTION_DAYS || '', 10) || 30,

  DRY_RUN: (process.env.MEDIA_CLEANUP_DRY_RUN || '').toLowerCase() === 'true',

  // ✅ Help text lives here (single source of truth)
  COMMANDS: [
  {
    cmd: '!help',
    scope: 'Group',
    desc: 'DMs you the full list of commands and what they do.'
  },
  {
    cmd: '!alias <name>',
    scope: 'Group',
    desc: 'Set your alias (nickname) for this bot.'
  },
  {
    cmd: '!summary <interval>',
    scope: 'Group',
    desc: 'Get a summary of messages from the last interval (e.g. 10m, 1h30m). Capped at 24h.'
  },
  {
    cmd: '!ranks [N]',
    scope: 'Group',
    desc: 'Shows top senders by stored messages (default 10).'
  },
  {
    cmd: '!count',
    scope: 'Group',
    desc: 'Shows how many stored (non-command) messages exist for this group.'
  },
  {
    cmd: '!sum <interval>',
    scope: 'Group',
    desc: 'Print messages from last interval (e.g. 10m, 1h30m). Capped at 24h.'
  },
  {
    cmd: '!ghosts',
    scope: 'Group',
    desc: 'Shows members who were silent for 7+ days.'
  },
  {
    cmd: '!quote <alias>',
    scope: 'Group',
    desc: 'Random quote from a user with this exact alias.'
  },
  {
    cmd: '!streaks',
    scope: 'Group',
    desc: 'Consecutive-day streaks (must have messaged today to count).'
  },
  {
    cmd: '!emojis',
    scope: 'Group',
    desc: 'Emoji “personality” per user (top emojis, last 30 days).'
  },
  {
    cmd: '!joke <phrase>',
    scope: 'Group',
    desc: 'Save a phrase as an inside joke tracker.'
  },
  {
    cmd: '!jokes',
    scope: 'Group',
    desc: 'Lists saved joke phrases + usage counts.'
  },

  // 🆕 Economy & games
  {
    cmd: '!balance',
    scope: 'Group',
    desc: 'Shows your current balance.'
  },
  {
    cmd: '!daily',
    scope: 'Group',
    desc: 'Claim your daily reward (once every 24 hours).'
  },
  {
    cmd: '!give <alias> <amount>',
    scope: 'Group',
    desc: 'Give money from your balance to another user.'
  },
  {
    cmd: '!topbal',
    scope: 'Group',
    desc: 'Shows the richest users by balance.'
  },
  {
    cmd: '!blackjack <bet>',
    scope: 'Group',
    desc: 'Start a blackjack game using your balance.'
  },
  {
    cmd: '!hit',
    scope: 'Group',
    desc: 'Blackjack: draw another card.'
  },
  {
    cmd: '!stand',
    scope: 'Group',
    desc: 'Blackjack: end your turn and let the dealer play.'
  },
  {
    cmd: '!double',
    scope: 'Group',
    desc: 'Blackjack: double your bet, draw once, then stand.'
  },
  {
    cmd: '!split',
    scope: 'Group',
    desc: 'Blackjack: split your hand into two (if possible).'
  },

  // Admin DM-only commands
  {
    cmd: '!myid',
    scope: 'DM (Admin)',
    desc: 'Prints your WhatsApp id (useful for admin setup).'
  },
  {
    cmd: '!groupid',
    scope: 'DM (Admin)',
    desc: 'Prints the current group id (useful for admin setup).'
  },
  {
    cmd: '!sample [N]',
    scope: 'DM (Admin)',
    desc: 'Shows a small sample of last stored messages (default 5).'
  },
  {
    cmd: '!aliases [N]',
    scope: 'DM (Admin)',
    desc: 'Lists latest saved aliases (default 20).'
  },
  {
    cmd: '!who <alias>',
    scope: 'DM (Admin)',
    desc: 'Finds the current author_id (lid/c.us) for an alias (exact match).'
  },
  {
    cmd: '!alias <author_id> <name>',
    scope: 'DM (Admin)',
    desc: 'Force-set alias for a specific author_id and relabel history.'
  },
  {
    cmd: '!give <alias> <amount>',
    scope: 'DM (Admin)',
    desc: 'Give balance to a user (admin mint).'
  }
  ]
};