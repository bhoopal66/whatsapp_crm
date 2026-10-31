# Team chat

Internal chat between the people of a workspace: channels, direct
messages, threads, mentions, reactions, pins, saved messages, files and
shared customer cards. Migration `087_internal_chat.sql`; the rules
below are enforced in Postgres (RLS and the `chat_*` functions) and
asserted by `supabase/ci/verify-internal-chat.sql` and
`verify-internal-chat-admin.sql`. Deal-room channels are created by
`088_deal_rooms.sql`. Migrations 156 to 160 (voice notes, quote
replies, forwarding, permissions, the sensitive-data guard, restricted
team channels, moderation and export) are described in the sections
that follow; apply them in order, as a superuser or BYPASSRLS role
(157 to 160 refuse otherwise), before the app build that uses them.
Their defaults change nothing until an owner or admin saves rules.

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
  create team and private channels. Bank guests cannot. Since 157 an
  owner or admin can take that away per role (see _Permissions_).
- **Posting rules** (157; team and private channels only, DMs and deal
  rooms are fixed to _everyone_). Three switches per channel, each
  _everyone_ or _admins_: **posting** (top-level messages),
  **thread replies** and **@channel / @here**. "Admins" means the
  channel's admins and the workspace's owners and admins; a bank guest
  never counts. A channel with posting set to admins is an
  **announcement channel**: everyone can read and react, and can reply
  in threads unless thread replies are limited too. A channel admin,
  or a workspace owner or admin, changes them from the gear menu
  (**Posting permissions…**, `chat_set_channel_policy`); the header
  shows an _Announcements_ or _Restricted_ badge. Typing and uploads
  follow the rules: an upload is allowed if you may post top-level or
  reply. A save that changes nothing writes no audit row.
- **Restricted team channels** (159). A team channel can be limited to
  a minimum role (viewer, agent, team leader, admin) and, optionally,
  to the members and leaders of chosen teams (**Who can see this
  channel…**, `chat_set_channel_audience`). Owners and admins always
  see it; anyone else needs a raw role at or above the minimum (viewer
  < agent < team leader < admin < owner) **and**, when teams are
  listed, to belong to one of them (member or leader). Membership is
  no override: a member who no longer qualifies loses the channel, the
  rows stay, and it returns when the rule is widened. The default is
  all staff, so nothing changes until someone saves a rule. A channel
  admin who is not an owner or admin cannot save a rule that hides the
  channel from themselves (`22023`, "would hide this channel from
  you"). Bells created before a restriction are kept.
  **Managing** a team channel (rename, topic, archive, members, roles,
  posting rules, audience, timeouts) also needs the manager to be
  inside its audience unless they are a workspace owner or admin
  (`42501`, "outside this channel's audience"). A channel with
  `audience_team_restricted` stays closed when every listed team has
  been deleted: only owners and admins see it, and the dialog and the
  header say its teams were deleted. Saving it with no teams reopens it
  to the minimum role.
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
  and the last (non-guest) channel admin cannot be removed. Since 165,
  changing the role of someone who is a channel admin (in a team or a
  private channel) needs a workspace owner or admin, unless it is your
  own role (`42501`), so one channel admin cannot demote the others and
  keep the channel; promoting members still works for any channel
  admin, and a bank guest is never made a channel admin (`22023`). Someone
  removed from a private channel loses it at once, with their bell rows
  for it. Removed from a team channel, a staff member can still read it
  and rejoins by posting.
- **Mute** is each person's own switch, on any channel they are in,
  DMs and deal rooms included, bank guests too (see _Notifications_).
  It is in the menu of the channel header (the gear).

## Who sees what, by role

Chat uses the account role, with one mapping: a **viewer has an agent's
chat rights**, and a team leader is the chat's "supervisor". Since 157
an owner or admin can narrow what each role may do (see _Permissions_);
the rights below are the defaults.

**Audience (159).** A team channel with an audience rule (see
_Channels_) is read only by the people who pass it. One clause in
`chat_user_can_read_channel` applies it to every read path: RLS,
storage, unread counts and badges, search, cards, mentions and bells,
push, the guest check, and reactions, pins, saves, plays and mute.
Writes are refused by triggers on member inserts, user messages and
typing (`42501`, "chat: outside this channel's audience").
**Announcement channels** (posting limited to admins) are read by their
usual audience; only posting is limited.

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

## Direct message rules (migration 143)

An owner or admin decides, per workspace, which roles may share a DM
(Settings → Team chat → Direct messages). Nothing is restricted until
someone saves rules: a workspace with no rules keeps every DM open.

- **Classes.** Admin, team leader, coordinator, agent and viewer. A
  person's classes are their account role plus *coordinator* when they
  are a live agent or team leader holding a coordinator bank.
- **Scopes.** Each pair of classes (agent ↔ agent, agent ↔ team leader,
  …) is *not allowed*, *same team only* or *everyone*. *Same team*
  means members of one team, or a team's leader and its member. A pair
  with no saved rule is *everyone*.
- **Most permissive wins.** Someone with two classes is reachable if
  either class is: an agent who is also a coordinator can be messaged
  wherever coordinators can.
- **Owners are exempt.** An owner can always message, and be messaged
  by, anyone.
- **Group DMs.** Opening a DM needs every pair in it to be allowed.
  Afterwards each member sees the DM only while they may message
  everyone else in it.
- **Blocked DMs are hidden, not deleted.** A DM that a rule now forbids
  disappears for the members it forbids (list, messages, unread badges,
  search, bells, push) and refuses new messages. Relaxing the rule shows
  it again, and an owner or admin can still open it through the audited
  read (see _Admin oversight_).
- **Enforcement is in the database.** `chat_open_dm`,
  `chat_assert_can_write` and `chat_user_can_read_channel` apply the
  rules; the New message picker lists only the people
  `chat_dm_peers` allows. Rules are written only by `chat_set_dm_rules`
  (live owner or admin), which replaces the whole set and stores only
  the restricting pairs. Changes are stamped with `updated_by` /
  `updated_at`, not written to the chat audit log.

## Permissions (migration 157)

An owner or admin decides, per workspace, what each role may do in
chat (Settings → Team chat → Permissions). Nothing is restricted until
someone saves: a workspace with no rows keeps today's rights.

- **A row means denied.** `chat_role_permissions` lists the denied
  (role class, capability) pairs. The classes are admin, team leader,
  agent, viewer and bank guest, taken from the raw account role (a
  viewer and a team leader are separate here, unlike the default
  mapping above). **Owners are exempt.**
- **Twelve capabilities:** create team channel, create private channel,
  open group DM (3 or more people including the opener, also when
  reopening one), mention everyone (@channel and @here), upload files,
  send voice, pin messages (pin and unpin), forward messages, share
  cards (conversation and call cards), add members (not the initial
  members of a new channel), edit own, delete own. A bank guest can be
  denied only upload files, send voice, pin messages, forward messages,
  mention everyone, edit own and delete own.
- **Presets.** The page has **Use recommended** (viewer: create
  channels, group DMs, @channel, pin, add members; agent: @channel;
  guest: forward, @channel) and **Allow everything**. The list lives in
  `src/lib/chat/permissions.ts` (`CHAT_CAPABILITIES`,
  `RECOMMENDED_DENIED`); a test pins the capability list to the CHECK
  on the table.
- **Message rules.** `chat_workspace_settings` holds the edit and
  delete windows, 1 to 10,080 minutes or none, for an author's own
  edit and delete. Owners and admins are exempt from the windows
  (admins still need _edit own_ / _delete own_ if their class is
  denied). The buttons are hidden after the window; the database
  refuses (`42501`, "the edit/delete window has passed (N minutes)").
- **Channel rules** are per channel (see _Channels_).
- **Refusals** are `42501`: "chat: your role may not …", "only channel
  admins can post here", "only channel admins can reply in threads
  here", "you may not notify everyone".
- **The UI applies the same rules**: buttons are hidden,
  announcement-channel and thread-reply blocks explain themselves,
  @channel is offered only when allowed, and the edit and delete
  actions vanish after the windows. The database decides; the UI only
  informs.
- **Reads.** The matrix is readable by live non-guest members, the
  settings by any live member including guests.
  `chat_my_permissions(p_ws)` returns the caller's class, the twelve
  capabilities, both windows, whether the windows apply and the
  sensitive-data setting.
- **Writes.** `chat_set_permissions(p_ws, p_denied)` replaces the whole
  set; `chat_set_workspace_settings(p_ws, p_edit, p_delete)`;
  `chat_set_channel_policy`. Owner or admin (a channel admin for the
  channel policy). Audited as `set_permissions`, `update_settings` and
  `update_policy`.

## Sensitive-data guard (migration 158)

Settings → Team chat → Sensitive data. An owner or admin picks a mode
(`off`, `warn`, `block`; default off) and a scope (`guests`, `all`;
default guests) with `chat_set_sensitive_guard(p_ws, p_mode, p_scope)`,
audited as `update_sensitive_guard` (old and new).

- **What it detects:** an Emirates ID, a card number (13 to 19 digits,
  Luhn-valid, after phone numbers are masked) and an IBAN of a known
  country with a valid checksum. `<@uuid>` mention tokens are removed
  before the scan, since a uuid's digits could read as a card.
  Attachment contents are not scanned.
- **warn** is a client-side warning dialog before sending (the
  composer and the edit box); the database allows the message. When the
  channel's bank-guest status cannot be learned, the warning is shown
  anyway (it fails toward the warning). The client remembers a
  channel's guest status for at most 60 seconds.
- **block** is a trigger on `internal_messages` (before insert or an
  update of the body; user posts only, live rows). With scope _all_ the
  message is refused anywhere; with _guests_ it is refused in team and
  private channels that have a bank guest as a member. Deal rooms are
  exempt (Team notes are staff-only). Owners are not exempt. It covers
  posts, forwards and edits, not system posts, deletes or erasures. The
  refusal is `42501`, "… contains sensitive data (card, …) and this
  workspace blocks it in channels with bank guests / in team chat"; the
  UI shows a block message. Under scope _guests_ the rule is judged
  when a message is posted: a guest added to the channel later can read
  the messages posted before.
- **Two copies of the detector.** `chat_sensitive_kinds` (SQL) mirrors
  `src/lib/kb/sensitive.ts` and `redact.ts`. Change one, change both;
  the shared corpus in `verify-chat-sensitive-guard.sql` and
  `src/lib/kb/sensitive-corpus.test.ts` pins their agreement.

## Messages

- **Size.** 1 to 8,000 characters. A message with files and no text
  carries the file names as its text.
- **Formatting.** `*bold*`, `_italic_`, `~strike~`, `` `code` ``,
  fenced code blocks, `>` quotes, lists and `http(s)` links (opened
  with `rel="noopener noreferrer nofollow"`). The **Aa** toolbar and
  Ctrl/Cmd+B, I, Shift+X and E apply it; previews strip the markers.
  The emoji picker is in the composer, and **Add reaction…** accepts
  any emoji.
- **Voice notes** (156). The mic button in the composer (and in
  threads) records Ogg/Opus with a live level meter, up to **15
  minutes** (`CHAT_VOICE_MAX_SECONDS`); the take is reviewed before
  sending, and uploaded only on Send, so a discarded take uploads
  nothing. A voice note is an attachment of kind `voice` (1 to
  1,200,000 ms, `audio/*`) and the message's **only** attachment. Its
  text is "🎤 Voice message (m:ss)", kept for search and bells and
  hidden in the row unless the message is edited. Voice notes and any
  audio file play in the same WhatsApp-style player (1×, 1.5×, 2×,
  waveform, download). Sending one needs the _send voice_ capability.
  There is no transcription.
- **Played by** (156). Opening a voice note records a play
  (`chat_mark_voice_played`, table `chat_voice_plays`, readable by
  whoever can read the message). The author sees who played it, under
  the same receipts rule as _Seen by_; the author's own plays are not
  recorded.
- **Quote replies** (156). **Reply** (hover, menu or right-click) shows
  a _Replying to_ bar (Esc or X cancels) and posts with
  `reply_to_id`. The target must be a live message of the same channel
  and the same thread scope: a top-level message quotes a top-level
  one; a reply in thread R quotes R or another reply of R. It cannot
  be changed afterwards (`42501`, "structural columns are immutable").
  The quote block jumps to the original. A quote adds no notification
  of its own.
  A quote, and the _Replying to_ bar, follow later edits, moderator
  removals and erasures of the quoted message (from the workspace's
  realtime message events). A quoted message that cannot be read is
  retried after 1, 3 and 9 seconds, then shown as unavailable.
- **Forwarding** (156). **Forward** copies a message you can read to up
  to **5** targets: team channels (posting joins you), and the private
  channels and DMs you are in. Deal rooms, and the channel the message
  is in, are not offered; a bank-guest badge marks channels with one.
  The browser first copies the attachments into the target's storage
  prefix, then calls `chat_forward_message(p_message, p_channel,
  p_attachments)`. The copy is a top-level message with
  `meta.forwarded` (source message, author, kind, time); mentions
  become plain `@Name` and ping nobody; a shared card is **not**
  carried (the dialog says so). The source must be readable and live
  (deleted: `22023`; missing or unreadable: `P0002`) and in the same
  workspace (`42501`). Needs _forward messages_; `chat_forward_message`
  itself asks for no upload right, so each attachment must match a
  distinct attachment of the source on name, type, size, kind and
  duration (no more of them than the source has; else `22023`, "copies
  of the source message"). Since 165 the stored object is checked too,
  not only the fields the browser sends: each copy's storage object must
  have the source file's size and the same stored mimetype as the source
  file's object, and an object with no metadata is refused (`22023`), so
  someone with _send voice_ but not _upload files_ cannot upload an
  arbitrary file and pass it off as a copy. Copying the files is a storage upload,
  though, which the storage policy allows only with _upload files_ or
  _send voice_: a message **with files** is therefore forwardable only by
  someone who also holds one of those, and the app offers Forward on it
  only then (a text-only message needs _forward messages_ alone). Every
  attachment, posted or forwarded, needs a storage object no other
  attachment row has (`22023`, "already belongs to a message"). The
  sensitive-data guard applies to the copy.
- **Typing** (156). `chat_set_typing(p_channel, p_thread_root,
  p_typing)` marks the caller as typing, only where they could post
  (`chat_assert_can_write(p_channel, false)`), never joins anyone to a
  channel, and is throttled in the database (a row under 2 seconds old
  in the same thread is left alone, even a stopped one, so stop +
  start cannot bypass it). Stopping is never refused and marks the row
  `stopped = true` instead of deleting it, because realtime does not
  RLS-filter DELETE events; `activeTypers` ignores stopped rows. Rows
  are readable by the channel's readers and delivered by realtime. The
  database and `src/lib/chat/typing.ts` implement it. The UI shows
  "Sara is typing…", "Sara and Ali are typing…" or "Several people are
  typing…" above the channel composer and above the thread composer.
- **Seen by** (156). Only in DMs and team or private channels of at
  most 20 members, never deal rooms. Under your last top-level
  message: _Seen_ or _Sent_ in a 1:1 DM, _Seen by N_ with a list in a
  group, from each member's `last_read_at` once they could read it. A
  **New messages** divider is frozen per visit; marking read also
  happens when the tab becomes visible.
- **Threads** have one level. A reply goes in its root's channel, and a
  reply to a reply is refused.
- **Mentions.** `@name` is stored as the person's id. Someone who
  cannot read the channel's messages is dropped silently. `@channel`
  and `@here` notify every member of the channel; `@here` does not
  check who is online. The composer offers them in team and private
  channels, and only to someone allowed to: the _mention everyone_
  capability and the channel's @channel rule (`42501`, "you may not
  notify everyone").
- **Reactions** toggle: the same emoji again removes it. The quick bar
  offers 👍 ✅ 👀 🙏 ❤️ 😂; the database accepts any emoji of 1 to 32
  characters.
- **Pins.** Anyone who can post in the channel (and holds _pin
  messages_) can pin and unpin. A
  channel holds at most 100 pins; the 101st is refused.
- **Saved messages** are yours alone (`/chat/saved`). You can save any
  message you can read.
- **Unread counts** are per channel, counted from the later of your
  last read and the day you joined. They count top-level messages only,
  never your own or deleted ones. The mention count also includes
  thread replies. Marking a channel read also marks its chat
  notifications read. Settings → Workspaces shows the totals of
  every workspace you belong to.
- **Edits** are the author's alone. The message shows as edited and the
  previous text goes to an append-only history that only owners and
  admins can read, for messages in channels they can read directly. The
  author and team leaders cannot read it. Needs _edit own_ and the
  workspace's edit window (see _Permissions_): after it the button is
  hidden and the database refuses (`42501`, "the edit window has passed
  (N minutes)"). Owners and admins are exempt from the window.
- **Deletes** are the author's, or any workspace owner or admin's
  (since 160 also a channel admin's, in team and private channels).
  The message stays as a deleted placeholder; its files, mentions,
  shared card and bell notifications are removed. The text it had stays
  in the edit history, readable by owners and admins, until the author
  is erased (see _Retention and erasure_). Deleting your own needs
  _delete own_ and the delete window. Deleting someone else's message is
  **moderation**: it needs a reason (see _Admin oversight_), and the
  placeholder reads "Removed by an admin" when `deleted_by` is not the
  author.
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
  (`{{ message.text }}`, `{{ vars.* }}`), `**double asterisks**` in
  the automation's own text show as bold, and a body over 8000
  characters is clipped. Filled-in values are defused: each `*`
  becomes `∗`, and the `@` of `<@`, `@channel` and `@here` becomes
  `＠`, so a customer's words cannot bold part of the post or show as
  a mention.
  - _Who reads it._ Everyone who can read the channel, which is not
    the conversation's audience: a team channel is read by every staff
    member of the workspace, viewers included, so `{{ message.text }}`
    there reaches people whom the conversation rules (migrations
    042, 043 and 072) would never show that chat to. Pick the channel
    with that in mind.
  - _Bank guests._ A channel with a bank guest (a member with the guest
    role, or one whose role in the workspace is `bank_guest`: the test
    087 applies before a conversation card is shared) is left out of
    the picker and refused on every run (`chat_channels_with_guests`, migration 102),
    so adding a guest stops the step. Posts made before the guest
    joined stay in the channel's history, which the guest can read.
  - _Failures._ Every run re-checks the saved channel: another
    workspace's channel, a DM or a deal room, an archived channel, a
    bank guest, or team chat being off fails that step in the
    automation's log, as any failing step does.
  - _Trail._ Each post's `meta` holds `automation_id`,
    `conversation_id` and `contact_id` (null when the run had none),
    so the copies of a customer's words can be found for an audit or
    an erasure request.
  - _Mentions._ A system post notifies nobody. The channel shows a
    `<@uuid>`, `@channel` or `@here` in the automation's own text as
    plain text; search results show it as a chip.

## Attachments

Files are stored in the private `chat-files` bucket, at
`account-<workspace>/channel-<channel>/<uuid>-<name>`. At most 10 files
per message, 25 MB each.

- **Voice notes** are attachments of kind `voice`. The player mints a
  signed URL near the viewport and mints a new one if an old URL fails.
- **Files panel** (156). Per channel, with tabs All, Images, Voice,
  Video and Files, newest first, live messages only; a click jumps to
  the message (`chat_channel_files(p_channel, p_kind, p_before,
  p_limit)`, kind `voice`, `image`, `video` or `file`, limit 1 to 200;
  it runs with the caller's rights, so RLS decides what is listed).
- **Viewing.** Images open in a full-screen viewer (arrows, download),
  video plays inline, and other files show a type icon.
- **Upload** needs the right to post in that channel (and, since 157,
  _upload files_; a restricted member, below, cannot). The composer
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

## Sharing a phone call into a channel

Migration `103_chat_call_cards.sql`. **Share to chat** on a call (the
Calls screen, the customer page's call entries, and the call wrap-up's
"share a call card" box) posts a card of the call to a team channel, a
private channel or a deal room's Team notes. Never to the customer, the
WhatsApp chat or a deal room's WhatsApp group.

- **Who may share.** As for conversations (no viewers, no bank guests),
  and only a call that was not erased. The database checks that the
  sharer can see the call now (the Calls screen's rule) and that it is
  in the channel's workspace (`chat_share_call`).
- **No bank guests.** A call cannot be shared into a channel where a
  bank guest reads the messages (the same guest test as for
  conversations). A deal room is allowed: its Team notes are
  staff-only, so its guests never read the card. DMs are not offered
  (they never hold a guest).
- **What the card shows**, read from the call each time (no snapshot):
  direction, the customer's name (or masked number) linking to the
  customer page, the agent, when, duration, outcome and a note excerpt.
  The post's own text is the sharer's comment, or "Shared a call", and
  never names the customer.
- **Who sees the details.** Only someone who can see the call now;
  anyone else sees a "no access" card. Once the call's record is erased
  (`pbx_erase_contact_calls`), the card says only that it was erased.
  Direct reads of `shared_calls` follow the same rule.
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

- A **forwarded** message rings only the members of a DM it is
  forwarded into (`chat_dm`); forwarding into a channel pings nobody,
  and mentions in it are plain text. A **quote reply** adds no bell of
  its own.
- One notification per person per message, by that order of
  precedence. Never to the author, and never to someone who cannot read
  the channel's messages. Automation posts notify nobody.
- **Muted** channels and DMs ring only for a direct `@mention`: a muted
  member gets no `chat_broadcast`, `chat_thread_reply` or `chat_dm`. A
  muted channel still shows its unread count in the channel list
  (`chat_unread_counts` returns `muted`), dimmed and marked muted, but
  the Settings → Workspaces badge (`chat_workspace_badges`) and the main
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
- **Moderation** (160). A workspace owner or admin, or a channel admin
  of a team or private channel (never a DM), can delete another
  person's message with `chat_delete_message(p_message, p_reason)`. A
  reason is required (`22023`, "a reason is required"): at least 5
  characters that are not whitespace, and at most 500, after trimming
  spaces, tabs, CR and LF. The audit row `moderate_delete` records message,
  author and reason. The UI asks for it (**Remove message…**); a
  refused removal keeps the dialog open with the reason typed. A
  system post can be removed only by a workspace owner or admin, also
  with a reason. Own deletes need no reason and set `deleted_by` to the
  author; `deleted_by` is set only together with `deleted_at` and is
  immutable.
- **Timeouts** (160). **Restrict posting…** in the members panel calls
  `chat_restrict_member(p_channel, p_user, p_until, p_reason)`: a team
  or private channel, not yourself, not a workspace owner or admin; a
  channel admin may restrict only non-admin members; the end is in the
  future and at most 30 days away (the dialog offers 1 hour to 30
  days; the 30-day option ends 5 minutes short of it); a reason is
  required to set one, and `NULL` for `p_until` lifts it (**Lift
  restriction**).
  A timeout is a row of `chat_channel_restrictions (channel_id,
  user_id, account_id, until, reason, set_by, set_at)`, not a column of
  the membership: leaving and rejoining a channel does not clear it,
  and restricting a non-member of a team channel does not join them.
  Lifting is an UPDATE (`until = now()`), never a delete, because
  realtime does not RLS-filter DELETE events. Workspace owners and
  admins are never blocked by one. The rows are readable by the
  restricted person and by those who can manage the channel
  (`chat_can_manage_channel`). While it lasts every write is refused in
  that channel (`42501`, "restricted from posting": posts, replies,
  reactions, pins, typing, uploads, edits, call cards); reading is
  unaffected. It is enforced in `chat_assert_can_write`. The composer
  then reads "You can't post here until …" and the members panel shows
  a "Restricted until" badge, both live.
- **Export** (160). Settings → Team chat → **Export a channel** (owner
  or admin) downloads a CSV (UTF-8 BOM, so Excel reads Arabic). Any
  channel kind, including ones the admin is not in, and even with team
  chat switched off. It needs a reason and a date range, returns at
  most **10,000** messages ordered by time and id, with mentions
  rendered, deleted messages as an empty body plus `deleted_by`, erased
  ones as `[erased]`. A cell that starts with `=`, `+`, `-`, `@`, a tab
  or CR is prefixed with `'` so a spreadsheet does not run it as a
  formula. `chat_export_channel(p_channel, p_from, p_to,
  p_reason)` writes the audit row `export_channel` (range, reason,
  count, whether truncated) **first**, in the same call.
- The log is Settings → Audit log (source Team chat), owners and admins
  only, and append-only. It also records `erase_person`, `add_members`
  and `set_member_role` (who added or promoted whom, and where), and
  since 091 `update_channel` (old and new name and topic),
  `archive_channel`, `unarchive_channel` and `remove_member` (whom, and
  their channel role). Since 157 to 160 it also records
  `set_permissions`, `update_settings`, `update_policy`,
  `update_sensitive_guard` (old and new), `set_audience`,
  `moderate_delete`, `restrict_member` and `export_channel`: sixteen
  actions in all, named by one CHECK on `chat_audit_log.action`.

## Retention and erasure

Nothing in chat is deleted automatically (decision D-4, which stands);
no job removes messages by age. The only automatic removal is the file
sweep above.

An **owner** can erase one person's chat data in one workspace
(Settings → Team chat → erasure; the person may already be
deactivated).

- It needs a reason of at least 5 characters, and the form asks the
  owner to type the person's name (else their email, else `ERASE`).
- **Their messages** keep their place but their text becomes `[erased]`
  and they show as erased. Their files, shared cards and edit history
  (the only path that deletes it) are deleted, and the files are
  removed from storage.
- **Forwarded copies** of their messages (and forwards of forwards) are
  erased too: text `[erased]`, attachments deleted and removed from
  storage. The audit detail gains `forwarded_copies`. Chat
  notifications and queued pushes of a copy are deleted too.
- **Also deleted:** their typing rows and voice plays, their
  reactions, saved messages and chat notifications; mentions in their messages and mentions of them;
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
  decides who may; body `{ reason }`, required when removing someone
  else's message) → `{ files, filesDeleted, filesFailed }`.
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

### Messaging, permissions, moderation (156 to 160)

Called directly like the rest. Errors are the SQLSTATEs listed with
each rule above.

| Function                      | Arguments                                                    | Notes                                                                                                            |
| ----------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `chat_post_message`           | `…, p_reply_to uuid DEFAULT NULL`                            | 156; the old 5-argument form is dropped, positional calls still work; attachments carry `kind` and `duration_ms` |
| `chat_forward_message`        | `p_message, p_channel, p_attachments`                        | 156; `22023` deleted source, `P0002` missing or unreadable, `42501` other workspace                              |
| `chat_mark_voice_played`      | `p_message`                                                  | 156; the author's own plays are not recorded                                                                     |
| `chat_set_typing`             | `p_channel, p_thread_root, p_typing`                         | 156; never joins; throttled to one write per 2 s                                                                 |
| `chat_channel_files`          | `p_channel, p_kind, p_before, p_limit`                       | 156; kind `voice`, `image`, `video`, `file` or `NULL`; limit 1 to 200; invoker rights                            |
| `chat_set_permissions`        | `p_ws, p_denied jsonb`                                       | 157; replaces the denied set; owner or admin                                                                     |
| `chat_set_workspace_settings` | `p_ws, p_edit, p_delete`                                     | 157; windows 1 to 10,080 minutes, `NULL` = none                                                                  |
| `chat_set_channel_policy`     | `p_channel, p_posting, p_thread_replies, p_mention_everyone` | 157; `NULL` keeps; team and private only; channel admins too                                                     |
| `chat_my_permissions`         | `p_ws`                                                       | 157; class, 12 capabilities, windows, `windows_apply`, `sensitive`                                               |
| `chat_set_sensitive_guard`    | `p_ws, p_mode, p_scope`                                      | 158; owner or admin                                                                                              |
| `chat_set_channel_audience`   | `p_channel, p_min_role, p_team_ids`                          | 159; team channels; `22023` if it would hide the channel from you                                                |
| `chat_delete_message`         | `p_message, p_reason DEFAULT NULL`, returns `text[]`         | 160; reason (5 to 500) for someone else's message, else `22023`                                                  |
| `chat_restrict_member`        | `p_channel, p_user, p_until, p_reason`                       | 160; at most 30 days; `NULL` clears; `42501` for a workspace owner or admin or a peer channel admin              |
| `chat_export_channel`         | `p_channel, p_from, p_to, p_reason`                          | 160; owner or admin; audited first; at most 10,000 messages                                                      |

**Re-running** an older file of 157 to 160 on a newer database no
longer drops the `chat_audit_log.action` CHECK: each recreation is
skipped when the constraint already lists its values. It still restores
that file's function bodies, so apply the files in order, once.

Verify files: `verify-chat-messaging-v2.sql` (156),
`verify-chat-permissions.sql` (157), `verify-chat-sensitive-guard.sql`
(158), `verify-chat-restricted-channels.sql` (159) and
`verify-chat-moderation.sql` (160); each is a step in
`.github/workflows/migrations.yml`.
