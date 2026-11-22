# Track B notes — who gets each chat, and replying on time

Branch `claude/track-b-assignment`, from `claude/admiring-dirac-8082b3` at
772a1d5. Migrations 236–238. CHANGELOG.md and CLAUDE.md are untouched on
this branch; the text for both is below, for the coordinator to paste.

## CHANGELOG entry

### Chat assignment: a real rotation, limits and Compass chats

**Migration required:** apply `236_assignment_rotation.sql` after 235, as
a superuser or BYPASSRLS role (the Compass assign writes
`conversation_coordinator_shares`, which has forced RLS, like 133).

- One rotation engine (`assignment_rotate_assign`) picks the next person
  from a chosen list in turn, with a stored position. It skips anyone
  offline, deactivated, a bank guest, a viewer or at their chat limit,
  and assigns nobody when nobody is free. Two chats arriving together
  never get the same person (per-workspace lock).
- The automation **Assign conversation → round robin** step now really
  rotates. It has an on/off switch and a people list (default: all live
  agents and team leaders). Before, it gave every chat to the first
  member, usually the owner. A chat someone is already working is still
  left alone.
- Settings → **Chat assignment** (owners and admins), all off by default:
  - assign the first reply to a broadcast through the rotation, from a
    chosen people list;
  - assign a chat Compass writes to (1:1 update, no assignee yet) to the
    case's agent and share it with the case's coordinator;
  - chat limits: 30 open assigned chats by default, with per-person
    overrides. The rotation skips people at their limit, and the Assign
    menu shows each person's load ("Ravi Kumar · 12/30").

### Response times: business hours, a reply target and escalation

**Migration required:** apply `237_response_targets.sql` after 236.

- Settings → Inbox & CRM → **Response times** (owners and admins):
  business hours per weekday, the time zone and a response target.
  Defaults: Monday to Saturday 09:00–18:00 Asia/Dubai, 15 business
  minutes, switched off.
- When switched on, a customer left waiting on a company chat rings the
  assigned person at the target, their team leader (or the owners and
  admins, when they have none) at twice the target, and the owners and
  admins when nobody is assigned. Each bell opens the chat and rings
  once per wait; only time inside business hours counts. Personal chats
  never count.

### My worklist, Live view and smaller fixes

**Migration required:** apply `238_live_view.sql` after 237.

- My worklist opens with **Customers waiting for a reply**, oldest
  first, unassigned chats flagged; it no longer says "Nothing needs
  action" while customers wait.
- After sign-in, agents and team leaders land on My worklist; owners,
  admins and viewers on the dashboard; a deep link still wins.
- **Live view** (`/live`, team leaders and up): per person online / away /
  offline, open chats, customers waiting and the oldest wait, replies
  today. Team leaders see their teams; owners and admins everyone.
- **My team** on My worklist and Cases for team leaders. The worklist
  shows "Overdue by 2 h" instead of a raw score.
- Automations: "Start from template" is always in the Create menu; the
  condition step reads as a sentence; time pickers replace typed
  "HH:mm-HH:mm"; preset schedules (every day at, weekdays at, every hour).
- Team activity: the Replied card reads "100% (8 of 8)".

## CLAUDE.md paragraphs

### Chat assignment (`lib/assignment/*`, migration 236)

One rotation engine for every automatic assignment:
`assignment_rotate_assign(account, conversation, pool_key, candidates)`
(service role) takes a per-account advisory lock and the conversation row
lock, refuses a chat that is personal, already assigned or
`human_engaged_at`, then picks the first eligible candidate after the
pool's stored `last_user_id` (`assignment_rotation_state`, wrap-around).
Eligible = live profile, not bank_guest or viewer, presence seen within
75 s (`OFFLINE_AFTER_MS` in `lib/presence.ts`: change both), and under
the chat limit when limits are on. Empty candidates = live agents and
team leaders by user_id. Nobody eligible assigns nobody and leaves the
position. Pool keys: `automation:<automation id>:<step id>`, `broadcast`.
Callers: the automation `round_robin` step, the broadcast first reply in
`inbound-pipeline.ts` (after `flagBroadcastReplyIfAny` and the call-history
pick, awaited in `after()`, never on `fanOut: false`) and Compass notify
(`assignment_compass_assign`: the case's agent plus a coordinator share,
only while `compass_assign_enabled`; off = notify never touches
ownership). Settings (`assignment_settings`, `assignment_chat_limits`) are
written only by `assignment_settings_set` / `assignment_chat_limit_set`
(owner/admin). `assignment_member_loads()` feeds the Assign menu.
`verify-assignment-rotation.sql`.

### Response times (`lib/response-times/*`, migration 237)

"Waiting" has one definition: `conversation_waiting_since(c)` =
`conversations.customer_waiting_since` on a company chat that is not
closed. The column is kept by the `messages_response_waiting` AFTER
INSERT trigger (a customer message starts a wait, any agent or bot
message that did not fail ends it; errors become WARNINGs), cleared on
close, and guarded against client writes. Business minutes come from
`business_minutes_between` / `response_business_minutes` (62-day scan
cap); `lib/response-times/hours.ts` mirrors them for display.
`response_escalation_sweep()` (automations cron, 5 min) rings
`response_target_missed` (assignee, at target), `response_escalated`
(team leaders, else owners/admins, at 2× target) and
`response_unassigned` (owners/admins), each once per wait through the
`response_escalations` ledger; waits older than 7 days are ignored.
The types live in `notifications_type_check`, `hrefFor`, `PUSH_KINDS`,
`kindGroup` and `NotificationType` (and `push_bell_url`, see Merge needs).
Off by default (`response_settings`, `response_settings_set`).
`verify-response-targets.sql`.

## Defaults chosen

- Everything automatic is off until an owner/admin switches it on.
- Rotation: online and away both count as available; offline = no
  heartbeat for 75 s. Viewers and bank guests are never picked. An empty
  people list means all live agents and team leaders.
- Existing automations with a round_robin step keep running (absent
  `enabled` = on) and now really rotate.
- Chat limit: 30 open (not closed) assigned company chats, range 1–500;
  a pool holds at most 500 people.
- Compass: the case is found by the event's reference (submission group →
  case) when its customer is the chat's contact, else the contact's single
  open case; several open cases → nothing assigned. The share uses the
  case's bank, else the coordinator's only bank. A Compass assign does not
  check `human_engaged_at` ("no assignee" only).
- Business hours Mon–Sat 09:00–18:00 Asia/Dubai, Sunday closed; target 15
  business minutes; escalation at 2× target. Any agent or bot reply ends a
  wait. Waits that began over 7 days ago never ring; ledger rows are kept
  14 days.
- Landing: agents and team leaders → `/worklist`; owners, admins, viewers
  → `/dashboard`; bank guests → `/chat`; a `next` deep link wins.
- Automation time-based trigger with no schedule saves `0 9 * * *`; a new
  time window is 09:00-18:00.
- Chat assignment people pickers offer live agents and team leaders (the
  SQL would accept owners/admins). The Assign menu's load is cached 15 s
  per account and user and refreshed when the menu opens.
- Worklist "Customers waiting": wall-clock wait ("Waiting 25 min") with the
  business-hours part underneath; reloads every 60 s; agents see their own
  and unassigned chats, "My team" = assignee in the team. Rows show the
  customer's name (else phone) — unlike 029c's ranked titles, which carry
  no names; the viewer already sees that chat under RLS. Dropping it is a
  one-line change in `waiting-customers.tsx`.
- Live view refreshes every 30 s while visible, plus on focus. "Replies
  today" = the person's non-failed agent messages on company chats since
  local midnight in the response-times zone (default Asia/Dubai).

### CLAUDE.md paragraph: Live view and waiting customers (migration 238)

`worklist_waiting_chats(p_limit)` (SECURITY INVOKER, so the conversations
policies decide) lists the active account's waiting chats by 237's
definition, oldest first, through `conversations_customer_waiting_idx`
(the query repeats the index's predicate: keep them equal).
`live_team_view()` (SECURITY DEFINER, team leader and up, 42501 below)
returns one jsonb for `/live`: owners/admins every live staff member plus
the unassigned waiting count, a leader the members of teams they lead
and themselves. Presence uses the 75 s rule of `lib/presence.ts`.
`/live` is guarded by `TeamLeaderOnlyLayout`. `verify-live-view.sql`.

## Merge needs

- `push_bell_url` (not ours) does not know `response_target_missed`,
  `response_escalated` and `response_unassigned`, so a phone push for them
  opens `/notifications`; the in-app bell opens the chat. Add the three
  types to its `conversation_assigned` / `insight_attention` branch
  (`coalesce(v_chat, '/notifications')`).
- Apply 236 as superuser/BYPASSRLS.
- `messages/*.json`, `settings-sections.ts`, `src/types/index.ts`,
  `data-map.ts` and `migrations.yml` are likely to conflict with other
  tracks; ours are new namespaces/sections appended in order.
- `workspaceHomePath` (logo, workspace switch) still points at
  `/dashboard`.

## Gate results

(filled in at the final push)
