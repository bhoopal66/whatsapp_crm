# Chat notes

A note is a line the team writes inside a WhatsApp chat for each other:
"called him, he wants the business account", "@Sara can you take this
one?". It sits in the thread between the messages, with its author and
time, and is **never sent to the customer**.

## Who can do what

- **Read:** whoever can see the chat. A note is visible exactly when its
  chat is: the same rules as the inbox (owners and admins everything,
  team leaders their team's chats, agents their own and assigned ones,
  personal chats their owner, the owner's leader and admins, and a
  coordinator a chat shared with them).
- **Write:** agents and up who can see the chat, as themselves. Viewers
  read the notes of chats they can see and write nothing; bank guests
  get nothing.
- **Edit and delete:** only the note's author. Only the text can change;
  an edited note shows that it was edited. Admins cannot edit or delete
  someone else's note.

## @mentions

Type `@` in a note to name a teammate. Only live staff of the workspace
who can see this chat are offered, never yourself, and at most **20
people** a note. Each person named rings one **"mentioned you in a
note"** bell, which opens the chat.

- Someone who cannot see the chat is never rung, even if their id is
  sent: the database keeps only people who may be rung. For a company
  chat that is owners and admins, the chat's owner and assignee, and
  their team leaders (`conversation_note_company_chat_visible`, 256): a
  personal number's owner is never rung about a company chat that
  happens to sit on their number.
- Editing a note never rings again. It updates the text quoted in the
  bells already rung (and in push notifications still waiting to go
  out). Deleting a note removes its bells and their push notifications.
- The note shows who was rung. That list says who can see the chat,
  which the mention picker already shows any writer, so it reveals
  nothing new inside the workspace.

## Where data lives

One table, `conversation_notes`. Notes are deliberately **not
messages**: they never reach the AI's context, unread counts, chat
previews, dashboards, outbound webhooks, the public API or the MCP
server.

## Privacy

Notes are about a customer, so a PDPL export of the customer includes
their notes and an erase deletes them (registered through
`privacy_extensions`). Deleting a chat or its contact deletes its notes.

## Defaults

Nothing to switch on: notes are available to every workspace once the
migration is applied.

Requires migration `241_conversation_notes.sql` (after 229). Verify with
`supabase/ci/verify-conversation-notes.sql`.
