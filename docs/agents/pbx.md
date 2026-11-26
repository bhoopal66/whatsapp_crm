> Moved verbatim from `CLAUDE.md` (2026-11-22). Read this file before changing this area.

### Phone system (`lib/pbx/*`, migration 089)

Yeastar P-Series. `lib/pbx/yeastar/*` is the Open API client plus the event
parser, signature check, WebSocket helpers, token manager and CDR helpers.
`docs/yeastar.md` is the operator contract.

- Who sees a call is `pbx_can_view_call`; guests see none. Since 113:
  owners/admins all; everyone else the calls they were on or that rang
  them (`meta.rang_user_ids`), a leader also their teams' calls, plus
  the calls of contacts they can see. `call_live_select` follows. Since
  294 also each person who answered a leg (`meta.answered_user_ids`, that
  person alone, not their leader): after a transfer `user_id` names one of
  them, and each may write the outcome and note (`pbx_set_disposition` ↔
  `answeredByFilter`, the wrap-up list). `user_id` alone still credits the
  reports. A consulted colleague is not on the list: the other side of an
  internal leg joins only when that leg outlasts the asker's time with the
  customer (`answeredExtensions`; ties and untimed legs stay out). A note is saved only over the text its writer last saw
  (`pbx_save_call_note`, `notesSeen`): a conflict is a 409 with
  `conflict: true` and the stored text, an erased call a 409 without it.
  The in-call panel's draft is `call-note.ts` (pure) and `call-note-store.ts`:
  a panel never goes with an unsaved draft unless the person says so; it is
  kept in `sessionCache` behind a message (`keepCallNote`, `reopenPanel`).
  Re-running 089 or 198 reverts 294. `verify-call-notes.sql`. Secrets
  (app-encrypted) live only in `pbx_connection_secrets`: RLS on, no policy, no
  client grant.
- **Tokens.** Yeastar allows 8 live tokens per application, each for 30
  minutes, so `token-cache.ts` shares one cache per connection and credential
  pair (`api`, `sdk`) in the secrets row: a per-process queue, then a
  compare-and-set through `pbx_token_swap` (3 tries). `pbx_token_lock` is
  deliberately unused: through PostgREST its transaction ends before the
  locked work runs. Recording and socket URLs embed a live token: never log or
  store them.
- **Events** come by webhook (`/api/pbx/yeastar/events/[token]`: the path
  token finds the connection, `X-Signature` is an HMAC-SHA256 of the raw body,
  fail closed) or from the WebSocket gateway (`scripts/pbx-gateway.mjs`, which
  never holds PBX credentials). `ingestPbxEvent` (`process.ts`) dedupes on a
  `pbx_events_raw` hash upsert, then writes `calls`, live state, presence, a
  `missed_call` task and a `call_missed` bell, and settles call-backs; a bad
  event never throws. A later customer call with talk at a known extension
  closes the open `missed_call` tasks of that contact or number whose
  calls started before it, whoever holds them (`closeSpokenMissedTasks`, meta
  `spoke_call_id` / `spoke_user_id`); one holding a call missed since stays.
  A missed end handled after such a call opens and folds nothing
  (`spokenSince`, read again once the task is written).
  The Calls screen's badges are read on the service role (`missed-tasks.ts`)
  for calls the caller's RLS read returned.
- **Recordings** are fetched one at a time (the PBX refuses a second
  concurrent download) into the private `call-recordings` bucket, uploaded
  before their row, hence the orphan sweep's 1 h grace.
  `pbx_recording_playable` decides playback: fetched, not erased, the call
  announcement played or not required (C-1; one fetched while it was not
  required is held again if it is switched back on), and not a bank-number
  call while `exclude_bank_numbers` is on. That is re-checked at play, so a
  number listed later holds audio already fetched; `bankCandidates()`
  (`process.ts`) and the function's candidate set change together. A play is
  logged first in `call_access_log` (guarded: playable, agent and up, leader
  and up to download), then a 300 s URL is signed.
- **Erasure.** `pbx_erase_contact_calls` (owner-only, with a reason, refused
  under a legal hold) matches the contact, its phone candidates and
  `pbx_phone_variants` (↔ `phoneVariants` / `contactPhoneCandidates`), but a
  call linked to somebody is only theirs (311): `meta.contact_candidates` is
  never kept on a linked call. A call is on a deal once
  (`deal_files_call_ref_idx`), never on another customer's. The
  `calls_guard` trigger strips number, file and meta for every writer, late
  PBX events included.
- **Numbers.** `contacts.phone_normalized` is only the typed digits (022, no
  country code added), so a contact is found by number with
  `storedPhoneCandidates` (national and `00` forms too), never by `phone`.
  A number search goes through `numberSearchTerm` (`phone.ts`).
- **Call-backs** (`callback_requests`, written by the journey sink, which
  gives a do-not-contact customer a task instead; hours restated untested) are
  dialled by `callbacks.ts` 09:00–20:00 Asia/Dubai, at most 3 attempts (30 min,
  then 2 h apart), never to a do-not-contact contact or number; a `dialing`
  claim older than 30 minutes is released on every pass, outside hours too.
  Only a refusal the PBX stated is a failed dial: an unclear answer stays
  `dialing`, never redialled at once. `ringClash` keeps one customer from being
  rung twice in 30 minutes and is asked again AFTER the claim (that second look
  is what stops overlapping passes: keep both). A wait moves `not_before`, so
  the head of the queue cannot block it; no owner or extension is `skipped`.
- **Browser.** The Linkus softphone SDK loads at runtime from
  `NEXT_PUBLIC_LINKUS_SDK_URL` (unset: desk phones only). It and
  `NEXT_PUBLIC_PBX_ORIGIN` (https and wss) are added to the CSP in
  `src/lib/csp.ts`, both inlined at build time. `CallProvider` in
  `dashboard-shell.tsx` mounts the incoming-call card, in-call panel and
  softphone. A row's silence is no proof a call ended (nothing writes
  it between frames), so lost hang-ups are judged by `CallPulse` in
  `call-ui.ts`: quiet on the server's clock and no softphone session;
  such a call yields, and only a person closes it. The action route's
  404 (`not_on_call`, `call_gone`) ends the panel at once
  (`markCallGone`, kept at that frame's `updated_at`; a newer frame
  brings it back) and never deletes `call_live`. An all-BYE frame stamps
  `meta.bye_at` / `bye_channels`, so a slower earlier frame does not put
  the row back (`precedesBye`); a new channel is a call that goes on.
- `runPbxCron` (recordings, call-backs, event retries, purge) runs from
  `GET /api/pbx/cron` and the automations cron, and starts no new work
  after 45 s. `verify-pbx.sql`. The retry also picks events interrupted
  before their stamp (no error, over 2 minutes old); `event-retry.ts`
  decides what an old one may still do: over an hour on, a call end only
  writes its row (`late`: no task, bell or call-back), and an old ring or
  a superseded status is stamped without running.
- **Lost events.** The cron's `reconcile` step (`reconcile-calls.ts`,
  every 15 minutes) ingests calls with no `calls` row, or a live one whose
  end was lost (`lostCalls`: off the PBX's own list of calls up, read
  before the CDR, since a finished leg has its record while the customer is
  still on the line), from the last hour's CDR, 10 minutes after they end and decided on the merged call: all legs
  `historical`, except the last leg of a missed inbound call, which rings
  once (an answered one under an hour old also closes the customer's
  missed-call tasks); `keepClock` leaves `last_event_at` alone. Calls that started over
  an hour ago are not recovered here (the gateway's 24 h backfill covers
  those when the gateway runs).
- **Chats follow the caller.** `assignChatFromCallHistory`
  (`assign-from-calls.ts`) runs in `processMessage` after the idempotency
  boundary and before the unread bump (the bump's realtime event is what
  surfaces the chat for the new assignee), for a chat with no assignee
  and no `human_engaged_at` (replying does not assign, so the assignee
  alone would take a chat someone is working): the newest outbound call
  to the number or contact, in the workspace, by a live staff person. A
  contact owned by another live agent or leader is skipped, because 169
  would move it. Never throws; the write is conditional on the chat
  still having no assignee. An automation's `round_robin` step leaves a
  held chat alone for the same reason. 171's index is speed only.
- **Link health (104).** Every ingest stamps `pbx_connections.last_event_at`
  and `last_event_via`. A trigger keeps the clock forward-only and caps it at
  `now() + 1 minute`. The cron's `silence` step rings owners and admins once
  through `pbx_connection_silence()` after 15 quiet minutes inside
  09:00–20:00 Dubai, and once more when events resume. It rings only when
  the latest event fell in that day's working hours: webhooks have no
  heartbeat, so earlier silence may just mean the centre isn't open yet.
- **Unrouted calls.** A call to a DID with no route is filed under the
  connection's workspace with `calls.meta.unrouted`. Owners and admins list
  those calls through `GET /api/pbx/calls?scope=unrouted`; its per-number
  summary covers 30 days.
- **Call report (119).** `pbx_call_stats()` returns the whole Call
  report page as one JSON object. Its scope is `pbx_visible_user_ids()`
  (113), and naming a person outside that scope raises 42501. It uses
  098's attribution, so it agrees with `pbx_call_report`.
  `verify-pbx-call-stats.sql`.
