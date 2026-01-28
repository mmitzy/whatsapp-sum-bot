<div align="center">

# whatsapp-sum-bot

A WhatsApp companion bot that tracks group activity, surfaces fun stats, and can summarize recent chat using a Python/FastAPI backend.

</div>

---

## Overview

`whatsapp-sum-bot` runs alongside your WhatsApp Web session and quietly logs group conversations. It then exposes:

- Lightweight **activity stats** (top senders, message counts, streaks, ghosts).
- A simple **alias system** so people appear with friendly names instead of raw WhatsApp IDs.
- A small **economy + blackjack mini-game** based on participation.
- A bridge to a **Python summarization service** so you can later plug in LLM-based summaries of recent chat.

The bot is opinionated and designed for a small set of allowed groups and a small set of admins.

---

## Features

- **Group analytics**
	- `!ranks [N]` – top N senders by stored (non-command) messages.
	- `!count` – total stored messages in the group (excluding commands).
	- `!ghosts` – members who have been silent for 7+ days.
	- `!streaks` – consecutive-day activity streaks per user.
	- `!emojis` – “emoji personality” for each user based on last 30 days.

- **Summarization-ready history**
	- Messages (and basic media metadata) are stored in SQLite.
	- `!sum <interval>` – fetches messages from the last interval (e.g. `10m`, `1h30m`, max 24h).
	- Node bridges to Python (`main.py`) via `summary_bridge.js`, so you can plug in your own summarization logic.

- **Alias & identity management**
	- `!alias <name>` (in groups) – set your own alias.
	- Admin DM commands to manage aliases globally (`!alias <author_id> <name>`, `!aliases [N]`, `!who <alias>`).
	- Alias mapping always wins over WhatsApp names to avoid split stats when WhatsApp changes identifiers.

- **Economy & games**
	- `!balance` – show your current balance.
	- `!daily` – claim a daily reward (once every 24h).
	- `!give <alias> <amount>` – transfer balance to another user.
	- `!topbal` – leaderboard of richest users.
	- `!blackjack <bet>`, `!hit`, `!stand`, `!double` – play blackjack using your in-bot balance.

- **Admin tooling (DM only)**
	- `!myid` – show your raw WhatsApp ID (for config/admin use).
	- `!sample [N]` – sample of the last stored messages (default 5, max 20).
	- `!aliases [N]` – list recent aliases (default 20, max 100).
	- `!who <alias>` – resolve an alias to the current internal ID.

---

## Architecture

The project is split into two main parts:

- **Node.js WhatsApp bot** (folder `bot/`)
	- Uses `whatsapp-web.js` with `LocalAuth` for session management.
	- Persists messages and identities in SQLite (single DB file under `data/`).
	- Exposes rich group commands, DM-admin tools, and an internal summary bridge.

- **Python FastAPI service** (folder `src/` + `main.py`)
	- `src/app.py` exposes a simple `/webhook` endpoint and `/docs` via FastAPI.
	- `src/config.py` manages configuration (e.g. `VERIFY_TOKEN` from `.env`).
	- `main.py` is called from Node (via `summary_bridge.js`) to perform summarization logic.

SQLite schema and lightweight migrations live in `bot/schema.sql` and `bot/db.js`.

---

## Getting Started

### Prerequisites

- Node.js (LTS recommended).
- Python 3.10+.
- A WhatsApp account you can login with via WhatsApp Web.

### Clone & install

```bash
git clone <this-repo-url>
cd whatsapp-sum-bot

# Node bot deps
cd bot
npm install

# Python service deps
cd ..
pip install -r requirements.txt
```

### Configuration

#### Node bot (`bot/config.js` via environment variables)

You can override the defaults using environment variables:

- `ALLOWED_GROUP_IDS` – comma-separated group IDs the bot is allowed to run in.
- `ADMIN_DM_IDS` – comma-separated IDs that are allowed to use admin DM commands.
- `DATA_DIR` – directory for SQLite DBs (default: `../data`).
- `IDENTITIES_DB_FILE` – identities DB file name (default: `identities.sqlite`).
- `PY_SUMMARY_SCRIPT` – path to the Python entry script (default: `../main.py`).
- `MAX_SUMMARY_CHARS` – soft cap for messages passed into summarization.
- `CLIENT_ID` – client identifier for `LocalAuth` session.

#### Python service (`.env` + `src/config.py`)

Create a `.env` file at the project root:

```env
VERIFY_TOKEN=some-secret-token
```

`Settings` in `src/config.py` loads this value and is used when verifying webhooks.

---

## Running the bot

### 1. Start the Python service (optional but recommended)

If you use the webhook/summarization side, run the FastAPI app (for example with `uvicorn`):

```bash
uvicorn src.app:app --reload
```

### 2. Start the WhatsApp bot

```bash
cd bot
node index.js
```

On first run, you will see a QR code in the terminal. Scan it with WhatsApp on your phone to link the session.

The bot will then join any **allowed groups** and start logging messages and responding to commands.

---

## Commands Reference

The single source of truth for commands is `bot/config.js` (`COMMANDS` array). A human-readable summary:

### Group commands

- `!help` – DM yourself the full list of commands.
- `!alias <name>` – set your display alias.
- `!ranks [N]` – top N senders (default 10, max 30).
- `!count` – number of stored messages in this group.
- `!sum <interval>` – messages from the last interval (e.g. `10m`, `1h30m`, `2h`).
- `!ghosts` – users who have been quiet for at least 7 days.
- `!quote <alias>` – random quote from a user with this alias.
- `!streaks` – consecutive active days per user.
- `!emojis` – emoji profile for each user.
- `!joke <phrase>` – save a phrase as an inside joke tracker.
- `!jokes` – list all joke phrases and usage counts.

#### Economy & blackjack

- `!balance` – show your current balance.
- `!daily` – claim daily reward.
- `!give <alias> <amount>` – transfer balance to another user.
- `!topbal` – show top balances.
- `!blackjack <bet>` – start a blackjack game.
- `!hit` – draw another card.
- `!stand` – end your turn.
- `!double` – double your bet, draw once, then stand.

### DM admin-only commands

- `!myid` – show your WhatsApp ID.
- `!sample [N]` – sample of last stored entries (default 5, max 20).
- `!aliases [N]` – list last N aliases (default 20, max 100).
- `!who <alias>` – show the current internal ID for an alias.
- `!alias <author_id> <name>` – force-set alias for an internal ID and relabel history.
- `!give <alias> <amount>` – admin-only minting of balance.

Commands are **not** stored as message content in the DB, so analytics focus on real chat, not bot interaction.

---

## Data & Storage

- Uses SQLite under `data/`.
- Single DB file (configurable via `DB_FILE` env var) for messages.
- Identities live in `identities` table with alias labels and balances.
- Lightweight migrations ensure new columns (e.g. `balance`, `last_daily_ts`) are added on startup.

Messages are stored with:

- `chat_id`, `msg_id`, timestamp, `author_id`, `author_name`.
- `body`, `entry_type` (e.g. `text`), and basic media flags/metadata.

Commands (messages starting with `!`) are excluded from analytics queries.

---

## Version 1.0 – What’s Included

- A friendly WhatsApp companion for approved groups that quietly listens and reacts without getting in the way.
- Lightweight tracking of everyday conversations so you can see who talks the most and browse recent activity on demand.
- Simple group commands for checking that the bot is alive, playful replies, and ranking the most active senders.
- A personal alias system so people can appear under clean, human-readable names instead of raw WhatsApp IDs.
- Admin-only DM tools to sample recent messages, view message counts, and manage aliases without spamming the group.
- Smarter identity handling that keeps stats and rankings stable even when WhatsApp changes internal identifiers.

---

## Deleting Cache Folders
```bash
# Make sure node isn't running (CTRL + C)
Remove-Item -Recurse -Force .wwebjs_auth -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force .wwebjs_cache -ErrorAction SilentlyContinue
```

## Creating New Cache Folders W/O Deleting
```bash
# Make sure node isn't running (CTRL + C)
Rename-Item .wwebjs_auth .wwebjs_auth.bak -ErrorAction SilentlyContinue
Rename-Item .wwebjs_cache .wwebjs_cache.bak -ErrorAction SilentlyContinue
```

## Reinstalling Bot Dependencies
```bash
# Make sure node isn't running (CTRL + C)
Remove-Item -Recurse -Force .\node_modules -ErrorAction SilentlyContinue
Remove-Item -Force .\package-lock.json -ErrorAction SilentlyContinue
```

## Future Ideas

- Plug in an LLM-based summarizer for `!sum` (using OpenAI/Azure/Open-source models).
- Richer dashboards or exported reports from the SQLite data.
- More games and achievements based on streaks and participation.
- Per-group configuration of which features are enabled.

---

## Disclaimer

This project is intended for personal/experimental use. Make sure you understand WhatsApp’s terms of service and respect privacy and consent when logging or analyzing group conversations.