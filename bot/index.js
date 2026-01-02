// bot/index.js
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const config = require('./config');

const {
  insertRow,
  countMessages,
  getRanks,
  getLastRows,
  setIdentity,
  getIdentity,
  listIdentities,
  findIdentityByLabel,
  relabelAuthorEverywhere,
  getMessagesSince,
  getRandomQuoteByAuthor,
  getLastTsByAuthors,
  getAuthorDaysSince,
  getTextBodiesSince,
  addJoke,
  listJokes,
  countPhraseOccurrences
} = require('./db');

const ALLOWED_GROUP_IDS = new Set(config.ALLOWED_GROUP_IDS);
const ADMIN_DM_IDS = new Set(config.ADMIN_DM_IDS);

const nameCache = new Map();

const client = new Client({
  authStrategy: new LocalAuth({ clientId: config.CLIENT_ID })
});

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
 * Alias-first resolution (prevents name splits)
 */
async function resolveAuthorName(message) {
  const senderId = getSenderId(message);
  if (!senderId) return 'Unknown';

  if (nameCache.has(senderId)) return nameCache.get(senderId);

  // 1) Manual mapping first
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

  // 2) WhatsApp-provided fields
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

  // 3) Friendly fallback
  const alias = makeFriendlyAliasFromId(senderId);
  nameCache.set(senderId, alias);
  return alias;
}

async function resolveNameById(authorId) {
  if (!authorId) return 'Unknown';
  if (nameCache.has(authorId)) return nameCache.get(authorId);

  try {
    const mapped = await getIdentity(authorId);
    if (mapped && mapped.trim()) {
      const clean = mapped.trim();
      nameCache.set(authorId, clean);
      return clean;
    }
  } catch {}

  const fallback = makeFriendlyAliasFromId(authorId);
  nameCache.set(authorId, fallback);
  return fallback;
}

function sanitizeLabel(label) {
  const s = String(label || '').trim();
  if (!s) return null;
  return s.replace(/\s+/g, ' ').slice(0, 40);
}

function sanitizePhrase(phrase) {
  const s = String(phrase || '').trim();
  if (!s) return null;
  // allow phrases, but keep them shortish
  return s.replace(/\s+/g, ' ').slice(0, 60);
}

// ---- interval parsing for !sum ----
function parseIntervalToSeconds(input) {
  const s = String(input || '').trim().toLowerCase();
  if (!s) return null;

  const re = /(\d+)\s*([smhd])/g;
  let match;
  let total = 0;
  let found = false;

  while ((match = re.exec(s)) !== null) {
    found = true;
    const n = parseInt(match[1], 10);
    const unit = match[2];
    if (!Number.isFinite(n) || n <= 0) return null;

    if (unit === 's') total += n;
    else if (unit === 'm') total += n * 60;
    else if (unit === 'h') total += n * 3600;
    else if (unit === 'd') total += n * 86400;
  }

  if (!found) return null;
  return total;
}

function clampSecondsTo24h(sec) {
  if (!sec) return null;
  return Math.min(sec, 86400);
}

function fmtTime(tsSec) {
  const d = new Date(tsSec * 1000);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function fmtDaysAgo(nowSec, tsSec) {
  if (!tsSec) return 'never';
  const delta = Math.max(0, nowSec - tsSec);
  const days = Math.floor(delta / 86400);
  const hours = Math.floor((delta % 86400) / 3600);
  if (days <= 0) return `${hours}h ago`;
  return `${days}d ago`;
}

function dateToYMDLocal(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Emoji extraction (Node supports Unicode property escapes)
const emojiRe = /\p{Extended_Pictographic}/gu;

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
  // uncomment to discover group ids
  // if (message.from.endsWith('@g.us')) console.log('GROUP ID:', message.from);

  const body = (message.body || '').trim();

  // ---------------------------
  // DM (ADMIN ONLY)
  // ---------------------------
  if (isDm(message)) {

    // !help should work for anyone in DM too
    if (body === '!help') {
      const ok = await dmHelpToSender(message);
      if (!ok) await message.reply('Could not DM you the help text (check privacy settings).');
      return;
    }

    // After this, only admin DMs
    if (!isAdminDmSender(message)) return;

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
        const lines = rows.map(r => `${r.author_id} -> ${r.label}`);
        await message.reply(`📒 Aliases (latest ${rows.length}):\n` + lines.join('\n'));
      } catch (e) {
        console.error('listIdentities failed:', e);
        await message.reply('Failed to list aliases (see server logs).');
      }
      return;
    }

    // !who <alias>
    if (body.startsWith('!who ')) {
      const alias = body.slice('!who '.length).trim();
      if (!alias) {
        await message.reply('Usage: !who <alias>\nExample: !who דניאל סנטר 13');
        return;
      }

      try {
        const rows = await findIdentityByLabel(alias, 10);
        if (!rows.length) {
          await message.reply(`No author_id found for alias: "${alias}"`);
          return;
        }
        const lines = rows.map(r => `${r.label}  ->  ${r.author_id}`);
        await message.reply(`Matches (latest first):\n` + lines.join('\n'));
      } catch (e) {
        console.error('!who failed:', e);
        await message.reply('Failed to search alias (see server logs).');
      }
      return;
    }

    // !alias <author_id> <name>  (admin only)
    if (body.startsWith('!alias ')) {
      const parts = body.split(/\s+/);
      const targetId = (parts[1] || '').trim();
      const labelRaw = parts.slice(2).join(' ');
      const label = sanitizeLabel(labelRaw);

      if (!targetId || !label) {
        await message.reply(
          `Usage:\n` +
          `- !alias <author_id> <name>\n` +
          `Example: !alias 1960...@lid Sibo\n` +
          `Tip: use !who <alias> to find author_id`
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

  // Everyone: !alias <name> sets alias for THEMSELVES
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

  // !ghosts  (silent members)
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

        // ignore "me" if you want (optional):
        // if (pid === chat?.id?._serialized) continue;

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

  // !streaks  (consecutive days with ≥1 message)
  if (body === '!streaks') {
    try {
      const now = Math.floor(Date.now() / 1000);
      const since = now - 60 * 86400; // only need recent days

      const rows = await getAuthorDaysSince(message.from, since);
      if (!rows.length) {
        await message.reply('No data yet.');
        return;
      }

      // Build map: author_id -> Set(days)
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

        // if they haven't written today, streak can still be 0; we'll count back from today only
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

      const top = streaks.slice(0, 10).map((s, i) => `${i + 1}. ${s.name} — ${s.streak} day(s)`);
      await message.reply(`🔥 Streaks (consecutive days incl. today)\n` + top.join('\n'));
    } catch (e) {
      console.error('!streaks failed:', e);
      await message.reply('Failed to compute streaks (see server logs).');
    }
    return;
  }

  // !emojis  (top 3 emojis per user, last 30 days)
  if (body === '!emojis') {
    try {
      const now = Math.floor(Date.now() / 1000);
      const since = now - 30 * 86400;

      const rows = await getTextBodiesSince(message.from, since, 5000);
      if (!rows.length) {
        await message.reply('No text messages to analyze.');
        return;
      }

      // author_id -> Map(emoji -> count)
      const perAuthor = new Map();
      // author_id -> display
      const names = new Map();

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

        if (!names.has(aid)) names.set(aid, (r.author_name || '').trim());
      }

      // build personalities
      const personalities = [];
      for (const [aid, emMap] of perAuthor.entries()) {
        const total = Array.from(emMap.values()).reduce((a, b) => a + b, 0);
        if (total < 3) continue; // ignore tiny samples

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

  // !joke <word/phrase>  (adds watch phrase)
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

      // Clear name cache for sender just in case
      if (senderId) nameCache.delete(senderId);

      await message.reply(`🤣 Saved joke phrase:\n"${phrase}"\nUse !jokes to view the list.`);
    } catch (e) {
      console.error('!joke failed:', e);
      await message.reply('Failed to save joke (see server logs).');
    }
    return;
  }

  // ---------------------------
  // !jokes — list tracked jokes (LTR-stable)
  // ---------------------------
  if (body === '!jokes') {
    try {
      const jokes = await listJokes(message.from); // [{ phrase, total_count, last_ts }]

      if (!jokes.length) {
        await message.reply('🤣 No jokes saved yet.\nUse !joke <phrase> to add one.');
        return;
      }

      const LRM = '\u200E'; // force LTR on iOS
      const since30d = Math.floor(Date.now() / 1000) - 30 * 24 * 3600;

      const lines = [];
      for (const j of jokes) {
        const allTime = j.total_count || 0;
        const last30 =
        typeof j.count_30d === 'number'
          ? j.count_30d
          : await countPhraseOccurrences(message.from, j.phrase, since30d);

        // Format mirrors !ranks:
        // <count> • <phrase>
        // Example:
        // 12 • ben kirk
        lines.push(`${LRM}${allTime} • ${j.phrase}`);
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

      // iPhone-safe layout: count first
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
  // STORE MESSAGE
  // ---------------------------
  const ts = message.timestamp;
  const baseId = message.id._serialized;

  const authorId = getSenderId(message);
  const authorName = await resolveAuthorName(message);

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
