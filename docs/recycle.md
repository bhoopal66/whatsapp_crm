# Declined recycling

`/recycle` (team leader and up) lists customers worth another try: their
latest case ended **Declined** or **Withdrawn**, or their chat carries a
chat tag an admin marked as "declined-type", at least N days ago
(default 90, 1 to 730). Nothing is ever sent from this screen.

## Who is never listed

- opted out (`contacts.opted_out_at`) or do-not-contact (`do_not_contact_at`)
- a case or lead of any bank is still open (they are active again)
- the customer wrote after the ending (they came back)
- a newer ending exists inside the last N days (the latest ending decides)
- contacts the caller cannot see (contacts RLS decides; a team leader sees
  their team's customers)

The "open case" and "came back" checks run in `recycle_excluded_among`
(SECURITY DEFINER). It answers team leaders and up only, and "came back"
counts messages in company chats only, never a personal-number chat
(migration 256).

## Settings (owner / admin, card at the top of the screen)

Days, the case outcomes that count, and which main chat tags mean
"declined". Stored in `recycle_settings`; no row means 90 days, Declined +
Withdrawn, no chat tags. A chat's "ended" date is its last message (the
tag change itself is not timestamped).

## Actions on the selection

- **Start a campaign** opens `/broadcasts/new` with the customers as a
  CSV-style audience (handed over through session storage for one hour).
  You choose the template and send; opt-outs are checked again when the
  broadcast is planned and sent.
- **Create follow-up tasks** files one `follow_up` task per customer, for
  the customer's owner (the caller if the owner is not live staff), titled
  "Follow up: <name> (declined <date>)". Running it twice adds nothing
  (`source_ref recycle:<contact>:<date>`).

Up to 1,000 customers per action. SQL: migration 251,
`supabase/ci/verify-recycle.sql`.
