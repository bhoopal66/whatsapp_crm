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
- **Deleting is immediate for everyone.** The note disappears at once
  from every open copy of the chat, not only the author's, and its
  text and mentions are gone from the database at once: the row is kept
  only as an empty marker (`deleted_at`, migration 332) so open chats
  hear about the delete. A deleted note cannot be edited or restored,
  and it is never shown, counted or exported.

## @mentions

Type `@` in a note to name a teammate. Only live staff of the workspace
who can see this chat are offered, never yourself, and at most **20
people** a note. Each person named rings one **"mentioned you in a
note"** bell, which opens the chat.

- Someone who cannot see the chat is never rung, even if their id is
  sent: the database keeps only people who may be rung, and that is
  exactly the people who can open the chat (`conversation_note_user_can_see`,
  the same rule as the chat list). For a company chat: owners and
  admins, the chat's owner and assignee, their team leaders, and, for
  an older company chat that sits on someone's personal number, that
  number's owner and their team leader (migration 260 put this back
  after 256 had removed it).
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

Requires migrations `241_conversation_notes.sql` (after 229) and
`332_note_tombstones.sql` (after 241; apply in order, once). Verify with
`supabase/ci/verify-conversation-notes.sql` and
`supabase/ci/verify-note-tombstones.sql`.
