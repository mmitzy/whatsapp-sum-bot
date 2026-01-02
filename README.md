# Whatsapp-sum-bot
A whatsapp bot used for chat summarizations 

when testing -
remove previous bot if needed using:
run it using: node index.js

Notes:

Commands are not stored in the DB

Media messages are stored separately from text

Group must be in ALLOWED_GROUP_IDS

type !help for the list of commands

internal behavior: 

One SQLite DB for all messages

One global identities.sqlite

Alias mapping always wins over WhatsApp names

Multiple LIDs → same name = OK

No history rewrite needed beyond author_name
