const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

// Configuration: Enter the Group ID here after you find it in the console
// Example: '12036304567890@g.us'
const ALLOWED_GROUP_ID = 'YOUR_GROUP_ID_HERE'; 

// Create the client (the bot)
// LocalAuth saves the session so you don't have to scan the QR code every time
const client = new Client({
    authStrategy: new LocalAuth()
});

// Event: Generate QR code for scanning
client.on('qr', (qr) => {
    console.log('Scan this QR code with WhatsApp on your phone:');
    qrcode.generate(qr, { small: true });
});

// Event: Bot is ready
client.on('ready', () => {
    console.log('Client is ready!');
});

// Event: Message received
client.on('message', async (message) => {
    // Log the Group ID so you can find it
    console.log(`Message received from: ${message.from}`); 
    console.log(`Content: ${message.body}`);

    // --- SECURITY CHECK ---
    // If an ALLOWED_GROUP_ID is set, ignore messages from everywhere else
    if (ALLOWED_GROUP_ID !== 'YOUR_GROUP_ID_HERE' && message.from !== ALLOWED_GROUP_ID) {
        return; // Stop execution here
    }

    // Simple test - if the message is "!ping", reply with "pong"
    if (message.body === '!ping') {
        await message.reply('pong');
    }
});

// Initialize the client
client.initialize();