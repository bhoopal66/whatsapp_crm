> Moved verbatim from `CLAUDE.md` (2026-11-22). Read this file before changing this area.

### Chat tags (`lib/chat-tags/*`, migrations 075–076)

Admin-defined, colour-coded tags that replaced the chat header's
Open/Pending/Closed control and the list's status filters.
`conversations.status` stays: automations close chats, inbound
reopens them, the public API filters on it. A chat carries at most
one main tag (`conversations.chat_tag_id`) and one sub-tag of it
(`chat_sub_tag_id`, e.g. which bank under "Interested");
`chat_tags.sub_tag_title` captions it ("Bank: ADCB").

They are the only tag system. The older contact tags (`tags` /
`contact_tags`, many per contact) were retired from every screen and
feature; the tables are still in the schema, unused, until a cleanup
migration drops them. Their jobs moved here: broadcast audiences
(`chat_tags` / `excludeChatTagIds` in `audience_filter`), the
automation trigger `chat_tag_set`, step `set_chat_tag` and condition
`chat_tag_presence`, the flow `set_tag` node (it now sets chat tags)
and condition subject `chat_tag`, the Contacts screens' column and
filter, and the public API (conversations carry `chat_tag` /
`chat_sub_tag`; contacts keep a deprecated, always-empty `tags`).

- **Opt-out is a column, not a tag (076).** `contacts.opted_out_at` is
  set by the AI bot and the TypeSafe watch (`markOptedOut`). Every
  broadcast leaves those customers out — when the wizard plans
  (`resolveAudience` → `finalAudience`), when the API plans
  (`createBroadcast`), and again at send time (`planBroadcastResume`
  marks a recipient who opted out since as failed). The inbox contact
  panel and the Contacts screens show an "Opted out" badge. Only the
  service role (the bot, the watch) or an admin of the contact's
  account may set or clear the stamp (`contacts_opt_out_guard`, on
  INSERT too); `verify-contact-opt-out.sql` asserts it.
- **A tag change is a server write.** The header saves through
  `PUT /api/conversations/[id]/chat-tags` (the caller's RLS client via
  `writeConversationChatTags`), which dispatches `chat_tag_set` in
  `after()` only when something changed (`dispatchChatTagSet`). The
  automation step and the flow node write through the same helper; a
  chain of tag-triggered tag writes stops at depth 3
  (`vars._chat_tag_chain_depth`). `chatTagTriggerMatches` fires on
  arrival at the configured tag, never on a re-save.
- **Writes are compare-and-set.** `writeConversationChatTags` updates
  only if both columns still hold what it read, re-reading once on a
  lost race; a writer that finds the chat already where it was going
  reports no change, so two racing writers dispatch `chat_tag_set`
  once. A write that leaves `chat_sub_tag_id` out keeps the chat's
  sub-tag while the main tag is unchanged (`resolveChatTagsWrite`);
  `null` clears it. The builders' "Keep current sub-tag" saves the key
  absent.

- **The pairing lives in SQL.** `conversations_chat_tag_guard` refuses
  a sub-tag as a main tag or a sub-tag of another main tag, and clears
  the sub-tag when only the main tag changes. `chat_tags_guard` keeps
  nesting one level deep and `parent_id` immutable. Every reference is
  a composite FK on `(id, account_id)` with `ON DELETE SET NULL (col)`
  — the column list keeps `account_id`. `verify-chat-tags.sql` asserts
  all of it.
- **Who.** Members read tags, admins write them (Settings → Chat
  tags). Tagging a chat is a plain conversations UPDATE under the
  existing policy, so agents and up on chats they can see; viewers
  never.
- **Client.** `useChatTags()` caches the list per account, and
  `reload()` refreshes every mounted consumer (header, list, Settings).
  The list filter is pushed server-side through `chatTagFilterOrGroup`
  (UUID-guarded) and re-applied client-side. A save that lands after
  the agent opened another chat must not patch it:
  `patchIfSameConversation` checks inside the state updater.
