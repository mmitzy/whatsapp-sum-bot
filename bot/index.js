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
  relabelAuthorEverywhere,
  findIdentityByLabel,
  getMessagesSince,
  getRandomQuoteByAuthor,
  getLastTsByAuthors,
  getAuthorDaysSince,
  getTextBodiesSince,
  addJoke,
  listJokes,
  countPhraseOccurrences,
  ensureIdentity,
  getBalance,
  addBalance,
  transferBalance,
  claimDaily,
  getTopBalances
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
 * identities table keyed by:
 *   author_id = "<senderId>" (e.g. 1960...@lid)
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

function sanitizePhrase(p) {
  const s = String(p || '').trim();
  if (!s) return null;
  return s.replace(/\s+/g, ' ').slice(0, 60);
}

function fmtTime(ts) {
  try {
    const d = new Date(ts * 1000);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  } catch {
    return '';
  }
}

function dateToYMDLocal(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function fmtDaysAgo(nowTs, ts) {
  const diff = Math.max(0, nowTs - ts);
  const days = Math.floor(diff / 86400);
  if (days <= 0) return 'today';
  if (days === 1) return '1 day';
  return `${days} days`;
}

// interval parsing: "1h30m", "30m", "10s", "2h"
function parseIntervalToSeconds(s) {
  const str = String(s || '').trim().toLowerCase();
  if (!str) return null;
  const re = /(\d+)\s*([smhd])/g;
  let m;
  let total = 0;
  let matched = false;

  while ((m = re.exec(str)) !== null) {
    matched = true;
    const n = parseInt(m[1], 10);
    const u = m[2];
    if (!Number.isFinite(n)) continue;
    if (u === 's') total += n;
    if (u === 'm') total += n * 60;
    if (u === 'h') total += n * 3600;
    if (u === 'd') total += n * 86400;
  }

  return matched ? total : null;
}

const checkedCusIds = new Set();
function isDefaultUserAlias(label) {
  if (!label) return true;
  const s = String(label).trim();
  return /^User\b/i.test(s); 
}

async function maybeUpgradeAliasToPhoneFast(authorId, resolvedName) {
  if (!authorId?.endsWith('@c.us')) return false;

  // only if still default-ish
  if (!isDefaultUserAlias(resolvedName)) return false;

  // only check once per run
  if (checkedCusIds.has(authorId)) return false;
  checkedCusIds.add(authorId);

  const phone = normalizePhone(authorId);
  if (!phone) return false;

  const current = await getIdentity(authorId);
  if (current && !isDefaultUserAlias(current)) return false;

  await setIdentity(authorId, phone);
  await relabelAuthorEverywhere(authorId, phone);
  nameCache.delete(authorId);

  return true;
}


function clampSecondsTo24h(sec) {
  const s = parseInt(sec, 10);
  if (!Number.isFinite(s) || s <= 0) return null;
  return Math.min(s, 86400);
}

// Emoji regex (good-enough pragmatic)
const emojiRe = /[\p{Extended_Pictographic}]/gu;

function buildHelpText() {
  const cmds = config.COMMANDS || [];

  // Group into sections for readability
  const group = cmds.filter(c => (c.scope || '').toLowerCase().includes('group'));
  const dmAdmin = cmds.filter(c => (c.scope || '').toLowerCase().includes('dm (admin)'));
  const dmAny = cmds.filter(c => (c.scope || '').toLowerCase() === 'group / dm');

  const lines = [];
  lines.push('🤖 Bot Commands');
  lines.push('');

  if (dmAny.length) {
    lines.push('General');
    for (const c of dmAny) lines.push(`• ${c.cmd} — ${c.desc}`);
    lines.push('');
  }

  if (group.length) {
    lines.push('Group');
    for (const c of group) lines.push(`• ${c.cmd} — ${c.desc}`);
    lines.push('');
  }

  if (dmAdmin.length) {
    lines.push('DM (Admin only)');
    for (const c of dmAdmin) lines.push(`• ${c.cmd} — ${c.desc}`);
    lines.push('');
  }

  lines.push('Tip: Set your name with !alias <name> so stats look nicer.');
  return lines.join('\n').trim();
}

// DM help command: send full commands list
async function dmHelpToSender(message) {
  const senderId = getSenderId(message);
  if (!senderId) return false;

  const text = buildHelpText();

  try {
    // send DM directly (works even if command was used in group)
    await client.sendMessage(senderId, text);
    return true;
  } catch (e) {
    console.error('Failed to DM help:', e?.message || e);
    return false;
  }
}


// resolve name by author_id (uses identities first)
async function resolveNameById(authorId) {
  try {
    const mapped = await getIdentity(authorId);
    if (mapped && mapped.trim()) return mapped.trim();
  } catch {}
  return makeFriendlyAliasFromId(authorId);
}

// Cache lid -> phone to avoid repeated WA calls
const lidPhoneCache = new Map();

/**
 * Resolve phone number from a WhatsApp LID
 * @param {string} lid - e.g. "196099767820421@lid"
 * @returns {string|null} phone number like "0501234567" or null
 */
async function resolvePhoneFromLid(lid) {
  if (!lid || !lid.endsWith('@lid')) return null;

  if (lidPhoneCache.has(lid)) {
    return lidPhoneCache.get(lid);
  }

  try {
    const res = await client.getContactLidAndPhone([lid]);

    const first = Array.isArray(res) ? res[0] : null;
    if (!first) {
      lidPhoneCache.set(lid, null);
      return null;
    }

    // Usually something like "972501234567@c.us"
    const raw =
      first.phone ||
      first.phoneNumber ||
      first.waId ||
      null;

    if (!raw) {
      lidPhoneCache.set(lid, null);
      return null;
    }

    // normalize
    let phone = raw.replace(/@c\.us$/i, '').replace(/[^\d]/g, '');
    if (phone.startsWith('972')) phone = '0' + phone.slice(3);

    lidPhoneCache.set(lid, phone);
    return phone;
  } catch (e) {
    console.error('resolvePhoneFromLid failed:', e);
    lidPhoneCache.set(lid, null);
    return null;
  }
}


// ---------------------------
// BLACKJACK (in-memory per chat+player)
// ---------------------------

const BJ_MAX_MS = 2 * 60 * 1000; // 2 minutes edit window (tweak)
const bjGames = new Map(); // key = `${chatId}|${authorId}` -> game object

function bjKey(chatId, authorId) {
  return `${chatId}|${authorId}`;
}

function drawCard() {
  const ranks = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
  const suits = ['♠','♥','♦','♣'];
  const r = ranks[Math.floor(Math.random() * ranks.length)];
  const s = suits[Math.floor(Math.random() * suits.length)];
  return { r, s };
}

function handValue(cards) {
  // Count Aces as 11 first, then reduce to 1 as needed
  let total = 0;
  let aces = 0;

  for (const c of cards) {
    if (c.r === 'A') {
      total += 11;
      aces += 1;
    } else if (['K','Q','J'].includes(c.r)) {
      total += 10;
    } else {
      total += parseInt(c.r, 10);
    }
  }

  while (total > 21 && aces > 0) {
    total -= 10; // convert one Ace from 11 to 1
    aces -= 1;
  }

  return total;
}

function fmtCards(cards, hideFirst = false) {
  return cards.map((c, i) => {
    if (hideFirst && i === 0) return '🂠';
    return `${c.r}${c.s}`;
  }).join(' ');
}

function isBlackjack(cards) {
  return cards.length === 2 && handValue(cards) === 21;
}

async function bjUpdateMessage(game, fallbackMessage) {
  const txt = bjRender(game);

  // Try edit the existing bot message first
  if (game.botMsg?.edit) {
    try {
      const edited = await game.botMsg.edit(txt);
      if (edited) {
        game.botMsg = edited; // keep the latest reference if library returns a new Message
        return true;
      }
    } catch (e) {
      // fall through to fallback reply
    }
  }

  // Fallback: send a new message (rare)
  try {
    const sent = await fallbackMessage.reply(txt);
    game.botMsg = sent;
    return true;
  } catch {
    return false;
  }
}


function calcPayout(game) {
  // returns delta to apply to balance (positive = win, negative = lose)
  // bet already deducted at start; so:
  // - win: +2*bet (gets bet back + winnings)
  // - blackjack: +2.5*bet (3:2 payout)
  // - push: +bet (gets bet back)
  // - lose: +0
  const bet = game.bet;
  if (game.result === 'player_blackjack') return Math.floor(bet * 2.5);
  if (game.result === 'player_win') return bet * 2;
  if (game.result === 'push') return bet;
  return 0;
}

function bjRender(game) {
  const pv = handValue(game.player);
  const dv = handValue(game.dealer);

  const header = `🃏 Blackjack — Bet: ${game.bet}₪`;
  const dealerLine = game.state === 'playing'
    ? `Dealer: ${fmtCards(game.dealer, true)}`
    : `Dealer: ${fmtCards(game.dealer)}  (${dv})`;

  const playerLine = `You:    ${fmtCards(game.player)}  (${pv})`;

  let footer = '';
  if (game.state === 'playing') {
    footer =
      `\nCommands: !hit  !stand` +
      (game.canDouble ? `  !double` : '') +
      `\n⏳ Ends if not finished within ${Math.floor(BJ_MAX_MS / 1000)}s`;
  } else {
    footer = `\nResult: ${game.resultText}`;
  }

  return `${header}\n${dealerLine}\n${playerLine}${footer}`;
}
// ---------------------------

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

  lidPhoneCache.clear();
});

client.on('disconnected', (reason) => console.log('Client was disconnected:', reason));
client.on('auth_failure', (msg) => console.log('AUTH FAILURE:', msg));
client.on('change_state', (state) => console.log('STATE CHANGED:', state));

client.on('message', async (message) => {
  const body = (message.body || '').trim();

  // ---------------------------
  // DM COMMANDS (admin only) except !help
  // ---------------------------
  if (isDm(message)) {
    
    if (body === '!help') {
      const ok = await dmHelpToSender(message);
      await message.reply(ok ? '📩 Sent you a DM with all commands.' : "I couldn't DM you. Try DMing me first.");
      return;
    }

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
        if (!rows.length) return void (await message.reply('No aliases saved yet.'));
        const lines = rows.map(r => `${r.author_id} -> ${r.label}`);
        await message.reply(`📒 Aliases (latest ${rows.length}):\n` + lines.join('\n'));
      } catch (e) {
        console.error('listIdentities failed:', e);
        await message.reply('Failed to list aliases (see server logs).');
      }
      return;
    }

    // !who <alias> (admin)
    if (body.startsWith('!who ')) {
      const alias = body.slice('!who '.length).trim();
        if (!alias) {
          await message.reply('Usage: !who <alias>\nExample: !who Sibo');
          return;
      }

      try {
        const matches = await findIdentityByLabel(alias, 5);
        if (!matches.length) {
          await message.reply(`No exact alias found for: "${alias}"`);
          return;
        }

        // Resolve phones (best-effort)
        const lines = [];
        for (const m of matches) {
          const aid = m.author_id || '';
          let phone = null;

          if (aid.endsWith('@c.us')) {
            phone = normalizePhone(aid); // from c.us directly
          } else if (aid.endsWith('@lid')) {
              phone = await resolvePhoneFromLid(aid);
            }

          lines.push(`${m.label} -> ${aid} (${phone || 'N/A'})`);
        }

        await message.reply(`🔎 Matches:\n` + lines.join('\n'));
        } catch (e) {
            console.error('!who failed:', e);
            await message.reply('Failed to lookup alias (see server logs).');
          }
      return;
    }


    // !sample [N]
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

    // !alias <author_id> <name> (admin)
    if (body.startsWith('!alias ')) {
      const parts = body.split(/\s+/);
      const targetId = (parts[1] || '').trim();
      const labelRaw = parts.slice(2).join(' ');
      const label = sanitizeLabel(labelRaw);

      if (!targetId || !label) {
        await message.reply(
          `Usage:\n` +
          `- !alias <author_id> <name>\n` +
          `Example: !alias 1960...@lid Sibo`
        );
        return;
      }

      if (!targetId.includes('@') || (!targetId.endsWith('@lid') && !targetId.endsWith('@c.us'))) {
        await message.reply('❌ author_id must end with @lid or @c.us');
        return;
      }

      try {
        await setIdentity(targetId, label);

        const res = await relabelAuthorEverywhere(targetId, label);
        const totalChanged = res?.changed ?? 0;

        nameCache.delete(targetId);

        await message.reply(
          `✅ Saved mapping + updated history:\n` +
          `${targetId} -> ${label}\n` +
          `Rows updated: ${totalChanged}`
        );
      } catch (e) {
        console.error('alias+relabel failed:', e);
        await message.reply('Failed to save mapping/update history (see server logs).');
      }
      return;
    }

    // !give <alias> <amount>  (admin mint)
    // Example: !give Sibo 250
    if (body.startsWith('!give ')) {
      const parts = body.split(/\s+/);
      const amount = parseInt(parts[parts.length - 1], 10);
      const alias = parts.slice(1, -1).join(' ').trim();

      if (!alias || !Number.isFinite(amount) || amount <= 0) {
        await message.reply('Usage: !give <alias> <amount>\nExample: !give Sibo 250');
        return;
      }

      try {
        const matches = await findIdentityByLabel(alias, 5);
        if (!matches.length) {
          await message.reply(`No exact alias found for: "${alias}"`);
          return;
        }

        const targetId = matches[0].author_id;
        await ensureIdentity(targetId, matches[0].label);
        await addBalance(targetId, amount);

        const newBal = await getBalance(targetId);
        await message.reply(`✅ Gave ${amount}₪ to ${matches[0].label}\nNew balance: ${newBal}₪\n(author_id: ${targetId})`);
      } catch (e) {
        console.error('!give (admin) failed:', e);
        await message.reply('Failed to give balance (see server logs).');
      }
      return;
    }

    return;
  }

  // ---------------------------
  // GROUP ONLY
  // ---------------------------
  if (!message.from.endsWith('@g.us')) return;
  if (!ALLOWED_GROUP_IDS.has(message.from)) return;

  // Commands first (don’t insert)
  if (body === '!ping') return void (await message.reply('pong'));
  if (body === '!ben') return void (await message.reply('kirk!'));

  // !help - sends all commands via DM
  if (body === '!help') {
    const ok = await dmHelpToSender(message);
    if (ok) {
      await message.reply('📩 Sent you a DM with all commands.');
    } else {
      await message.reply("I couldn't DM you. Try DMing me first, then run !help again.");
    }
    return;
  }

  // ---------------------------
  // BALANCE / ECONOMY COMMANDS
  // ---------------------------

  // !balance
  if (body === '!balance') {
    try {
      const me = getSenderId(message);
      if (!me) {
        await message.reply("Couldn't detect your sender id.");
        return;
      }

      const myLabel = await resolveAuthorName(message);
      await ensureIdentity(me, myLabel);

      const bal = await getBalance(me);
      await message.reply(`💰 Balance for ${myLabel}: ${bal}₪`);
    } catch (e) {
      console.error('!balance failed:', e);
      await message.reply('Failed to read balance (see server logs).');
    }
    return;
  }

  // !daily  (100₪ per 24h)
  if (body === '!daily') {
    try {
      const me = getSenderId(message);
      if (!me) {
        await message.reply("Couldn't detect your sender id.");
        return;
      }

      const myLabel = await resolveAuthorName(message);
      await ensureIdentity(me, myLabel);

      const now = Math.floor(Date.now() / 1000);
      const res = await claimDaily(me, now, 100);

      if (!res.ok) {
        const remaining = Math.max(0, Math.floor(res.remaining_sec || 0));
        const hrs = Math.floor(remaining / 3600);
        const mins = Math.floor((remaining % 3600) / 60);
        const timeLeft = `${hrs}h${String(mins).padStart(2, '0')}m`;
        const bal = await getBalance(me);
        await message.reply(`⏳ Daily already claimed. Try again in ${timeLeft}.\nCurrent balance: ${bal}₪`);
        return;
      }

      const bal = await getBalance(me);
      await message.reply(`🎁 Daily claimed! +100₪\nNew balance: ${bal}₪`);
    } catch (e) {
      console.error('!daily failed:', e);
      await message.reply('Failed to claim daily (see server logs).');
    }
    return;
  }

  // !give <alias> <amount>  (user transfer)
  if (body.startsWith('!give ')) {
    const parts = body.split(/\s+/);
    const amount = parseInt(parts[parts.length - 1], 10);
    const alias = parts.slice(1, -1).join(' ').trim();

    if (!alias || !Number.isFinite(amount) || amount <= 0) {
      await message.reply('Usage: !give <alias> <amount>\nExample: !give Sibo 25');
      return;
    }

    try {
      const me = getSenderId(message);
      if (!me) {
        await message.reply("Couldn't detect your sender id.");
        return;
      }

      const myLabel = await resolveAuthorName(message);
      await ensureIdentity(me, myLabel);

      const matches = await findIdentityByLabel(alias, 5);
      if (!matches.length) {
        await message.reply(`No exact alias found for: "${alias}"`);
        return;
      }

      const targetId = matches[0].author_id;
      if (targetId === me) {
        await message.reply("You can't give money to yourself 🙂");
        return;
      }

      await ensureIdentity(targetId, matches[0].label);
      const t = await transferBalance(me, targetId, amount);
      if (!t.ok) {
        const bal = await getBalance(me);
        await message.reply(`❌ Not enough balance.\nYour balance: ${bal}₪`);
        return;
      }

      const myNew = await getBalance(me);
      const theirNew = await getBalance(targetId);
      await message.reply(`✅ Sent ${amount}₪ to ${matches[0].label}\nYour balance: ${myNew}₪\nTheir balance: ${theirNew}₪`);
    } catch (e) {
      console.error('!give (group) failed:', e);
      await message.reply('Failed to transfer balance (see server logs).');
    }
    return;
  }

  // !topbal
  if (body === '!topbal') {
    try {
      const rows = await getTopBalances(10);
      if (!rows.length) {
        await message.reply('No balances yet. Use !daily to start.');
        return;
      }

      const LRM = '\u200E'; // iOS-safe LTR
      const lines = rows.map(r => `${LRM}${r.balance}₪ • ${r.label || makeFriendlyAliasFromId(r.author_id)}`);
      await message.reply('🏦 Top balances\n' + lines.join('\n'));
    } catch (e) {
      console.error('!topbal failed:', e);
      await message.reply('Failed to load balances (see server logs).');
    }
    return;
  }

  /**
   * EVERYONE (GROUP):
   * !alias <name>
   */
  if (body.startsWith('!alias ')) {
    const labelRaw = body.slice('!alias '.length);
    const label = sanitizeLabel(labelRaw);

    if (!label) {
      await message.reply(`Usage: !alias <your name>\nExample: !alias Sibo`);
      return;
    }

    const senderId = getSenderId(message);
    if (!senderId) {
      await message.reply("Couldn't detect your sender id.");
      return;
    }

    try {
      await setIdentity(senderId, label);

      const res = await relabelAuthorEverywhere(senderId, label);
      const totalChanged = res?.changed ?? 0;

      nameCache.delete(senderId);

      await message.reply(
        `✅ Alias saved for you: ${label}\n` +
        `Rows updated: ${totalChanged}`
      );
    } catch (e) {
      console.error('group alias failed:', e);
      await message.reply('Failed to save alias (see server logs).');
    }
    return;
  }

  // !ghosts
  if (body === '!ghosts') {
    try {
      const chat = await message.getChat();
      const participants = (chat?.participants || []).map(p => p.id?._serialized).filter(Boolean);

      if (!participants.length) {
        await message.reply("Couldn't read participants list (WhatsApp limitation).");
        return;
      }

      const lastRows = await getLastTsByAuthors(message.from, participants);
      const lastMap = new Map(lastRows.map(r => [r.author_id, r.last_ts]));

      const now = Math.floor(Date.now() / 1000);
      const THRESH = 7 * 86400;

      const ghosts = [];
      for (const pid of participants) {
        const lastTs = lastMap.get(pid) || 0;
        const silentFor = now - lastTs;

        if (!lastTs || silentFor >= THRESH) {
          const name = await resolveNameById(pid);
          ghosts.push({ pid, name, lastTs });
        }
      }

      ghosts.sort((a, b) => (a.lastTs || 0) - (b.lastTs || 0));

      if (!ghosts.length) {
        await message.reply('👻 No ghosts! Everyone spoke in the last 7 days.');
        return;
      }

      const lines = ghosts.slice(0, 12).map(g => {
        const age = g.lastTs ? fmtDaysAgo(now, g.lastTs) : 'never';
        return `• ${g.name} — ${age}`;
      });

      await message.reply(`👻 Ghosts (silent ≥ 7d)\n` + lines.join('\n'));
    } catch (e) {
      console.error('!ghosts failed:', e);
      await message.reply('Failed to compute ghosts (see server logs).');
    }
    return;
  }

  // !quote <alias>
  if (body.startsWith('!quote ')) {
    const alias = body.slice('!quote '.length).trim();
    if (!alias) {
      await message.reply(`Usage: !quote <alias>\nExample: !quote Sibo`);
      return;
    }

    try {
      const matches = await findIdentityByLabel(alias, 5);
      if (!matches.length) {
        await message.reply(`No exact alias found for: "${alias}".\nTip: set it with !alias <name>`);
        return;
      }

      const authorId = matches[0].author_id;
      const q = await getRandomQuoteByAuthor(message.from, authorId);

      if (!q || !q.body) {
        await message.reply(`No quote found for "${alias}" in this group yet.`);
        return;
      }

      const text = String(q.body).trim().replace(/\s+/g, ' ');
      const who = matches[0].label || alias;
      const t = fmtTime(q.ts);

      await message.reply(`📜 Quote (${who}, ${t})\n"${text}"`);
    } catch (e) {
      console.error('!quote failed:', e);
      await message.reply('Failed to fetch quote (see server logs).');
    }
    return;
  }

  // !streaks
  if (body === '!streaks') {
    try {
      const now = Math.floor(Date.now() / 1000);
      const since = now - 60 * 86400;

      const rows = await getAuthorDaysSince(message.from, since);
      if (!rows.length) {
        await message.reply('No data yet.');
        return;
      }

      const dayMap = new Map();
      for (const r of rows) {
        if (!r.author_id || !r.day) continue;
        if (!dayMap.has(r.author_id)) dayMap.set(r.author_id, new Set());
        dayMap.get(r.author_id).add(r.day);
      }

      const todayYMD = dateToYMDLocal(new Date());

      function prevDayYMD(ymd) {
        const [y, m, d] = ymd.split('-').map(Number);
        const dt = new Date(y, m - 1, d);
        dt.setDate(dt.getDate() - 1);
        return dateToYMDLocal(dt);
      }

      const streaks = [];
      for (const [aid, set] of dayMap.entries()) {
        let streak = 0;
        let cur = todayYMD;

        while (set.has(cur)) {
          streak += 1;
          cur = prevDayYMD(cur);
        }

        if (streak > 0) {
          const name = await resolveNameById(aid);
          streaks.push({ name, streak });
        }
      }

      streaks.sort((a, b) => b.streak - a.streak);

      if (!streaks.length) {
        await message.reply('🔥 No active streaks today.');
        return;
      }

      const LRM = '\u200E';
      const top = streaks
        .slice(0, 10)
        .map((s, i) => `${LRM}${s.streak} day(s) • ${s.name}`);

      await message.reply(`🔥 Streaks (consecutive days incl. today)\n` + top.join('\n'));

    } catch (e) {
      console.error('!streaks failed:', e);
      await message.reply('Failed to compute streaks (see server logs).');
    }
    return;
  }

  // !emojis
  if (body === '!emojis') {
    try {
      const now = Math.floor(Date.now() / 1000);
      const since = now - 30 * 86400;

      const rows = await getTextBodiesSince(message.from, since, 5000);
      if (!rows.length) {
        await message.reply('No text messages to analyze.');
        return;
      }

      const perAuthor = new Map();

      for (const r of rows) {
        const aid = r.author_id;
        if (!aid) continue;
        const text = String(r.body || '');
        const matches = text.match(emojiRe);
        if (!matches || !matches.length) continue;

        if (!perAuthor.has(aid)) perAuthor.set(aid, new Map());
        const em = perAuthor.get(aid);

        for (const e of matches) {
          em.set(e, (em.get(e) || 0) + 1);
        }
      }

      const personalities = [];
      for (const [aid, emMap] of perAuthor.entries()) {
        const total = Array.from(emMap.values()).reduce((a, b) => a + b, 0);
        if (total < 3) continue;

        const top3 = Array.from(emMap.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(x => x[0])
          .join('');

        const name = await resolveNameById(aid);
        personalities.push({ name, top3, total });
      }

      personalities.sort((a, b) => b.total - a.total);

      if (!personalities.length) {
        await message.reply('No meaningful emoji usage found (need a few more emojis 😄).');
        return;
      }

      const lines = personalities.slice(0, 12).map(p => `• ${p.name} → ${p.top3}`);
      await message.reply(`😂 Emoji personalities (last 30d)\n` + lines.join('\n'));
    } catch (e) {
      console.error('!emojis failed:', e);
      await message.reply('Failed to compute emojis (see server logs).');
    }
    return;
  }

  // !joke <phrase>
  if (body.startsWith('!joke ')) {
    const phraseRaw = body.slice('!joke '.length);
    const phrase = sanitizePhrase(phraseRaw);

    if (!phrase) {
      await message.reply(`Usage: !joke <word or phrase>\nExample: !joke ben kirk`);
      return;
    }

    const senderId = getSenderId(message);

    try {
      await addJoke(message.from, phrase, senderId);
      await message.reply(`🤣 Saved joke phrase:\n"${phrase}"\nUse !jokes to view the list.`);
    } catch (e) {
      console.error('!joke failed:', e);
      await message.reply('Failed to save joke (see server logs).');
    }
    return;
  }

  // !jokes — list tracked jokes (LTR-stable)
  if (body === '!jokes') {
    try {
      const jokes = await listJokes(message.from);

      if (!jokes.length) {
        await message.reply('🤣 No jokes saved yet.\nUse !joke <phrase> to add one.');
        return;
      }

      const LRM = '\u200E';
      const since30d = Math.floor(Date.now() / 1000) - 30 * 24 * 3600;

      const lines = [];
      for (const j of jokes) {
        const allTime = await countPhraseOccurrences(message.from, j.phrase, null);
        const last30 = await countPhraseOccurrences(message.from, j.phrase, since30d);
        lines.push(`${LRM}${allTime} • ${j.phrase} (${last30}/30d)`);
      }

      await message.reply(`🤣 Group jokes\n` + lines.join('\n'));
    } catch (e) {
      console.error('!jokes failed:', e);
      await message.reply('Failed to load jokes.');
    }
    return;
  }

  // !sum <interval> (max 24h) - prints messages in that window
  if (body.startsWith('!sum ')) {
    const arg = body.slice('!sum '.length).trim();
    let sec = parseIntervalToSeconds(arg);
    sec = clampSecondsTo24h(sec);

    if (!sec) {
      await message.reply(
        `Usage: !sum <interval>\n` +
        `Examples: !sum 1h | !sum 30m | !sum 10s | !sum 1h30m\n` +
        `Max: 24h`
      );
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    const since = now - sec;

    try {
      const rows = await getMessagesSince(message.from, since, 5000);
      if (!rows.length) {
        await message.reply(`No messages found in the last ${arg} (capped at 24h).`);
        return;
      }

      let out = `🧾 Messages from last ${arg} (max 24h)\n`;

      for (const r of rows) {
        const who = (r.author_name || 'Unknown').trim();
        const t = fmtTime(r.ts);

        let line = '';
        if (r.entry_type === 'media') {
          line = `[${t}] ${who}: [media:${r.media_type || 'unknown'}]`;
        } else {
          const text = (r.body || '').replace(/\s+/g, ' ').trim();
          if (!text) continue;
          line = `[${t}] ${who}: ${text}`;
        }

        if (out.length + line.length + 2 > (config.MAX_SUMMARY_CHARS || 3500)) {
          out += `\n… (truncated, total rows: ${rows.length})`;
          break;
        }
        out += line + '\n';
      }

      await message.reply(out.trim());
    } catch (e) {
      console.error('!sum failed:', e);
      await message.reply('Failed to gather messages (see server logs).');
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

  if (body.startsWith('!ranks')) {
    const parts = body.split(/\s+/);
    const n = parseInt(parts[1] || '10', 10);
    const limit = Number.isFinite(n) ? Math.min(Math.max(n, 3), 30) : 10;

    try {
      const rows = await getRanks(message.from, limit);
      if (!rows.length) return void (await message.reply('No stored messages yet.'));

      const LRM = '\u200E';
      const lines = rows.map(r => `${LRM}${r.cnt} msg • ${r.who}`);
      await message.reply(`🏆 Top senders\n` + lines.join('\n'));
    } catch (e) {
      console.error('getRanks failed:', e);
      await message.reply('Failed to rank (see server logs).');
    }
    return;
  }

    // ---------------------------
  // BLACKJACK COMMANDS
  // ---------------------------

  // Start a game: !blackjack <bet>
  if (body.startsWith('!blackjack')) {
    const parts = body.split(/\s+/);
    const bet = parseInt(parts[1] || '', 10);

    if (!Number.isFinite(bet) || bet <= 0) {
      await message.reply('Usage: !blackjack <bet>\nExample: !blackjack 50');
      return;
    }

    const authorId = getSenderId(message);
    if (!authorId) {
      await message.reply("Couldn't detect your sender id.");
      return;
    }

    const key = bjKey(message.from, authorId);

    // prevent overlapping games
    if (bjGames.has(key)) {
      const g = bjGames.get(key);
      await message.reply(`You already have a game running.\nUse !hit / !stand / !double\nOr wait for it to expire.`);
      return;
    }

    try {
      const authorName = await resolveAuthorName(message);
      await ensureIdentity(authorId, authorName);

      const bal = await getBalance(authorId);
      if (bal < bet) {
        await message.reply(`❌ Not enough balance.\nYour balance: ${bal}₪`);
        return;
      }

      // Deduct bet immediately
      await addBalance(authorId, -bet);

      const game = {
        chatId: message.from,
        authorId,
        bet,
        createdTs: Date.now(),
        state: 'playing',
        player: [drawCard(), drawCard()],
        dealer: [drawCard(), drawCard()],
        canDouble: true,
        result: null,
        resultText: '',
        botMsg: null,          
        replyMsgId: null,
        timeoutHandle: null
      };


      // Natural blackjack checks
      const pBJ = isBlackjack(game.player);
      const dBJ = isBlackjack(game.dealer);

      if (pBJ || dBJ) {
        game.state = 'done';
        if (pBJ && dBJ) {
          game.result = 'push';
          game.resultText = `Push (both blackjack). You get ${game.bet}₪ back.`;
        } else if (pBJ) {
          game.result = 'player_blackjack';
          game.resultText = `Blackjack! You win (3:2). You get ${Math.floor(game.bet * 2.5)}₪.`;
        } else {
          game.result = 'dealer_blackjack';
          game.resultText = `Dealer has blackjack. You lose.`;
        }

        // payout
        const payout = calcPayout(game);
        if (payout > 0) await addBalance(authorId, payout);

        const txt = bjRender(game);
        await message.reply(txt);
        bjGames.delete(key);
        return;
      }

      const sent = await message.reply(bjRender(game));
      game.botMsg = sent;
      game.replyMsgId = sent.id?._serialized || null;

      // expiration
      game.timeoutHandle = setTimeout(async () => {
        try {
          // If still exists + still playing, force-end (push bet back)
          const g = bjGames.get(key);
          if (!g || g.state !== 'playing') return;

          g.state = 'done';
          g.result = 'push';
          g.resultText = `⏱️ Timed out. Game ended as Push. You get ${g.bet}₪ back.`;

          await addBalance(authorId, g.bet); // refund bet

          // try edit the original message if possible
          await bjUpdateMessage(g, message);

          bjGames.delete(key);
        } catch (e) {
          console.error('BJ timeout handler failed:', e);
          bjGames.delete(key);
        }
      }, BJ_MAX_MS);

      bjGames.set(key, game);
      return;
    } catch (e) {
      console.error('!blackjack failed:', e);
      await message.reply('Failed to start blackjack (see server logs).');
      bjGames.delete(key);
      return;
    }
  }

  // helper: handle action for existing game
  async function withGame(actionFn) {
    const authorId = getSenderId(message);
    if (!authorId) return null;
    const key = bjKey(message.from, authorId);
    const game = bjGames.get(key);
    if (!game || game.state !== 'playing') return null;

    await actionFn(game, key);
    return true;
  }

  // !hit
  if (body === '!hit') {
    const ok = await withGame(async (game, key) => {
      game.player.push(drawCard());
      game.canDouble = false;

      const pv = handValue(game.player);
      if (pv > 21) {
        game.state = 'done';
        game.result = 'bust';
        game.resultText = `Busted (${pv}). You lose.`;
      }

      // Try to edit the bot's original reply
      await bjUpdateMessage(game, message);

      // If busted, end the game AFTER updating the message once
      if (game.state === 'done') {
        clearTimeout(game.timeoutHandle);
        bjGames.delete(key);
      }

    });

    if (!ok) {
      await message.reply('No active blackjack game. Start with: !blackjack <bet>');
    }
    return;
  }

  // !stand
  if (body === '!stand') {
    const ok = await withGame(async (game, key) => {
      game.canDouble = false;

      // Dealer plays
      while (handValue(game.dealer) < 17) {
        game.dealer.push(drawCard());
      }

      const pv = handValue(game.player);
      const dv = handValue(game.dealer);

      game.state = 'done';

      if (dv > 21) {
        game.result = 'player_win';
        game.resultText = `Dealer busted (${dv}). You win! You get ${game.bet * 2}₪.`;
      } else if (pv > dv) {
        game.result = 'player_win';
        game.resultText = `You win ${pv} vs ${dv}! You get ${game.bet * 2}₪.`;
      } else if (pv === dv) {
        game.result = 'push';
        game.resultText = `Push ${pv} vs ${dv}. You get ${game.bet}₪ back.`;
      } else {
        game.result = 'dealer_win';
        game.resultText = `Dealer wins ${dv} vs ${pv}. You lose.`;
      }

      // payout
      const payout = calcPayout(game);
      if (payout > 0) await addBalance(game.authorId, payout);

      clearTimeout(game.timeoutHandle);
      await bjUpdateMessage(game, message);
      bjGames.delete(key);

    });

    if (!ok) {
      await message.reply('No active blackjack game. Start with: !blackjack <bet>');
    }
    return;
  }

  // !double
  if (body === '!double') {
    const ok = await withGame(async (game, key) => {
      if (!game.canDouble) {
        await message.reply("You can't double now (only allowed on your first move).");
        return;
      }

      const bal = await getBalance(game.authorId);
      if (bal < game.bet) {
        await message.reply(`❌ Not enough balance to double.\nYour balance: ${bal}₪`);
        return;
      }

      // Deduct additional bet
      await addBalance(game.authorId, -game.bet);
      game.bet *= 2;
      game.canDouble = false;

      // One card only, then stand automatically
      game.player.push(drawCard());

      const pv = handValue(game.player);
      if (pv > 21) {
        game.state = 'done';
        game.result = 'bust';
        game.resultText = `Busted (${pv}) after double. You lose.`;

        clearTimeout(game.timeoutHandle);
        await bjUpdateMessage(game, message);
        bjGames.delete(key);
        return;
      }

      // Dealer plays out
      while (handValue(game.dealer) < 17) {
        game.dealer.push(drawCard());
      }

      const dv = handValue(game.dealer);

      game.state = 'done';
      if (dv > 21) {
        game.result = 'player_win';
        game.resultText = `Dealer busted (${dv}). You win! You get ${game.bet * 2}₪.`;
      } else if (pv > dv) {
        game.result = 'player_win';
        game.resultText = `You win ${pv} vs ${dv}! You get ${game.bet * 2}₪.`;
      } else if (pv === dv) {
        game.result = 'push';
        game.resultText = `Push ${pv} vs ${dv}. You get ${game.bet}₪ back.`;
      } else {
        game.result = 'dealer_win';
        game.resultText = `Dealer wins ${dv} vs ${pv}. You lose.`;
      }

      const payout = calcPayout(game);
      if (payout > 0) await addBalance(game.authorId, payout);

      clearTimeout(game.timeoutHandle);
      bjGames.delete(key);

      await bjUpdateMessage(game, message);
    });

    if (!ok) {
      await message.reply('No active blackjack game. Start with: !blackjack <bet>');
    }
    return;
  }


  // ---------------------------
  // STORE MESSAGE
  // ---------------------------
  const ts = message.timestamp;
  const baseId = message.id._serialized;

  const authorId = getSenderId(message);

  // first resolve name
  let authorName = await resolveAuthorName(message);

  // if we can see @c.us and the alias is still default "User ...", upgrade to phone (one-time per user)
  try {
    await maybeUpgradeAliasToPhoneFast(authorId, authorName);
    // if upgraded, resolve again so we store the new phone label
    authorName = await resolveAuthorName(message);
    } catch (e) {
      console.error('maybeUpgradeAliasToPhoneFast failed:', e);
    }


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
