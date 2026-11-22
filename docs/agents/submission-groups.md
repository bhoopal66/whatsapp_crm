> Moved verbatim from `CLAUDE.md` (2026-11-22). Read this file before changing this area.

### Submission groups (`lib/submission-groups/*`, migration 115)

One Whapi WhatsApp group per submitted case, opened by the external
submission app. `docs/submission-groups.md` is the contract.

- **Trigger.** `POST /api/v1/submission-groups` (scopes
  `submission_groups:read|write`), idempotent per `(account, submission_id)`;
  `PATCH` reports a status and a final one ends the group. `mcp-server/`
  is not involved. Staff are named by login email (`sg_staff_by_email`).
- **Participants** are the hosting Whapi number, the customer and an
  optional coordinator phone; a customer WhatsApp will not add gets the
  invite link 1:1. The CRM access list is separate (label agent /
  coordinator / team_lead, per group, not the account role).
- **Writes are `sg_*` RPCs only**: the tables are RLS-forced and even the
  service role reads but never writes them directly. Like 114 it must be
  applied as a superuser or BYPASSRLS role.
- **Who reads** lives twice, `sg_rule_can_read` and `rules.ts`: change one,
  change both. An ENDED group's messages are read only through the
  audited `sg_read_archive` (audit row and messages in one statement; a
  refusal writes nothing); its metadata is listed to the same readers
  unaudited. The list branch also requires live staff (`sg_is_staff`).
- **Send** writes the `out` row first (`sg_send_begin`, pending), then
  the gateway call, then settles once (`sent` / `blocked` / `failed`);
  the cron fails pending rows older than 10 minutes.
- **Inbound** group messages arrive through `processWhapiGroups` and are
  stored idempotently on `(group_id, wa_message_id)`; they never reach
  `messages`, flows, automations or the AI.
- **Detach on delete:** `channel_id` / `contact_id` are ON DELETE SET NULL;
  a detached group refuses sends (`NUMBER_REMOVED` / `CONTACT_REMOVED`).
- **Consent:** opt-out and do-not-contact refuse create and sends; there
  is no opt-in register.
- **Cron:** the automations cron every 2 minutes (`cron.ts`): pending
  creates, stale sends, close retries. Idle ending is off.
  `verify-submission-groups.sql` asserts the SQL.
- **Without a group (136).** `submission_groups.wa_mode` ('group' |
  'none') is fixed at creation; a 'none' row has no number, is never
  claimed or sent into (`NO_WHATSAPP_GROUP`), and `sg_end` still ends it.
  New submissions are 'none' while
  `case_account_settings.submission_whatsapp_groups` is off (the default).
  `verify-submission-no-whatsapp.sql`.
- **Customer name (141).** `submission_groups.customer_name` is the
  request's `customer.name`, set by `sg_open` at creation only; the case
  screens show it, else the contact's name (contacts are never renamed).
  `verify-submission-customer-name.sql`.
- **Unread, bell, team leader (173).** `submission_group_reads` is a
  per-person marker written only by `sg_mark_read`, which also reads that
  person's `submission_group_message` bells for the group and refuses an
  ENDED group. `sg_unread_by_group` / `sg_unread_count` count inbound
  messages (146's 7-day rule). A trigger rings a customer's message to
  the agent and coordinators, bank holders included, once per person per
  group while unread; the customer's text never goes in the bell. On an
  ACTIVE group a live leader of the case's agent counts as `team_lead`
  after a real open row and before 163's bank holder
  (`sg_leads_group_agent`, service role only); `openAccessLabel` and
  `impliedLabel` are its TS mirrors. A reassign moves access
  (`cases_move_group_access`; a failure there warns and never fails the
  reassign). The type lives in
  `notifications_type_check`, `push_bell_url`, `hrefFor`, `PUSH_KINDS` and
  `kindGroup`: change them together. `verify-submission-group-reads.sql`.
- **Who gets a group.** A new submission opens `wa_mode 'none'` when the
  agent is a coordinator, an owner or an admin (`isAdminAgent`), or has no
  usable number; an unknown email stays `422 unknown_user`.
- **Invites and joining (174).** `createPending` sends a refused customer
  the invite, on every create path, and `resendInvite` backs the page's
  button (10-minute limit, read from `invite_sent_at`).
  `customer_membership` is 'unknown' / 'joined' / 'absent', written only by
  `sg_note_customer_membership`: creation, the webhook's participant
  events, a trigger on a customer message, and the cron's participant
  read (`sg_membership_due`, 6 hours). A hidden `@lid` number never reads
  as absent. `verify-submission-group-membership.sql`.
