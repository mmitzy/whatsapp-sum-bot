// bot/index.js
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const config = require('./config');

const {
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
} = require('./db');

const ALLOWED_GROUP_IDS = new Set(config.ALLOWED_GROUP_IDS);
const ADMIN_DM_IDS = new Set(config.ADMIN_DM_IDS);

const nameCache = new Map();

const client = new Client({
  authStrategy: new LocalAuth({ clientId: config.CLIENT_ID })
});

function stripSuffix(id) {
  return (id || '')
    .replace(/@c\.us$/i, '')
    .replace(/@g\.us$/i, '')
    .replace(/@lid$/i, '')
    .trim();
}

function makeFriendlyAliasFromId(id) {
  const core = stripSuffix(id);
  if (!core) return 'User';
  return `User ${core.slice(0, 6)}…${core.slice(-4)}`;
}

function isDm(message) {
  return message.from.endsWith('@c.us') || message.from.endsWith('@lid');
}

function isAdminDmSender(message) {
  return ADMIN_DM_IDS.has(message.from);
}

/**
 * In a group:
 *  - message.from   = group id (...@g.us)
 *  - message.author = sender id (often ...@lid, sometimes ...@c.us)
 * In DMs:
 *  - message.from is the other party id
 */
function getSenderId(message) {
  if (message.from.endsWith('@g.us')) return message.author || null;
  return message.from || null;
}

/**
 * Alias-first: mapping wins if it exists (prevents name splits)
 * We use identities table keyed by WA id:
 *   wa_id = "<senderId>" (e.g. 1960...@lid)
 */
async function resolveAuthorName(message) {
  const senderId = getSenderId(message);
  if (!senderId) return 'Unknown';

  if (nameCache.has(senderId)) return nameCache.get(senderId);

  // 1) Manual mapping first (canonical)
  try {
    const mapped = await getIdentity(senderId);
    if (mapped && mapped.trim()) {
      const clean = mapped.trim();
      nameCache.set(senderId, clean);
      return clean;
    }
  } catch (e) {
    console.error('getIdentity failed:', e);
  }

  // 2) WhatsApp-provided fields (best-effort)
  try {
    const c = await message.getContact();
    const name =
      (c?.pushname && c.pushname.trim()) ||
      (c?.name && c.name.trim()) ||
      (c?.number && String(c.number).trim()) ||
      '';

    if (name) {
      nameCache.set(senderId, name);
      return name;
    }
  } catch {
    // ignore
  }

  // 3) Friendly alias fallback
  const alias = makeFriendlyAliasFromId(senderId);
  nameCache.set(senderId, alias);
  return alias;
}

function sanitizeLabel(label) {
  const s = String(label || '').trim();
  if (!s) return null;
  return s.replace(/\s+/g, ' ').slice(0, 40);
}

// QR
client.on('qr', (qr) => {
  console.log('QR RECEIVED - scan with WhatsApp (Linked Devices).');
  qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
  console.log('Client is ready!');
  console.log('Allowed groups:', Array.from(ALLOWED_GROUP_IDS));
  console.log('Admin DM IDs:', Array.from(ADMIN_DM_IDS));
  console.log('Data dir:', config.DATA_DIR);
});

client.on('disconnected', (reason) => console.log('Client was disconnected:', reason));
client.on('auth_failure', (msg) => console.log('AUTH FAILURE:', msg));
client.on('change_state', (state) => console.log('STATE CHANGED:', state));

client.on('message', async (message) => {
  /* turn on is you want to add a new gc to allowed list
  if (message.from.endsWith('@g.us')) {
    console.log('GROUP ID:', message.from);
  }*/
  const body = (message.body || '').trim();

  // ---------------------------
  // DM COMMANDS
  // ---------------------------
  if (isDm(message)) {
    // Admin-only DM commands
    if (!isAdminDmSender(message)) return;

    if (body === '!myid') {
      await message.reply(`Your WhatsApp id (DM): ${message.from}`);
      return;
    }

    if (body.startsWith('!aliases')) {
      const parts = body.split(/\s+/);
      const n = parseInt(parts[1] || '20', 10);
      const limit = Number.isFinite(n) ? Math.min(Math.max(n, 1), 100) : 20;

      try {
        const rows = await listIdentities(limit);
        if (!rows.length) {
          await message.reply('No aliases saved yet.');
          return;
        }
        const lines = rows.map(r => `${r.wa_id} -> ${r.label}`);
        await message.reply(`📒 Aliases (latest ${rows.length}):\n` + lines.join('\n'));
      } catch (e) {
        console.error('listIdentities failed:', e);
        await message.reply('Failed to list aliases (see server logs).');
      }
      return;
    }

    /**
     * ADMIN-ONLY:
     * !alias <lid_or_cus> <name>
     * Example:
     *   !alias 196099767820421@lid Sibo
     */

    if (body.startsWith('!sample')) {
    const parts = body.split(/\s+/);
    const n = parseInt(parts[1] || '5', 10);
    const limit = Number.isFinite(n) ? Math.min(Math.max(n, 1), 20) : 5;

    try {
      const rows = await getLastRows(message.from, limit);
      if (!rows.length) return void (await message.reply('No stored rows yet.'));

      const lines = rows
        .reverse()
        .map(r => {
          const preview = (r.body || '').replace(/\s+/g, ' ').slice(0, 80);
          const media = r.entry_type === 'media' ? ` [media:${r.media_type || '?'}]` : '';
          return `- ${r.who}: (${r.entry_type})${media} ${preview}`;
        })
        .join('\n');

      await message.reply(`🧪 Sample (last ${rows.length} rows):\n${lines}`);
    } catch (e) {
      console.error('getLastRows failed:', e);
      await message.reply('Failed to sample rows.');
    }
    return;
  }

    if (body === '!count') {
    try {
      const cnt = await countMessages(message.from);
      await message.reply(`Stored rows (excluding commands): ${cnt}`);
    } catch (e) {
      console.error('countMessages failed:', e);
      await message.reply('Failed to count (see server logs).');
    }
    return;
  }

    if (body.startsWith('!alias ')) {
      const parts = body.split(/\s+/);
      const targetId = (parts[1] || '').trim();
      const labelRaw = parts.slice(2).join(' ');
      const label = sanitizeLabel(labelRaw);

      if (!targetId || !label) {
        await message.reply(
          `Usage:\n` +
          `- !alias <wa_id> <name>\n` +
          `Example: !alias 1960...@lid Sibo`
        );
        return;
      }

      // enforce "admin-only if targeting someone":
      if (!targetId.includes('@') || (!targetId.endsWith('@lid') && !targetId.endsWith('@c.us'))) {
        await message.reply('❌ wa_id must end with @lid or @c.us');
        return;
      }

      try {
        await setIdentity(targetId, label);

        const results = await relabelAuthorEverywhere(targetId, label);
        const totalChanged = results.reduce((sum, r) => sum + (r.changed || 0), 0);

        nameCache.delete(targetId);

        await message.reply(
          `✅ Saved mapping + updated history:\n` +
          `${targetId} -> ${label}\n` +
          `Rows updated across group DBs: ${totalChanged}`
        );
      } catch (e) {
        console.error('alias+relabel failed:', e);
        await message.reply('Failed to save mapping/update history (see server logs).');
      }
      return;
    }

    return;
  }

  // ---------------------------
  // GROUP HANDLING ONLY BELOW
  // ---------------------------
  if (!message.from.endsWith('@g.us')) return;
  if (!ALLOWED_GROUP_IDS.has(message.from)) return;

  // Commands first (don’t insert)
  if (body === '!ping') return void (await message.reply('pong'));
  if (body === '!ben') return void (await message.reply('kirk!'));

  /**
   * EVERYONE (GROUP):
   * !alias <name>
   *
   * Saves alias for the SENDER ONLY (author id from the group message).
   * This prevents abuse like setting alias for other people.
   */
  if (body.startsWith('!alias ')) {
    const labelRaw = body.slice('!alias '.length);
    const label = sanitizeLabel(labelRaw);

    if (!label) {
      await message.reply(`Usage: !alias <your name>\nExample: !alias Sibo`);
      return;
    }

    const senderId = getSenderId(message); // group sender id
    if (!senderId) {
      await message.reply("Couldn't detect your sender id.");
      return;
    }

    try {
      await setIdentity(senderId, label);

      // update history across all group DBs so ranks/sample won't split
      const results = await relabelAuthorEverywhere(senderId, label);
      const totalChanged = results.reduce((sum, r) => sum + (r.changed || 0), 0);

      nameCache.delete(senderId);

      await message.reply(
        `✅ Alias saved for you: ${label}\n` +
        `Rows updated across group DBs: ${totalChanged}`
      );
    } catch (e) {
      console.error('group alias failed:', e);
      await message.reply('Failed to save alias (see server logs).');
    }
    return;
  }

  if (body.startsWith('!ranks')) {
    const parts = body.split(/\s+/);
    const n = parseInt(parts[1] || '10', 10);
    const limit = Number.isFinite(n) ? Math.min(Math.max(n, 3), 30) : 10;

    try {
      const rows = await getRanks(message.from, limit);
      if (!rows.length) return void (await message.reply('No stored messages yet.'));
      const lines = rows.map((r, i) => `${i + 1}. ${r.who} — ${r.cnt}`);
      await message.reply(`🏆 Top senders (stored rows)\n${lines.join('\n')}`);
    } catch (e) {
      console.error('getRanks failed:', e);
      await message.reply('Failed to rank (see server logs).');
    }
    return;
  }

  // Store non-command messages
  const ts = message.timestamp;
  const baseId = message.id._serialized;

  const authorId = getSenderId(message); // use same logic as aliasing
  const authorName = await resolveAuthorName(message);

  console.log(`[${message.from}] ${body}`);
  console.log('DB file:', dbPathForChat(message.from));
  console.log('Author resolved as:', authorName, '| raw author_id:', authorId);

  if (message.hasMedia) {
    if (body.length > 0) {
      insertRow(message.from, {
        msg_id: `${baseId}:text`,
        ts,
        author_id: authorId,
        author_name: authorName,
        body,
        has_media: 0,
        entry_type: 'text'
      });
    }

    insertRow(message.from, {
      msg_id: `${baseId}:media`,
      ts,
      author_id: authorId,
      author_name: authorName,
      body: '',
      has_media: 1,
      entry_type: 'media',
      media_type: message.type || null,
      media_mimetype: null,
      media_filename: null,
      media_size: null
    });

    return;
  }

  insertRow(message.from, {
    msg_id: baseId,
    ts,
    author_id: authorId,
    author_name: authorName,
    body,
    has_media: 0,
    entry_type: 'text'
  });
});

client.initialize();
