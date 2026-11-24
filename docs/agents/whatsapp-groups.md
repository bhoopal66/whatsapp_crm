> Moved verbatim from `CLAUDE.md` (2026-11-22). Read this file before changing this area.

### WhatsApp groups (`lib/groups/*`, migration 114)

Groups on a Whapi or company OpenWA number (208: `whatsapp_group_can_create`
and `whatsapp_groups_guard`, mirrored by `isGroupCapableNumber`;
`verify-groups-on-openwa.sql`), at `/groups`. OpenWA goes through
`openwa-groups.ts` behind the same facade; on whatsapp-web.js the gateway
cannot create (501 → `create_unsupported`). `docs/whatsapp-groups.md` is
the contract.

- **Separate tables** (groups, participants, managers, invite link, the
  group's own message log): group traffic never enters `messages`, so the
  inbox, flows, automations, AI and webhooks never see it.
- **Writes go through the routes** (`/api/whatsapp/groups/*`) on the
  service role, after an RLS-client check of the caller (`loadGroupForCaller`).
- **A submission group is never one of these (299).** Its mirror row (same
  account and WhatsApp id) is hidden by both id functions, 404 in
  `loadGroupForCaller` (admins too) and skipped inbound; the row is not
  deleted. `verify-submission-groups-not-groups.sql`.
- **Access lives twice:** the SQL predicates and `lib/groups/access.ts`;
  change one, change both. `verify-whatsapp-groups.sql` asserts the SQL.
- **Inbound** (webhook events, join requests, bells) is `lib/groups/inbound.ts`.
- **Files** (`lib/groups/inbound-media.ts`): after the row is stored, the
  one-to-one mirror copies the bytes to `chat-media` `inbound/` (never
  `staged/`, which is swept, nor `groups/`, which staff may send from) and
  a compare-and-set fills `media.link`. Best effort, in `later`. Submission
  groups keep Whapi's link: their table has no RPC that updates `media`.
- **Delete** (`POST /api/whatsapp/groups/delete`, owner/admin) is for
  good: a still-joined group is left on WhatsApp first (failure deletes
  nothing), then `whatsapp_group_tombstones` (173), then the row;
  children cascade. A submission group is refused. `persistGroupSnapshot`
  and Sync skip tombstoned groups; Sync skips submission groups too.
- **Staff numbers (219).** A live agent/team leader's saved number
  (`coordinator_phones`) follows group access both ways: the managers
  PUT adds/removes it (`lib/groups/manager-numbers.ts`; a removal reads
  `staff_removal_phone`, 299, which a deactivation does not empty, and
  reports `no_saved_number`), the
  `whatsapp_group_participants_staff_manager` trigger (AFTER INSERT
  only, so a snapshot upsert never re-grants a removed manager; for the
  same reason a snapshot naming nobody deletes nobody) makes
  a joining number a manager. Submission groups: the access route
  (`lib/submission-groups/staff-number.ts`) and `sg_staff_number_joined`
  (Add number, webhook add events). WhatsApp failures never undo the
  CRM write. `verify-group-staff-numbers.sql`.
- **Pacing** is anti-ban: 5 adds per call, 3 s apart, 50 per operation,
  invite-link fallback; opted-out contacts are skipped; 20 sends/min/group.
