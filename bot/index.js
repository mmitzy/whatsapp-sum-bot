const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const { insertMessage, countMessages, dbPathForChat } = require('./db');

// Multiple allowed groups (add more IDs here)
const ALLOWED_GROUP_IDS = new Set([
  '120363422504843223@g.us',
  // '1203XXXXXXXXXXXXXXX@g.us',
  // '1203YYYYYYYYYYYYYYY@g.us',
]);

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

// Useful: tells you why it disconnected
client.on('disconnected', (reason) => {
  console.log('Client was disconnected:', reason);
});

// Auth failures / session issues
client.on('auth_failure', (msg) => {
  console.log('AUTH FAILURE:', msg);
});

// Debug state changes (helps explain random logouts)
client.on('change_state', (state) => {
  console.log('STATE CHANGED:', state);
});

client.on('message', async (message) => {
  // 1) Ignore private chats completely
  if (!message.from.endsWith('@g.us')) return;

  // 2) Only allow messages from specific group(s)
  if (!ALLOWED_GROUP_IDS.has(message.from)) return;

  const body = (message.body || '').trim();

  console.log(`[${message.from}] ${body}`);
  console.log('DB file:', dbPathForChat(message.from));

  // 3) Commands (do commands BEFORE inserting if you want; either is fine)
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
      await message.reply(`Stored messages in this group DB: ${cnt}`);
    } catch (e) {
      console.error('countMessages failed:', e);
      await message.reply('Failed to count messages (see server logs).');
    }
    return;
  }

  // 4) Insert into that group's database
  insertMessage(message.from, {
    msg_id: message.id._serialized,
    ts: message.timestamp,
    author_id: message.author || null,
    author_name: null, // keep null for now
    body: body
  });
});

// Initialize the client
client.initialize();
