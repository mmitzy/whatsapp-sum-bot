# Whatsapp-sum-bot
A whatsapp bot used for chat summarizations 

when testing -
remove previous bot if needed using:
run it using: node index.js

group commands:

!ping - Test command → replies pong
!ben - Replies kirk!
!ranks - Top 10 senders by stored messages
!ranks N - Top N senders (max 30)
!alias Your Name	Alias your own WhatsApp ID
!sum <interval> - Sums messages sent on the last <interval> using a local LLM. Currently just prints them

Notes:

Commands are not stored in the DB

Media messages are stored separately from text

Group must be in ALLOWED_GROUP_IDS


dm admin only commands: 

!who <alias> - gives you a lid of an alias. Used for first alias initialization of another user
!sample	Show - last 5 stored entries
!sample N - Show last N stored entries (max 20)
!count - Number of stored messages (excluding commands)
!myid	Shows your WhatsApp ID
!alias <lid> Name	Alias a specific WhatsApp ID
!aliases	Show last 20 aliases
!aliases N	Show last N aliases (max 100)

Notes:

Works only in DM

Automatically updates past messages in all group DBs

Prevents ranking splits when WhatsApp changes LIDs



internal behavior: 

One SQLite DB per group

One global identities.sqlite

Alias mapping always wins over WhatsApp names

Multiple LIDs → same name = OK

No history rewrite needed beyond author_name