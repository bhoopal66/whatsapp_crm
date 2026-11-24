> Moved verbatim from `CLAUDE.md` (2026-11-22). Read this file before changing this area.

### Team chat (`lib/chat/*`, migration 087)

Names dodge collisions: `message_reactions` already holds WhatsApp reactions
(009), hence `internal_message_reactions`, and "channel" already means a
WhatsApp number, hence `chat_channels` / `chat_channel_members`. Kinds are
`team`, `private`, `dm` (2–8 people, `chat_open_dm`) and `deal_room` (088
only). `docs/internal-chat.md` is the contract.

- **DM rules (143).** `chat_dm_rules` holds per-workspace restrictions
  on which role classes (admin, team_leader, coordinator, agent, viewer)
  may share a DM: `none` / `team` / missing = `all`, most permissive
  class pair wins, owners exempt. `chat_open_dm`, `chat_assert_can_write`
  and `chat_user_can_read_channel` enforce it (a blocked DM is hidden,
  not deleted); the refusal phrase "direct messages between these
  people are turned off" is what `lib/chat/errors.ts` keys on.
  `verify-chat-dm-rules.sql`.
- **DM membership (273).** A DM whose `dm_key` names two people cannot be
  left (`leaveBlock` hides the button), and `chat_open_dm` re-inserts every
  named member of an existing DM. Re-apply 273 after 087, 143 or 157.
  `verify-team-chat-fixes.sql`.
- **Posts once (276).** `chat_post_message(p_client_id)` answers a repeat
  with the first message, before any rule, file or bell; the client id is
  one per draft and renewed when its content changes (`post-id.ts`), else
  an edit is lost. A first message that is deleted or erased gives its id
  up and the repeat is posted. What a send or a take carries is decided in
  `post-payload.ts` (a take quoting another message is a new post). Re-apply
  276 after 087, 156 or 157 (after 157, 158-160 come first, in order).
  `verify-chat-post-once.sql`.
- **People who left (277).** `chat_people` lists deactivated people with
  `deactivated`, so their names stay; anything that offers people leaves
  them out, and "not in the list" no longer means "left" (`otherAdmins`).
  `verify-chat-people-mentions.sql`, `deactivated.test.ts`.
- **An edit's mentions (277).** `chat_edit_message` makes
  `message_mentions` those of the new text and rings only a mention it
  added, never who the message already rang; broadcasts are not
  recalculated. Re-apply 277 after 157, and after 087 (drop
  `chat_people(uuid)` before that one).
- **Writes are RPCs.** The tables are RLS-forced and grant SELECT only, even
  to the service role; every write is a SECURITY DEFINER `chat_*` function the
  browser calls directly (`lib/chat/api.ts`). The exceptions: a file upload is
  a storage INSERT, and deal-room rows are 088's. Each function is revoked and
  re-granted (a new one needs its GRANT), and parameter names (`p_ws` …) are
  the client contract. With `internal_chat_enabled` off, writes raise `CH001`.
- **Membership** is any live profile row in the channel's workspace, not only
  the active one; Author checks use `IS DISTINCT FROM`: `<>` on a NULL system
  author let anyone edit or delete system posts.
- **Bank guests** see only the private channels and deal rooms they belong to,
  never a team channel or a DM, and in a deal room the channel and its members
  but never its messages (the Team notes). They cannot create channels or DMs.
- **Admin read.** An owner/admin who is not a member reads a private channel,
  DM or deal room only through `chat_admin_read_private` (a reason of 5+
  characters, `MIN_REASON_CHARS` in `admin-tools.ts`), which writes
  `chat_audit_log` first.
- **Shared conversation cards.** `chat_shared_cards()` and the policy re-run
  `chat_can_view_conversation` (active account, admin or
  `can_view_conversation`) at read time; anyone else learns only that a card
  exists. Sharing into a channel with a guest member is refused at post time
  only, so a guest added later is held off by the read check.
- **Call cards (103).** `chat_share_call` posts a `shared_calls` card (ids
  only) into a team or private channel or a deal room's Team notes. The
  sharer must pass `pbx_can_view_call`. `chat_shared_call_cards` re-checks
  that at read time, and gives the customer's name and id only to a reader
  who also passes `can_view_contact`. A leader sees every call but not every
  customer.
- **Service-role grants.** `verify-internal-chat-admin.sql` pins the exact
  `chat_*` functions the service role may execute. A new grant updates
  that list.
- **PostgREST embeds.** `message_pins (channel_id, message_id)` is a
  second path between `chat_channels` and `internal_messages`, so an
  unnamed embed between them is ambiguous (PGRST201, answered as HTTP
  300, not a 4xx, so it is easy to miss): name
  `!internal_messages_channel_id_fkey`.
- **Files.** The private `chat-files` bucket is readable
  (`chat_storage_can_read`) only while a live attachment row exists; deleted
  and erased files used to stay readable. Deletes go through
  `POST /api/chat/messages/[id]/delete`, and the automations cron's sweep
  (`chat_orphan_files`) removes objects over 24 h old with no live row. A
  signed URL (300 s) outlives a delete.
- **Erasure** (`chat_erase_person`, owner-only, reason required) turns the
  person's bodies into `[erased]` and deletes their attachments, cards, edit
  history, mentions, reactions and notifications. Edit history and the audit
  log are otherwise append-only: the one DELETE needs `chat.erase=on` **and**
  the table owner, because a client can set the setting.
- **Bell and realtime.** A trigger turns `chat_notifications` into
  `notifications` of type `chat_mention` / `chat_dm` / `chat_thread_reply` /
  `chat_broadcast`; `CHAT_NOTIFICATION_TYPES` (`notification-link.ts`), 085's
  CHECK and the type lists in edit, delete and erase change together.
  `verify-internal-chat.sql`, `verify-internal-chat-admin.sql`.
- **Team chat v2 (156–160, `docs/internal-chat.md`).** Apply in order,
  as superuser/BYPASSRLS (157–160 refuse otherwise), before the build.
  `chat_post_message` has `p_reply_to` (the old signature is dropped) and
  attachments carry `kind` / `duration_ms` (voice is a message's only
  attachment). A forward copies storage objects client-side, then
  `chat_forward_message`. Typing never joins a channel; a play by the
  author is not recorded.
  - *Permissions (157).* A `chat_role_permissions` row is a denial; owners
    exempt; since 168 agents and viewers never create team/private
    channels unless the agent is a coordinator (`chat_has_permission`,
    `channelCreationLimit`); the 12 capabilities in `lib/chat/permissions.ts` are pinned to
    the table's CHECK by a test in `src/lib/chat/__tests__`. Edit/delete
    windows exempt owners and admins. Posting rules (`posting`,
    `thread_replies`, `mention_everyone`) exist on team/private only; DMs
    and deal rooms are CHECK-locked to everyone.
  - *Sensitive guard (158).* A trigger, not app code. `chat_sensitive_kinds`
    mirrors `lib/kb/sensitive.ts` + `redact.ts`: change both; the corpus in
    `verify-chat-sensitive-guard.sql` and `sensitive-corpus.test.ts` pins them.
    Since 307 `chat_insert_attachments` scans each file name too, by the same
    `chat_assert_not_sensitive`; the composer warns through
    `messageSensitiveKinds`.
  - *Audience (159).* One clause in `chat_user_can_read_channel` covers every
    read; BEFORE triggers guard writes. Membership is no override.
  - *Moderation (160).* Deleting another's message needs a 5–500 character
    reason and sets `deleted_by`; a restriction is enforced in
    `chat_assert_can_write`; `chat_export_channel` writes its audit row
    first. `chat_audit_log.action` has a 17-value CHECK (172 added one): any later
    migration must recreate it whole; 157–160 each skip the recreation
    when the constraint already lists their values, so re-running an
    older file does not drop it (it still restores its function bodies:
    apply in order, once). A timeout is a row of
    `chat_channel_restrictions` (not a membership column): leaving and
    rejoining does not clear it, restricting a team non-member does not
    join them, lifting is an UPDATE (`until = now()`) never a DELETE
    (realtime does not RLS-filter DELETE), owners/admins are never
    blocked, and the rows are read by the restricted person and
    `chat_can_manage_channel`. A typing stop is likewise `stopped = true`.
  - *Restricted channels (159).* Managing a team channel needs the
    audience unless owner/admin; `audience_team_restricted` keeps a
    channel closed when its teams are all deleted.
  - *Forwarding.* Copies must be all the source's files and no others
    (307; before it a missing one passed), and a
    storage path belongs to one message (`already belongs to a message`).
    The RPC needs no upload right, but the client-side copy is a storage
    upload (`chat_storage_can_write`: upload_files or send_voice), so
    `messageActions` offers Forward on a message with files only then.
  - *Deleting a channel (172).* `chat_delete_channel` lists every table
    with an FK to `chat_channels` / `internal_messages`, and
    `verify-chat-delete-channel.sql` pins that list: a new one joins both.
    `chat_audit_log.channel_id` has no FK so the log outlives the channel;
    don't restore it. The function must be owned by
    `internal_message_edits`' owner, or the `chat.erase` delete is refused.
  - Verify files: `verify-chat-messaging-v2.sql`, `verify-chat-permissions.sql`,
    `verify-chat-sensitive-guard.sql`, `verify-chat-restricted-channels.sql`,
    `verify-chat-moderation.sql`.
- **289.** `chat_add_members`: only a channel admin adds to a private
  channel, bank guests included (a guest also still needs a workspace
  owner, admin or supervisor); `lib/chat/membership.ts` mirrors it.
  `chat_insert_attachments` takes only the poster's own object
  (`owner_id`, else `owner`; a forward's storage copy carries the
  forwarder). An object with no owner is one the server wrote.
- **307.** `chat_forward_message` and `chat_share_call` take 276's client id
  as a REQUIRED last argument of a second function; the old signature beside
  it calls it with none, so no call has two candidates. An edit rewrites only
  the bells of people who may read the channel; leaving a private channel or
  group DM deletes the leaver's unread ones. `verify-chat-forward-once.sql`.
