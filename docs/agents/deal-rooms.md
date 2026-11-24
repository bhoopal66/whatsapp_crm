> Moved verbatim from `CLAUDE.md` (2026-11-22). Read this file before changing this area.

### Deal rooms (`lib/deal-rooms/*`, migration 088)

A deal room is a WhatsApp group on the account's Meta number (a trigger
refuses any other), linked to a contact and optionally a deal, with a
`deal_room` chat channel for Team notes. `lib/whatsapp/meta-groups.ts` holds
the Groups API facts the code relies on, documented in the deal-rooms section
of `docs/meta-cloud-api.md`: creation is async (the group id and invite link
arrive by webhook, matched on `request_id`); an invite is a 1:1 template whose
body carries a `group_id` parameter; group sends are `recipient_type:
'group'`, and inbound group traffic carries `group_id`; a group holds 8
participants including our number (`GROUP_MAX_PARTICIPANTS` ↔ SQL's 1–7
invitees); it has its own 24 h window (`window_until`), templates only outside
it.

- **Statuses** are `creating`, `open`, `suspended`, `closing`, `closed` and
  `failed`; `closed` is terminal and `open` needs `wa_group_id`. Client RPCs
  refuse closing/closed rooms, staff operations need `open`, and SQL refuses
  outbound non-system messages on a closed room while still recording inbound
  messages, receipts and membership.
- **Access** (`deal_room_access`): owner/admin all; a team leader where they
  can see the contact and, if any, the deal (`deal_room_leader_sees`); members
  of the room's channel; a bank guest only while their bank's `guests_allowed`
  switch is on, as a channel member, with a participant from their bank not
  pending, rejected, removed or left (312). `deal_room_open_to_guest` is that
  one guest rule; the room's chat channel and `chat_people` ask it too, after
  the membership row and for a guest only (staff must not pay per row). `deal_room_can_manage` adds agents who own the
  contact or administer the channel; guests never manage.
- **Guests never read `deal_rooms`.** Staff and guests share the
  `authenticated` role, so column grants cannot hide its internal columns:
  guests read the security-barrier views `deal_room_guest_rooms` and
  `deal_room_roster` (no phone column; an unlisted person is "ending NN"), and
  messages and receipts only from their own join. No client can read
  `invite_link_hash`, `sender_wa_id` or `participant_wa_id`, so `select=*`
  fails.
- `deal_room_admit_block` is the one rule for join-request auto-approval and
  every invite send (`room_not_open`, `opted_out`, `no_consent`,
  `bank_guests_off`, …).
- **Webhook.** The Meta route picks group traffic out (`isGroupMessage`,
  `isGroupStatus`, `isGroupChange`; the normaliser skips the same items, so
  change both) and hands it to `handleGroupWebhook` after `processMetaEvent`.
  It never reaches `inbound-pipeline.ts` but is edge-screened. The
  service-role functions it calls take the authenticated account id, or a room
  id resolved inside that account. A group STOP removes the person at Meta and
  opts the contact out; its database work is tried twice, and a contact left
  unstamped logs `STOP NOT APPLIED`. Nothing redelivers group traffic.
- **Bells** (274): `group_messages_ring` gives the room's live staff (and an
  owner or admin who opened it) one unread `deal_room_message` per room, never
  someone `deal_room_access` refuses; `markRoomBellsRead` in the room's screen
  must clear it or the room never rings again.
- **The screen** re-reads after a realtime gap (`table-signal.ts`); a guest's
  room and list stay on the minute refresh. `room-timeline.ts` pages back to
  what is held, or replaces it: never a hole.
- **Reconcile** (`reconcileCreatingRooms`, from `GET /api/deal-rooms/cron` and
  the automations cron) takes rooms still `creating` after 2 minutes: matched
  to their group by subject, asked for once more, or failed at 10. Invites
  claim each person (a `pending:<epoch ms>:<uuid>` marker in
  `invite_message_id`) before the send and release the claim when the send
  fails; the reconcile also frees a claim older than 30 minutes (a crash
  between claim and result) and re-sends that open room's invites — a send
  that went out but was never recorded can thus be invited twice
  (`releaseStaleInviteClaims`). `verify-deal-rooms.sql`.
