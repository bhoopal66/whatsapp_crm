# Team chat

Internal chat between the people of a workspace: channels, direct
messages, threads, mentions, reactions, pins, saved messages, files and
shared customer cards. Migration `087_internal_chat.sql`; the rules
below are enforced in Postgres (RLS and the `chat_*` functions) and
asserted by `supabase/ci/verify-internal-chat.sql` and
`verify-internal-chat-admin.sql`. Deal-room channels are created by
`088_deal_rooms.sql`.

## What it is

- **Internal only.** Customers never see it. No chat table has a
  WhatsApp or phone-number column and nothing in chat can reach a
  gateway: a message typed here never leaves the workspace.
- **A workspace is an account** (see `docs/workspaces.md`). Channels,
  messages and files belong to one workspace. Someone in several
  workspaces has separate channels and unread counts in each.
- **The screen** is `/chat`. A bank guest lands there and nowhere else.
- **A switch per workspace**: Settings → Team chat, stored as
  `accounts.internal_chat_enabled` (default on; an owner or admin
  changes it). Off stops new channels, messages, edits, reactions and
  members for everyone, and the composers are blocked. The history
  stays readable for owners and admins only.

## Channels

- **Team channel** (`team`): any staff member of the workspace can read
  it, join it and post in it. Posting, reacting or pinning in one you
  have not joined joins you. You can leave it. A bank guest cannot see
  it, and cannot be added.
- **Private channel** (`private`): members only. Nobody adds
  themselves: an existing member adds people, and only a channel admin
  adds staff. The creator is its first channel admin. The last
  (non-guest) admin cannot leave, be demoted or be removed.
- **Direct message** (`dm`): 2 to 8 people, the opener included, so a
  group DM is the same thing as a DM. A DM has no name; it is labelled
  by the other members. The same set of people always opens the same
  DM, and reopening one you left brings back only you. Nobody can be
  added to a DM later: open a new one. The last member cannot leave.
  Bank guests cannot be in a DM or open one.
- **Deal-room channel** (`deal_room`): every deal room has one (see
  _Deal rooms_ in `docs/meta-cloud-api.md`). Its messages are the
  room's staff-only **Team notes**; they never go to the WhatsApp group.
  It is created with the deal room, never from the New channel dialog,
  and its members are managed from the deal. Members who are staff
  read and post. A bank guest who is a member sees the channel and its
  members, never its messages.
- **Names.** The New channel dialog lowercases the name, turns each run
  of spaces into one hyphen, trims leading and trailing hyphens and
  cuts it to 80 characters. A topic is up to 250 characters. Among
  channels that are not archived, a team and a private channel cannot
  share a name, ignoring case. The database enforces the length and the
  uniqueness; the lowercase and hyphen shaping is the dialog's.
- **Who creates.** Owners, admins, team leaders, agents and viewers can
  create team and private channels. Bank guests cannot.
- **Managing a channel** (team and private only: DMs are fixed sets
  and deal rooms are managed from the deal). A channel admin, or a
  workspace owner or admin, can rename it, change or clear its topic,
  archive and unarchive it, and remove another member. In a private
  channel the owner or admin must be a member to do any of it; from
  outside they can only read it, through the audited admin read. Bank
  guests manage nothing. Each change is in the audit log.
- **Archived** channels are read-only: posting, editing, reacting,
  pinning, uploading, renaming and changing members are refused, and
  they leave the unread counts. Unarchiving fails if a live channel has
  taken the name meanwhile: rename that channel first (an archived one
  cannot be renamed).
- **Removing a member.** Nobody removes themselves (that is leaving),
  and the last (non-guest) channel admin cannot be removed. Someone
  removed from a private channel loses it at once, with their bell rows
  for it. Removed from a team channel, a staff member can still read it
  and rejoins by posting.
- **Mute** is each person's own switch, on any channel they are in,
  DMs and deal rooms included, bank guests too (see _Notifications_).
  It is in the menu of the channel header (the gear).

## Who sees what, by role

Chat uses the account role, with one mapping: a **viewer has an agent's
chat rights**, and a team leader is the chat's "supervisor".

- **Owner and admin.** Every team channel, and the private channels,
  DMs and deal rooms they are a member of. Any other private channel,
  DM or deal room only through the audited read (see _Admin
  oversight_). They can delete anyone's message in a channel they can
  read, and read the edit history of messages in channels they can read.
- **Team leader.** As an agent, plus: may add a bank guest to a private
  channel they belong to, and may start a private channel that includes
  one. A team leader's other chat rights do not differ from an agent's.
- **Agent and viewer.** Every team channel, and the private channels,
  DMs and deal rooms they belong to. They create channels and DMs, and
  add staff to team channels. In a private channel only a channel admin
  can add staff.
- **Bank guest.** Sees only the private channels they are a member of.
  Never a team channel or a DM, never a deal room's Team notes (the
  channel row and its members only), never contacts, the inbox or any
  conversation card. They post in private channels they belong to, and
  cannot create channels, open DMs, add members or change roles. The
  people list shows them only the people of their own channels.
- **Who can add a bank guest.** Only a member of a private channel who
  is an owner, admin or team leader of the workspace. Never into a team
  channel, a DM or a deal room (a deal room's guests come from the
  deal-room functions). An owner or admin who is not in the channel
  cannot add anyone to it.

## Messages

- **Size.** 1 to 8,000 characters. A message with files and no text
  carries the file names as its text.
- **Threads** have one level. A reply goes in its root's channel, and a
  reply to a reply is refused.
- **Mentions.** `@name` is stored as the person's id. Someone who
  cannot read the channel's messages is dropped silently. `@channel`
  and `@here` notify every member of the channel; `@here` does not
  check who is online. The composer offers them in team and private
  channels.
- **Reactions** toggle: the same emoji again removes it. The quick bar
  offers 👍 ✅ 👀 🙏 ❤️ 😂; the database accepts any emoji of 1 to 32
  characters.
- **Pins.** Anyone who can post in the channel can pin and unpin. A
  channel holds at most 100 pins; the 101st is refused.
- **Saved messages** are yours alone (`/chat/saved`). You can save any
  message you can read.
- **Unread counts** are per channel, counted from the later of your
  last read and the day you joined. They count top-level messages only,
  never your own or deleted ones. The mention count also includes
  thread replies. Marking a channel read also marks its chat
  notifications read. The workspace rail shows the totals of every
  workspace you belong to.
- **Edits** are the author's alone. The message shows as edited and the
  previous text goes to an append-only history that only owners and
  admins can read, for messages in channels they can read directly. The
  author and team leaders cannot read it.
- **Deletes** are the author's, or any workspace owner or admin's. The
  message stays as a deleted placeholder; its files, mentions, shared
  card and bell notifications are removed. The text it had stays in the
  edit history, readable by owners and admins, until the author is
  erased (see _Retention and erasure_).
- **Search** covers the messages you can read in the workspace. It
  matches whole words with no stemming, the same way for Arabic and
  English text, and Arabic-Indic digits (٠١٢٣) match ASCII digits.
  Best match first, 50 results by default and never more than 200.
  Deleted and erased messages are not searchable.
- **Automation posts.** Automations, the journey bot and the phone
  system post as `wacrm · automation`: no author, no mentions, no
  notifications. People can react to these posts, not edit or delete
  them.
- **Post to team chat (automation step `post_team_chat`).** An
  automation can post into one team or private channel of its own
  workspace; DMs and deal rooms are never offered, and the engine
  refuses them. The message is interpolated like Send message
  (`{{ message.text }}`, `{{ vars.* }}`), `**double asterisks**` show
  as bold, and a body over 8000 characters is clipped. Every run
  re-checks the saved channel: another workspace's channel, a DM or a
  deal room, an archived channel, or team chat being off fails that
  step in the automation's log, as any failing step does. A `<@uuid>`
  mention is neither rendered nor notified in a system post.

## Attachments

Files are stored in the private `chat-files` bucket, at
`account-<workspace>/channel-<channel>/<uuid>-<name>`. At most 10 files
per message, 25 MB each.

- **Upload** needs the right to post in that channel. The composer
  uploads first and shows no preview, then posts the message; the post
  fails if an object was not uploaded.
- **Download** needs the right to read the channel's messages **and** a
  live message carrying the file. A file is unreadable the moment its
  message is deleted or erased, before the object itself is removed.
- **Deleting a message** removes its files with the service role
  (`POST /api/chat/messages/[id]/delete`). The browser cannot remove
  them: the bucket has no delete policy.
- **The sweep** removes whatever that left behind: any object older
  than 24 hours that no live message carries (a deleted or erased
  message's file the delete did not reach, or an upload never posted).
  The 24 hours protect a file waiting in a composer; its chip does not
  survive a reload. `scheduleChatFileSweep` runs inside the automations
  cron (`GET /api/automations/cron`) at most once every 15 minutes per
  server process, up to 500 files a run, and only logs a failure: the
  next run tries again. It runs only when that cron is called.

## Sharing a customer conversation into a channel

**Share to team chat** on a conversation in the inbox posts a card.

- **Who may share.** Owners, admins, team leaders and agents get the
  button (viewers and bank guests do not). The sharer must be able to
  open that conversation in the inbox now, by the inbox's own rule, and
  the conversation must belong to the channel's workspace. The dialog
  offers open team channels (sharing joins you) and the private channels
  you belong to, not DMs or deal rooms.
- **Never into a channel with a bank guest** as a member, whether the
  member is a guest in the channel or holds the bank guest role now.
- **What the card holds**, frozen at share time: contact name, masked
  phone (`+971 XXXXXXX12`: country code and last two digits), company,
  chat tag, owner and the last two messages (200 characters each).
  The chat tag, status and last-message time are also read live.
- **Who sees it.** Access is checked again at every read. A reader who
  can open the conversation in the inbox now sees the card and can open
  the conversation. Anyone else sees a "no access" card: they learn that
  a card is there, and nothing of the customer. This holds for direct
  table reads too (RLS on `shared_conversations`).
- Deleting the message, or erasing its author, deletes the card.

## Notifications

Chat writes to the bell (`notifications`), with a body of the first 140
characters of the message and mentions shown as `@Name`.

| Type                | When                                                   |
| ------------------- | ------------------------------------------------------ |
| `chat_mention`      | you are @mentioned                                     |
| `chat_dm`           | a message in a DM you are in                           |
| `chat_thread_reply` | a reply in a thread you started or replied in          |
| `chat_broadcast`    | `@channel` or `@here` in a channel you are a member of |

- One notification per person per message, by that order of
  precedence. Never to the author, and never to someone who cannot read
  the channel's messages. Automation posts notify nobody.
- **Muted** channels and DMs ring only for a direct `@mention`: a muted
  member gets no `chat_broadcast`, `chat_thread_reply` or `chat_dm`. A
  muted channel still shows its unread count in the channel list
  (`chat_unread_counts` returns `muted`), dimmed and marked muted, but
  the workspace rail badge (`chat_workspace_badges`) and the main
  navigation's Team chat badge leave its plain unread out; its mentions
  still count.
- Editing a message rebuilds the bell text from the new text. Deleting
  it removes the bell rows. A failure to write a bell row never blocks
  the post.
- Each bell row carries the channel, message and thread root. It opens
  `/chat/<channel>`, with the thread open for a thread reply.

## Admin oversight

An owner or admin who is not a member of a private channel, DM or deal
room can read it, but must give a reason first.

- Settings → Team chat lists those channels (labels, members, last
  activity, never messages). Reading one calls `chat_admin_read_private`
  with a reason of at least 5 characters (the form allows 500).
- **The audit row is written first**, in the same call that returns
  the messages: `admin_read_private`, with the reader, the channel,
  the time and the reason. If it cannot be written, nothing is returned.
  Each read needs its own reason.
- The transcript shows deleted and erased messages as such, thread
  replies indented. It does not include the edit history.
- The log is Settings → Audit log (source Team chat), owners and admins
  only, and append-only. It also records `erase_person`, `add_members`
  and `set_member_role` (who added or promoted whom, and where), and
  since 091 `update_channel` (old and new name and topic),
  `archive_channel`, `unarchive_channel` and `remove_member` (whom, and
  their channel role).

## Retention and erasure

Nothing in chat is deleted automatically (decision D-4); no job removes
messages by age. The only automatic removal is the file sweep above.

An **owner** can erase one person's chat data in one workspace
(Settings → Team chat → erasure; the person may already be
deactivated).

- It needs a reason of at least 5 characters, and the form asks the
  owner to type the person's name (else their email, else `ERASE`).
- **Their messages** keep their place but their text becomes `[erased]`
  and they show as erased. Their files, shared cards and edit history
  (the only path that deletes it) are deleted, and the files are
  removed from storage.
- **Also deleted:** their reactions, saved messages and chat
  notifications; mentions in their messages and mentions of them;
  and the bell rows that are theirs or that quote them.
- **Untouched:** other people's messages, channel memberships, pins.
- **Audit:** one `erase_person` row with the person, the reason, the
  message count and the file count, written in the same transaction. It
  cannot be undone.
- A file that cannot be removed is logged and counted (`filesFailed`);
  the erasure stands and the sweep removes the file later.

## Endpoints worth knowing

Internal routes under the caller's session. Errors are `{ error }`,
with a `key` when a chat function refused. Statuses: 400 invalid, 403
forbidden (or chat off), 404 not found, 409 conflict, 500 otherwise.

- `GET /api/chat/admin/private-channels` (admin and up): the private
  channels, DMs and deal rooms the caller is not in, as labels, member
  names and counts, and last activity. No messages.
- `POST /api/chat/admin/erase-person` (owner): body `{ userId, reason }`
  → `{ messages, files, filesDeleted, filesFailed }`.
- `POST /api/chat/messages/[id]/delete` (any member; the database
  decides who may) → `{ files, filesDeleted, filesFailed }`.
- `GET /api/automations/cron` runs the file sweep, and
  `GET /api/audit?source=team_chat` backs the audit log.

Everything else (posting, editing, reacting, pinning, saving, search,
read marks, channels, DMs, members) is not a REST route. The browser
calls the `chat_*` functions directly with the user's session
(`src/lib/chat/api.ts`); each is `SECURITY DEFINER` and re-checks the
caller. The chat tables grant `SELECT` only, so those functions are the
only write path.

### Channel administration (091)

Called directly like the rest; each returns nothing.

| Function               | Arguments                                   | Notes                                                                                   |
| ---------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------- |
| `chat_update_channel`  | `p_channel uuid, p_name text, p_topic text` | `NULL` keeps a field, `''` clears the topic; name trimmed, 1–80 characters; topic ≤ 250 |
| `chat_archive_channel` | `p_channel uuid, p_archived boolean`        | asking for the state it is already in changes nothing                                   |
| `chat_remove_member`   | `p_channel uuid, p_user uuid`               | not yourself, not the last channel admin                                                |
| `chat_set_muted`       | `p_channel uuid, p_muted boolean`           | your own membership only; not audited                                                   |

Errors, as SQLSTATE and the `ChatError` code / key of
`src/lib/chat/errors.ts`: `42501` forbidden (`adminRequired`;
`notChannelMember`, also for an owner or admin outside a private
channel; `guestRestricted`; `archived`), `P0002` channel or member not
found, `22023` invalid (`lastAdmin`; removing yourself; a DM or deal
room; a `NULL` switch), `23514` a name or topic of the wrong length,
`23505` the name is taken (`duplicateName`, on unarchive too), `CH001`
internal chat is off.
