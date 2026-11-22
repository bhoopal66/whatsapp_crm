> Moved verbatim from `CLAUDE.md` (2026-11-22). Read this file before changing this area.

### Coordinators (`lib/coordinators/*`, migration 133)

The staff who file applications with banks. `docs/coordinators.md` is the
contract.

- **Not a role.** A coordinator is a live agent/team_leader with rows in
  `coordinator_banks` (case banks), set only by `set_coordinator_banks`
  (owner/admin). `account_role_enum` is unchanged.
- **Shares** (`conversation_coordinator_shares`, RPCs
  `share_conversation_with_coordinator` / `revoke_conversation_share`)
  grant through `coordinator_share_grants(conversation_id)`: an open share,
  the bank still held, the person live staff in their active account.
  It is OR'd into separate SELECT policies on conversations, messages and
  contacts and into `chat_can_view_conversation`, plus a messages INSERT
  policy limited to the chat's own `channel_id`/`send_channel_id`.
  `can_view_conversation` and `can_view_contact` are deliberately
  unchanged (the contact stays read-only: extending `can_view_contact`
  would hand over calls, tasks, deal rooms and memory too).
- **Send path.** `send-message.ts` refuses a share-only sender on another
  number before the gateway (`shared_chat_number`) and writes the chat's
  last-message summary with the service role. `canViewConversation`'s
  `sharedWithMe` and `canReadContact` are the TS mirrors.
- `push_bell_url` (restated in 133) and `hrefFor` in
  `lib/notifications/target.ts` both open the chat for
  `conversation_shared`; change them together. `verify-coordinators.sql`.
