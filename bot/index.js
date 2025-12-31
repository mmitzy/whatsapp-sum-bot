const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const {
  insertRow,
  countMessages,
  getRanks,
  getSchema,
  getLastRows,
  dbPathForChat
} = require('./db');

// Allowed groups (add more group IDs here)
const ALLOWED_GROUP_IDS = new Set([
  '120363422504843223@g.us',
  // '1203XXXXXXXXXXXXXXX@g.us',
]);

// Cache contact names to avoid repeated lookups
const contactNameCache = new Map();

const client = new Client({
  authStrategy: new LocalAuth({ clientId: 'bot1' })
});

// QR
client.on('qr', (qr) => {
  console.log('QR RECEIVED - scan with WhatsApp (Linked Devices).');
  qrcode.generate(qr, { small: true });
});

// Ready
client.on('ready', () => {
  console.log('Client is ready!');
  console.log('Allowed groups:', Array.from(ALLOWED_GROUP_IDS));
});

client.on('disconnected', (reason) => console.log('Client was disconnected:', reason));
client.on('auth_failure', (msg) => console.log('AUTH FAILURE:', msg));
client.on('change_state', (state) => console.log('STATE CHANGED:', state));

async function getAuthorName(message) {
  const authorId = message.author || null; // group participant id
  if (!authorId) return null;

  if (contactNameCache.has(authorId)) return contactNameCache.get(authorId);

  try {
    const contact = await client.getContactById(authorId);
    const name = contact?.pushname || contact?.name || contact?.number || authorId;
    contactNameCache.set(authorId, name);
    return name;
  } catch {
    return authorId;
  }
}

client.on('message', async (message) => {
  // 1) Ignore private chats completely
  if (!message.from.endsWith('@g.us')) return;

  // 2) Only allow specified groups
  if (!ALLOWED_GROUP_IDS.has(message.from)) return;

  const body = (message.body || '').trim();

  // --- Commands (handled first so they don't get inserted) ---
  if (body === '!ping') {
    await message.reply('pong');
    return;
  }

  if (body === 'ben') {
    await message.reply('kirk!');
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

  if (body.startsWith('!ranks')) {
    const parts = body.split(/\s+/);
    const n = parseInt(parts[1] || '10', 10);
    const limit = Number.isFinite(n) ? Math.min(Math.max(n, 3), 30) : 10;

    try {
      const rows = await getRanks(message.from, limit);
      if (!rows.length) {
        await message.reply('No stored messages yet.');
        return;
      }
      const lines = rows.map((r, i) => `${i + 1}. ${r.who} — ${r.cnt}`);
      await message.reply(`🏆 Top senders (stored rows)\n${lines.join('\n')}`);
    } catch (e) {
      console.error('getRanks failed:', e);
      await message.reply('Failed to rank (see server logs).');
    }
    return;
  }

  if (body === '!schema') {
    try {
      const cols = await getSchema(message.from);
      const lines = cols.map(c => `- ${c.name} (${c.type})`).join('\n');
      await message.reply(`🧱 messages table columns:\n${lines}`);
    } catch (e) {
      console.error('getSchema failed:', e);
      await message.reply('Failed to read schema.');
    }
    return;
  }

  if (body.startsWith('!sample')) {
    const parts = body.split(/\s+/);
    const n = parseInt(parts[1] || '5', 10);
    const limit = Number.isFinite(n) ? Math.min(Math.max(n, 1), 20) : 5;

    try {
      const rows = await getLastRows(message.from, limit);
      if (!rows.length) {
        await message.reply('No stored rows yet.');
        return;
      }

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

  // --- Non-command messages: store to DB ---
  const authorId = message.author || null;
  const authorName = await getAuthorName(message);

  console.log(`[${message.from}] ${body}`);
  console.log('DB file:', dbPathForChat(message.from));

  const ts = message.timestamp;
  const baseId = message.id._serialized;

  // MEDIA HANDLING (split into :text and :media rows)
  if (message.hasMedia) {
    // 1) Caption/text row (only if exists)
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

    // 2) Media row (metadata only for now)
    insertRow(message.from, {
      msg_id: `${baseId}:media`,
      ts,
      author_id: authorId,
      author_name: authorName,
      body: '',
      has_media: 1,
      entry_type: 'media',
      media_type: message.type || null, // e.g. image/video/audio/document
      media_mimetype: null,
      media_filename: null,
      media_size: null
    });

    return;
  }

  // Normal text row
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

// Initialize the client
client.initialize();
