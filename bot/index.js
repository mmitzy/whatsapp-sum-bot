const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const {
  insertRow,
  countMessages,
  getRanks,
  getSchema,
  getLastRows,
  dbPathForChat,
  setIdentity,
  getIdentity,
  relabelAuthorEverywhere
} = require('./db');

// Allowed groups
const ALLOWED_GROUP_IDS = new Set([
  '120363422504843223@g.us',
]);

// Only these IDs can run admin DM commands
const ADMIN_DM_IDS = new Set([
  '196099767820421@lid',
  '243537614471375@lid',
]);

const nameCache = new Map();

const client = new Client({
  authStrategy: new LocalAuth({ clientId: 'bot1' })
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

// Alias-first: if mapping exists, always prefer it (prevents name splits)
async function resolveAuthorName(message) {
  const authorId = message.author || null;
  if (!authorId) return 'Unknown';

  if (nameCache.has(authorId)) return nameCache.get(authorId);

  // 1) Manual mapping first (canonical)
  try {
    const mapped = await getIdentity(authorId);
    if (mapped && mapped.trim()) {
      const clean = mapped.trim();
      nameCache.set(authorId, clean);
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
      nameCache.set(authorId, name);
      return name;
    }
  } catch {
    // ignore
  }

  // 3) Friendly alias fallback
  const alias = makeFriendlyAliasFromId(authorId);
  nameCache.set(authorId, alias);
  return alias;
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
});

client.on('disconnected', (reason) => console.log('Client was disconnected:', reason));
client.on('auth_failure', (msg) => console.log('AUTH FAILURE:', msg));
client.on('change_state', (state) => console.log('STATE CHANGED:', state));

client.on('message', async (message) => {
  const body = (message.body || '').trim();

  // ---------------------------
  // ADMIN COMMANDS (DM ONLY + ADMIN ID ONLY)
  // ---------------------------
  if (isDm(message)) {
    if (!isAdminDmSender(message)) return;

    if (body === '!myid') {
      await message.reply(`Your WhatsApp id (DM): ${message.from}`);
      return;
    }

    if (body.startsWith('!alias ')) {
      // Formats:
      // 1) !alias Your Name
      // 2) !alias 1960...@lid Your Name
      const parts = body.split(/\s+/);

      let targetId = message.from;
      let label = '';

      const maybeId = parts[1] || '';
      const looksLikeId = maybeId.includes('@');

      if (looksLikeId) {
        targetId = maybeId;
        label = parts.slice(2).join(' ');
      } else {
        label = parts.slice(1).join(' ');
      }

      label = (label || '').trim();
      if (!label) {
        await message.reply(
          `Usage:\n` +
          `- !alias Your Name\n` +
          `- !alias 1960...@lid Your Name`
        );
        return;
      }

      try {
        // 1) Save mapping for future resolution
        await setIdentity(targetId, label);

        // 2) Update past rows everywhere so ranks/sample won’t split
        const results = await relabelAuthorEverywhere(targetId, label);
        const totalChanged = results.reduce((sum, r) => sum + (r.changed || 0), 0);

        // Clear cache for that id (so new messages use new label immediately)
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

    return; // ignore other DMs
  }

  // ---------------------------
  // GROUP HANDLING ONLY BELOW
  // ---------------------------
  if (!message.from.endsWith('@g.us')) return;
  if (!ALLOWED_GROUP_IDS.has(message.from)) return;

  // Commands first (don’t insert)
  if (body === '!ping') return void (await message.reply('pong'));
  if (body === 'ben') return void (await message.reply('kirk!'));

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

  // Store non-command messages
  const ts = message.timestamp;
  const baseId = message.id._serialized;

  const authorId = message.author || null;
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
