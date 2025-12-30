const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const ALLOWED_GROUP_ID = '120363422504843223@g.us';

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
  // Only groups you allow
  if (message.from !== ALLOWED_GROUP_ID) return;

  console.log(`[${message.from}] ${message.body}`);

  const body = (message.body || '').trim();

  if (body === '!ping') await message.reply('pong');
  if (body === 'ben') await message.reply('kirk!');
});

// Initialize the client
client.initialize();