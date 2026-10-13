# Changelog

User-visible changes in Taamul Connect (previously `wacrm`).
Self-hosters: when pulling an update, check this file for any
**migration required** notes and apply the matching SQL files from
`supabase/migrations/` against your Supabase project before restarting
the app.

Versions follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Pre-1.0, `MINOR` bumps cover new modules; `PATCH` bumps cover bug fixes
and polish.

## [Unreleased]

### Team chat: channel settings, mute and edit history

Channel admins, and workspace owners and admins (in a private channel
only as members), can now rename a channel, change or clear its topic,
archive and unarchive it from the gear menu in the channel header, and
remove members from the members panel; every change is audited.
Archived channels sit in a collapsed **Archived** group in the channel
list and open read-only. Anyone can mute a channel or DM from the same
menu: a muted chat rings the bell only for a direct @mention, is dimmed
in the list, and its plain unread no longer counts in the Team chat or
workspace badges. Owners and admins can view an edited message's
earlier versions. A viewer is told that agents and above open deal
rooms (it used to say "coming soon"), shared conversation cards open a
team leader's team inbox, and the audit log shows a channel edit's old
and new name and topic. See `docs/internal-chat.md`.

> **Migration required:** apply
> `supabase/migrations/091_chat_channel_admin.sql` as a superuser or
> BYPASSRLS role (re-runnable). It changes `chat_unread_counts`'s return
> type, so re-running 087 after it fails: re-run 091 afterwards.

### Workspaces: rename, and an audit log of membership changes

**Settings → Workspace** lets admins rename the workspace and change the
short name on its rail tile; the rail and headers update without a
reload (`PATCH /api/account` now accepts `short_name`). **Settings →
Audit log** gains a *Workspace* source: members added, removed,
re-roled, deactivated or reactivated, a bank guest's bank changing,
renames, ownership transfers, and team chat switched on or off. Only the
workspace's owners and admins can read it; it is append-only. See
`docs/workspaces.md`.

**Fixed:** Settings → Team chat's on/off switch failed with "permission
denied" for everyone (migration 057's column grants on `accounts`
predate the column).

> **Migration required:** apply
> `supabase/migrations/092_workspace_audit.sql` as a superuser or
> BYPASSRLS role (re-runnable).

### Notifications

The notifications page now lists every workspace's notifications, as
the sidebar badge counts them; a row from another workspace shows that
workspace's name, and opening it switches there and opens its screen.
Clicking a notification opens its screen for every kind: missed calls
and tasks the customer page, deal-room events the room, channel alerts
the WhatsApp settings (admins), team-activity alerts Team activity (team
leaders too). Each kind has its own icon. "Mark all read" covers what
the page lists.

### Fixed

- **Deal rooms:** a team leader can approve or reject a bank officer
  only in a room they manage (any team leader could, by id); a create
  that WhatsApp refused closes the form instead of inviting a second,
  duplicate room; join requests show in the open room as they arrive.
  > **Migration required:** apply
  > `supabase/migrations/095_deal_room_approve_scope.sql` (re-runnable).
- **Background jobs:** a once-a-minute job on the automations cron
  (journey tick, phone system) skipped a minute whenever the pinger's
  request landed a few milliseconds early, so it ran about every two
  minutes.
- **Error pages:** a crashed screen keeps the sidebar and offers *Try
  again*; an unknown address shows a 404 page with a link home (it used
  to be Next's bare default page).
- **Bank guests** no longer get a 403 from `/api/pbx/me` on every page.
- The invitation page's sign-in buttons are valid links (a button was
  nested in a link).

### Phone system (Yeastar) — pause storing recordings

Admins can pause the CRM's copies of call recordings, for a server
with little disk: **Store call recordings on this server**, the first
switch under **Recording rules** in the phone-system settings. While it
is off the CRM stops downloading recordings; nothing on the PBX
changes, and Yeastar keeps recording calls as before. Calls that end
meanwhile are not downloaded later, and the customer page shows
"Recording not stored in the CRM. It is still on the PBX." Recordings
already stored stay. See `docs/yeastar.md`, section 8.

> **Migration required:** apply
> `supabase/migrations/090_pbx_recording_storage.sql` (re-runnable)
> **before** deploying the app.

### Phone system (Yeastar) — browser softphone

Agents whose softphone is switched on can answer, decline and control
calls in the CRM tab through the Yeastar Linkus SDK for Web, which the
operator hosts (`NEXT_PUBLIC_LINKUS_SDK_URL`; the PBX's address goes in
`NEXT_PUBLIC_PBX_ORIGIN`, both build-time). Without it, calls keep
ringing the desk phone. The Content-Security-Policy now also allows a
self-hosted Supabase origin for media, so recordings keep playing once
the policy is enforced. See `docs/yeastar.md`, section 12.

### Phone system (Yeastar) — database

The database for the Yeastar P-Series phone system. Calls land on the
customer's timeline next to their WhatsApp chat (direction, number,
extension, ring and talk time, outcome and notes); an agent sees the
calls they were on and those of customers they can see, team leaders
and up every call of the workspace, bank guests none. Recordings are
kept in a private storage bucket no browser can read: every play is
logged, and playback is held until the English/Arabic recording notice
is confirmed played (a workspace can switch that requirement off). It
also holds PBX connections (credentials encrypted, service role only),
number routing, extension mapping, the live screen pop and presence.
The owner can erase a customer's call records on request, unless a
recording is under legal hold. Missed-call tasks come with the event
processor.

> **Migration required:** apply `supabase/migrations/089_pbx.sql`
> (re-runnable) **before** deploying the app.

### Deal rooms

A deal room is a real WhatsApp group on the workspace's verified Meta
number, made from the chat screen for one customer and, optionally,
one deal. The customer's consent is recorded before any group exists,
and a group holds at most 8 members including the business number.
People who opted out or are marked do-not-contact are refused.

- **Invites.** Each person gets the group's invite link in their own
  1:1 chat, as the group-invite template an admin picks in Settings →
  Deal rooms. A join request from an expected number is approved
  automatically; any other waits for the relationship manager.
- **Messaging.** Free text goes out inside the group's 24-hour reply
  window (any member's message opens it for everyone) and approved
  templates outside it. Files members send are saved to the deal file
  automatically.
- **Close room.** Saves a transcript to the deal file, removes everyone
  and deletes the group. A room stuck in "creating" is finished or
  failed by a background job (`/api/deal-rooms/cron`, also run every 2
  minutes by the automation cron).
- **Bank officers** can join only for a bank whose DSA terms an admin
  has checked, and an agent's bank officer waits for a team leader's
  approval. Members never see each other's phone numbers in the CRM,
  and a bank guest sees only the names, roles and messages of their own
  rooms. Each room also has a staff-only Team notes tab that never
  reaches the group.

Subscribe the Meta app to the four `group_*` webhook fields and use a
Meta number that is an Official Business Account; setup is in
`docs/meta-cloud-api.md` (Deal rooms).

> **Migration required:** apply `supabase/migrations/088_deal_rooms.sql`
> (re-runnable; re-apply if you applied an earlier copy — it gained the
> `deal_room_settings` table) **before** deploying the app.

Admin routes for the phone system: extension sync and mapping, number
routing to workspaces, recording settings and bank numbers
(`/api/pbx/*`, no new migration); operator notes in `docs/yeastar.md`.

Phone-system event processor and the signed webhook
(`POST /api/pbx/yeastar/events/{token}`): calls, the screen pop,
presence, recordings to fetch, and a task plus bell for each missed
call. `089_pbx.sql` gains `calls.recording_file` and `calls.meta`
(re-runnable; re-apply it if you applied an earlier copy).

### Phone system (Yeastar) — recordings, call-backs, cron

`GET /api/pbx/cron` (also run by the automations cron, once a minute)
copies pending recordings into private storage, dials due call-backs
between 09:00 and 20:00 Dubai time from the owner's free extension,
retries failed events (three times), and purges old rows. A call-back
left _dialing_ for 30 minutes with no result (a restart mid-dial, or a
lost call-end event) is released on the next run, at any hour: settled
from the call's record if it ended, left alone while the call is still
on, otherwise counted as one unanswered attempt. See
`docs/yeastar.md` (sections 7–10).

> **Migration required:** `089_pbx.sql` gained
> `pbx_events_raw.attempts` and `callback_requests.pbx_call_id`, and
> `pbx_purge()` now drops events that failed all retries after 30 days.
> Re-apply the file (it is re-runnable).

Calling from the CRM: call lists, this month's totals, team presence,
recording playback (5-minute links, downloads for team leaders and up,
every access logged, held until the notice is confirmed) and attaching
a recording to a deal as a reference; no new migration. See
`docs/yeastar.md` section 11.

### Internal team chat

Slack-style chat for the team, inside each workspace: open team
channels, private channels, direct messages and group DMs (up to 8
people), one-level threads, @mentions (including @channel and @here),
reactions, pins, saved messages, unread counts and search that works for
Arabic and English. A customer's WhatsApp conversation can be shared
into a channel as a read-only card; the card shows its live status only
to people who can open that chat in the inbox. Mentions and direct
messages ring the notifications bell. Nothing typed in a channel can
reach WhatsApp. Owners and admins can read a private channel they are
not in only through an audited action that records the reason, and an
owner can erase one person's messages on a lawful request. Internal
chat can be switched off per workspace.

> **Migration required:** apply
> `supabase/migrations/087_internal_chat.sql` (re-runnable)
> **before** deploying the app.

### Edge security for the WhatsApp webhooks

Both WhatsApp webhooks (Whapi and Meta) now screen every authenticated
delivery against Postgres stores that every app instance shares, so
limits and clocks agree across instances: replay keys per number (a
redelivery within 24 hours is skipped), 4 messages per second per sender
(a message over the limit is kept in the inbox but not auto-answered)
and an IP sanity limit. The webhooks never answer 429; a delivery whose
event another delivery is still processing is answered 503, so the
provider redelivers it. Behind a proxy, set `EDGE_CLIENT_IP_HEADER`
(`cf-connecting-ip` behind a Cloudflare tunnel) and, for
`x-forwarded-for`, `EDGE_TRUSTED_PROXY_HOPS`; see _Edge security_ in
`docs/whapi.md` and `docs/meta-cloud-api.md`. The automations cron
purges expired rows at most every 15 minutes (or schedule
`SELECT public.edge_purge()` with pg_cron); correctness does not depend
on it.

Sign-in now goes through `POST /api/auth/login`, which locks out 5
failures per email and IP, or 20 per IP, within 10 minutes for 15
minutes, before GoTrue sees the password; the login page shows "Try
again in N minutes". The public API locks out an IP that presents bad
keys the same way, answering `429 rate_limited`. See `docs/security.md`.

> **Migration required:** apply
> `supabase/migrations/084_edge_security.sql` (re-runnable)

### Journey bot: WhatsApp journeys from first message to closed deal

In the app: each customer's panel in the inbox shows their journey —
stage, reply window, next reminder and the advisor decisions that stage
accepts — next to their marketing consent and do-not-contact flag; a
**Journeys** page shows every journey by stage; and **Settings → Journey
bot** switches the bot on, checks which templates are still missing or
unapproved, and edits the bot's session messages and button titles.

The journey bot (module 016, "Welcome to Close") now answers on
WhatsApp for accounts whose admin switches it on (`enabled` in
`PUT /api/journeys/settings`):
it welcomes the customer, pitches a POS terminal, business account or
business loan, and walks them through quote or eligibility,
documents, the partner's decision and fulfilment, parking quiet
customers and re-engaging them once. Advisors record the steps only a
person can take — quote ready, fit, documents complete, partner
approved, close with a reason — through the new journey APIs
(`/api/journeys`, `/api/journeys/{id}/advisor`, `/api/journeys/start`
for a cold start, `/api/journeys/settings`). Marketing messages go
only to customers with a recorded opt-in, and STOP / UNSUBSCRIBE (and
the Arabic equivalents) opt out at any point. Contacts gain a consent
register beside the existing opt-out — a marketing opt-in, which
always names its source, and a do-not-contact flag — with an
append-only history. A STOP reaches the contact's opt-out at once,
even while the journey bot is off, and only an admin can change or
clear a do-not-contact. "Call me back" opens an advisor task and queues
a callback request for click-to-call. Timers and quiet-hours sends run
from `GET /api/journeys/cron`, which the automation cron also runs
every minute. The templates the bot needs, its timing and consent
rules are in `docs/journey-bot.md`.

> **Migration required:** (re-)apply
> `supabase/migrations/086_journeys.sql` — it is re-runnable and has
> gained columns since it was first published (journey copy, delivery
> claims).

### Workspaces: one login, several businesses

A workspace rail at the far left of the sidebar shows every workspace
you belong to (with unread chat badges); click one to switch, or use
**+** (owners and admins) to create a workspace and invite its first
people, choosing Admin, Team leader, Agent, Viewer or Bank guest.

A person can now belong to more than one workspace (account) — for
example Taamul Credit and TrafeeqPay — with a separate role in each,
and switch between them. Each workspace keeps its own contacts, chats,
numbers and settings apart: everything you see follows the workspace
you are working in. Teams and number allocations survive switching.
An existing login can be added by email only by an owner or admin of a
workspace that person is active in, and someone removed from their only
workspace leaves as a viewer (a bank guest as a guest) of an empty one,
never its owner.
An owner or admin can create a new workspace and add its first people
in one step, and adding a member by an email that already has a login
adds that person to your workspace, with no new password.

Someone in more than one workspace switches from the sidebar; the app
reloads in the chosen workspace, and other open tabs follow. See
`docs/workspaces.md`.

A new role, **Bank guest**, is for bank officers invited into deal
rooms and channels: a guest sees none of the inbox, contacts, deals or
settings.

> **Migration required:** apply
> `supabase/migrations/082_account_role_bank_guest.sql` and then
> `supabase/migrations/083_workspaces.sql` (both re-runnable, in that
> order, each in its own run — 082 adds an enum value that 083 uses)

### Tasks: call-backs and follow-ups on contacts

A shared task list for the follow-ups that used to live in someone's
head or a chat note: call a customer back, chase a document, follow
up on a deal. A task has a title, an optional note and due date, an
assignee, and can be linked to a contact, a chat and a deal. People
create tasks themselves; the phone system (a missed call) and the
journey bot (an advisor step) open them automatically, once per
event, so a redelivered webhook never opens a second task. Assigning
a task to someone else rings their bell; assigning it to yourself
does not. A task follows its customer the way chats do: you see the
tasks you hold or created and those on contacts you can see, a team
leader also their team's, admins every task. See `docs/tasks.md`.

> **Migration required:** apply
> `supabase/migrations/085_tasks.sql` (re-runnable)
> **before** deploying the app.

### AI agent: approved answers only, and a sensitive-data warning

A new answer mode for the auto-reply bot, **Approved answers only**:
the bot never writes text. It sends one answer an admin approved, word
for word, or hands the chat to a person. Answers are imported from the
review spreadsheet (sheet `Knowledge_Base`); only rows marked Approved
are ever sent, and an answer still saying `[TO CONFIRM …]` cannot be
approved. A file without a Status column that edits an approved answer
files it as To confirm until it is approved again. TypeSafe picks the answer from a shortlist; a pricing, legal
or angry message, a weak match (below the minimum score, 0.8 by
default), a missing Arabic answer, or TypeSafe being unavailable all
hand the chat to a person. Answers for internal staff never reach
customers. The mode needs `TYPESAFE_API_KEY` and the account in
`TS_ACCOUNT_IDS`. See `docs/ai-agent.md`.

In either mode, an optional **sensitive-data reply** is sent instead of
an answer when a customer shares an Emirates ID, a card number or an
IBAN. The default mode and settings are unchanged.

> **Migration required:** apply
> `supabase/migrations/081_approved_answers.sql` (re-runnable)
> **before** deploying the app.

### AI safety check: no Central Bank or bank/lender claims

The AI reply guardrail now holds, for a person to review, any draft
that describes the business as registered with, licensed or regulated
by the Central Bank of the UAE (CBUAE), or as a bank or a lender —
in English or Arabic, whatever the knowledge base says (reason
`CODE_REGULATOR_CLAIM`). The one rewrite is told to describe the
business as a Dubai-based financial broking firm and Direct Sales
Agent working with UAE partner banks. No migration.

### Tagged campaign chats move to the Inbox

A chat in **Broadcasts → Campaign inbox** now moves to the **Inbox**
as soon as it is given a chat tag, and stays there while it carries
one — tagging a chat is filing it for the team. This covers tags set
from the chat header and by automations and Flows; removing the tag
puts a chat the bot is still answering back in the Campaign inbox.
Chats that already carry a tag move on upgrade. No migration.

### Broadcast audiences from Excel files

The broadcast wizard's **Upload CSV or Excel** audience now takes an
Excel `.xlsx` file as it is (the first sheet), so an export no longer
has to be re-saved as CSV — which is where long numbers turned into
`9.71505E+11`. Headers such as **Phone Number**, **Customer Name** and
**Company Name** are recognised alongside `phone`, `name` and
`company` (also when importing contacts from CSV), and every column
can still be mapped to a template variable. Rows without a phone
number are skipped and counted. A new option, **Numbers without a
country code are UAE mobiles (add +971)**, off by default, accepts
locally written UAE mobiles (`050 123 4567`, `501234567`); without it
they are refused as before. Old `.xls` workbooks are refused with a
request to save as `.xlsx` or CSV. No migration.

### Pipelines for every member, and deals from chat tags

Pipelines is now in every member's sidebar. Each deal belongs to one
person: its assignee, else whoever created it. Admins and owners see
every deal and can narrow the board to one person with **Showing**; a
team leader sees their own deals and their teammates' (**My team**,
**My deals**, or one teammate); everyone else sees only their own. The
database enforces this (`can_view_deal`), so the contact panel and the
dashboard's pipeline figures follow the same rule. Agents create and
reassign deals for themselves only, leaders for their teammates too.
Creating pipelines and editing stages stays admin-only.

In **Manage pipeline** an admin can link a stage to a main chat tag
(**Auto-add chats tagged**). When a chat is given that tag, with or
without a sub-tag, a deal is created in that stage for the chat's agent
(the person it is assigned to or who started it, else whoever tagged
it). The deal is never moved by later tagging, and no second deal is
made while the contact has an open one in that pipeline. Tags set by
automations and flows count too.

> **Migration required:** apply
> `supabase/migrations/080_pipeline_ownership_and_tag_deals.sql`
> (re-runnable) **before** deploying the app. Then link the stage you
> want (e.g. New Lead ← Interested customer) once in Manage pipeline.

### Settings reorganised

Settings is now a row of category tabs, each with sub-tabs. The URL is
`?tab=<sub-tab id>`; AI Agents uses `?tab=ai-<tab>`.

- **Overview**
- **My account**: Profile, Login & security, Appearance
- **WhatsApp**: Connections, Numbers & access, Routing, Templates,
  Message costs
- **Inbox**: Chat tags, Quick replies, Custom fields
- **Team**: Members, Teams
- **AI Agents**: Overview, Assistant, Auto-reply, Knowledge, Safety
  checks, Playground, Usage. The sidebar "AI Agents" link redirects here.
- **Integrations**: API keys, Deals & currency

Renames: "AI safety checks" is now Settings → AI Agents → Safety checks
(Partner banks sits under it); "Which number sends what" is Settings →
WhatsApp → Routing; the old AI Agents "Setup" is split into Assistant,
Auto-reply and Knowledge.

One home per setting, so duplicates are gone: team number access is set
only in Numbers & access (Settings → Teams shows it read-only); removing
a Cloud API number is in Numbers & access, like a Whapi one; the AI's own
number moved from Routing to AI Agents → Auto-reply → Reply on; the team
leader is offered the same way everywhere; Settings → Quick replies is
translated.

AI Agents fixes in the same release:

- Leaving AI Agents with unsaved changes (for another Settings tab, or
  by a link) asks first; moving between AI Agents tabs keeps the edits.
- **Reply on → Only on** always pins the AI to one number: Save writes
  the picked number (the default number when none was picked) as the
  AI's route. An account that never saved a route is not pinned, and
  its Overview now says so: "The default number and others of its
  type", not "Only on the default number".
- The embeddings key has a **Remove key** button (with a confirm).
  Focusing the masked key field no longer deletes the stored key on the
  next Save, and a blank key field never clears a key.
- On a phone the Settings and AI Agents tab rows fade at the edge where
  more tabs are hidden, and keep the active tab in view.

No migration required. Docs paths updated in `docs/`.

### Reply on every WhatsApp number

Settings → AI has a switch, **Reply on every WhatsApp number**. On, the
AI answers each chat on the number the customer wrote to (Whapi or Cloud
API); off, only on the number routed for AI auto-reply. A chat a person
pinned to another number is skipped. Settings → WhatsApp → Which number
sends what hints when the switch is on. See
[docs/ai-agent.md](./docs/ai-agent.md).

> **Migration required:** apply
> `supabase/migrations/079_ai_reply_all_numbers.sql` (re-runnable)
> **before** deploying the app. The bot tolerates a pre-079 database (it
> keeps answering on its routed number), but Settings → AI fails to load
> until 079 is applied.

### Partner banks, Important chats and open-question retrieval

Each account sets its own partner banks, chats the AI hands over are
pinned in the Inbox until a person acts, and the bot retrieves for the
customer's open question rather than only the last message. See
[docs/typesafe.md](./docs/typesafe.md) and
[docs/ai-agent.md](./docs/ai-agent.md).

> **Migration required:** apply
> `supabase/migrations/078_partner_banks_and_attention.sql`
> (re-runnable) **before** deploying the app. It adds
> `ts_account_settings.partner_banks` and `conversations.ai_attention_at`,
> and extends the 077 reply trigger to clear it. Without it, partner
> banks fall back to the built-in list (saving one answers "Partner
> banks need database migration 078") and the Important pin never
> shows, but a hand-off, **Take over**, **Resume** and sending or
> discarding a held draft also write `ai_attention_at`, so on a pre-078
> database those writes fail: the hand-off is not saved (the chat is
> not paused and gets no note) and the Take over, Resume and draft
> buttons return an error. Apply it without `-1` so the backfill does
> not hold table locks.

- **Partner banks.** Settings → AI safety checks → Partner banks: tick
  built-in banks (default Mashreq, RAKBANK, NBF, Wio, Ruya, UBL), add
  others with their abbreviations, or take suggestions from _Found in
  your knowledge base_. The guardrail blocks a draft naming any other
  bank, and the bot is told the list. Uploading a bank's documents does
  not make it a partner.
- **Important chats.** A chat the AI hands over is pinned at the top of
  the Inbox with a red Important label, an _Important · N_ filter, and a
  red bar with Take over and Resume. A person replying, taking over,
  resuming or acting on a held draft clears it.
- **Open-question retrieval.** Knowledge lookup uses every customer
  message since the bot last spoke; a "Hi" after an unanswered question
  still retrieves for the earlier question.
- **Changed.** Hand-off notes read as plain sentences ("🤖 AI needs a
  person ...").

### AI agent v2

The auto-reply bot gains model tiers with per-message routing, a
rewrite-then-review path for held drafts, pause and resume around people
replying, and a record of why it did or did not answer. See
[docs/ai-agent.md](./docs/ai-agent.md).

> **Migration required:** apply
> `supabase/migrations/077_ai_agent_v2.sql` (re-runnable) **before**
> deploying the app. The new code selects the new `ai_configs` columns,
> so on a pre-077 database the AI config load fails and the bot stops.
> It adds the Small and Large model tiers (filled once for existing
> accounts from the provider), the pause and auto-resume settings,
> `conversations.ai_paused_reason`, the held-draft columns, the
> `ai_reply_events` table and the `ai_handoff` notification type. Apply
> it without `-1` so the backfills do not hold table locks.

- **Model tiers.** Settings → AI has Small, Standard and Large models.
  *Route each message to the right model* (on by default) lets
  TypeSafe Jev judge each message in parallel with triage; without
  TypeSafe a simple rule decides. Greetings skip knowledge retrieval,
  but only when every customer message since the bot last spoke is
  one: "Hi" after an unanswered question retrieves for that question.
  Urgent or ready-to-apply customers never get the Small model. A model
  the provider rejects is retried once on the Standard model.
- **Held drafts.** A draft the TypeSafe guardrail holds is rewritten
  once by the Large model; if it is still held, the chat goes to a
  person with the draft in the inbox banner (Send draft, Edit, Discard).
- **Pause and resume.** A person replying in a chat pauses the bot
  there. *Give the chat back to the AI after* resumes it on the
  customer's next message. Hand-offs and Take over never auto-resume.
  The banner shows why the bot is paused and offers **Resume & reply**.
- **Why didn't the AI reply?** Every dispatch records an outcome; the
  banner says why the last message went unanswered, and Settings → AI
  shows a 7-day activity card.
- **Fixed.** The bot no longer stands down for every message when any
  keyword automation exists, only when one matches. Two quick messages
  get one reply that answers both (`AI_BURST_WAIT_MS`, default 3 s). A
  WhatsApp send failure after the bot drafted a reply now hands the chat
  to a person. Hand-offs ring a bell for owners and admins when no
  hand-off agent is set.

Adds an optional **second WhatsApp number** on Meta's Cloud API,
alongside the existing Whapi channel, with an admin selector for which
number sends what.

> **Migration required:** apply
> `supabase/migrations/046_multi_channel_whatsapp.sql` (lets
> `whatsapp_config` hold one row per provider per account, records which
> number carried each message, and adds the `whatsapp_routes` table
> behind the selector). Existing installs keep working unchanged: the
> single connected channel becomes the account default and every task
> inherits it.

> **Migration required:** also apply
> `supabase/migrations/047_ai_knowledge_fts_any_term.sql`. Keyword
> search over the AI knowledge base previously required _every_ word of
> the customer's question to appear in a chunk, so a natural question
> almost never matched and accounts without an embeddings key ran the
> bot with an effectively empty knowledge base.

> **Migration required:** and
> `supabase/migrations/048_campaign_conversations.sql`, which records on
> each conversation the campaign the customer replied to. The Campaign
> inbox and the bot's campaign context both read it.

> **Migration required:** and
> `supabase/migrations/049_ai_auto_reply_campaign_only.sql` for the
> _Campaign replies only_ switch on the AI agent (off by default).

> **Migration required:** and
> `supabase/migrations/050_contact_card_messages.sql`, which adds the
> `contacts` message type and the `contact_cards` column that shared
> contact cards are stored in.

> **Migration required:** and
> `supabase/migrations/051_whatsapp_message_costs.sql` for the
> message-cost ledger behind Settings → Message costs (the rate card,
> the market map, the per-message ledger and its reporting views).
> Optional afterwards: load Meta's full rate card with
> `scripts/load-meta-rate-card.ts`.
>
> If you applied 051 before this change, **apply it again** — the file
> is re-runnable and `record_whatsapp_message_cost` has been corrected
> (see _Fixed_ below). Deliveries already in the ledger keep the
> category and cost they were written with; re-run only affects
> receipts that arrive afterwards.

> **Migration required:** and
> `supabase/migrations/052_ai_escalation_gates.sql` for the escalation
> gates on the AI agent (keyword list, retrieval threshold, strict
> grounding, handoff message, the handoff reason on conversations, and
> the `ai_knowledge_gaps` log). Every gate is off by default, so an
> existing install behaves as before until an admin turns one on.

> **Migration required:** and
> `supabase/migrations/053_broadcast_scheduling.sql` for scheduled
> broadcasts and quiet hours (`header_media_url`, `quiet_hours`, and
> the index the scheduler reads). **Scheduled campaigns are delivered by
> `GET /api/whatsapp/broadcast/cron`** — point your pinger at it
> alongside the automation and flow crons, same `x-cron-secret`
> header. Until it is pinged, a scheduled campaign stays _scheduled_
> and its page offers _Send now_.

> **Migration required:** and
> `supabase/migrations/054_campaign_flow_continuation.sql` for
> campaigns that continue as a conversation (`follow_up_flow_id` on
> broadcasts, `broadcast_id` on flow runs, and the `cap` handoff
> reason). Existing campaigns and flows behave exactly as before until
> a campaign is pointed at a flow or a flow's off-script setting is
> changed — with one exception noted under _Changed_: the AI agent now
> hands off at its reply cap instead of going silent.

> **Migration required:** and
> `supabase/migrations/055_message_forwarding.sql`, which adds
> `messages.is_forwarded`. Both webhooks and every outbound send write
> it, so **apply it before deploying this build** — without it every
> message insert fails.

> **Migration required:** and
> `supabase/migrations/056_compass_integration.sql` for the Taamul
> Compass integration (the `compass_contacts` and
> `compass_notifications` tables). Nothing else depends on it; until it
> is applied only the `/api/v1/compass/*` endpoints and the Taamul
> Compass screen fail.

> **Security — action required on every self-hosted install:** disable
> public signup in GoTrue (`DISABLE_SIGNUP=true`,
> `ENABLE_PHONE_SIGNUP=false` in a self-hosted Supabase `.env`, or turn
> off "Allow new users to sign up" in the dashboard), then restart the
> auth service. The app has no signup screen, but GoTrue's own
> `/auth/v1/signup` stays open by default and hands anyone with the
> public anon key a session — and, before 057, a phone signup could
> use it to make itself owner of any account. Members are provisioned
> with the service role and keep working. See `docs/docker.md`.

> **Migration required:** and
> `supabase/migrations/057_security_hardening.sql`. Closes schema holes
> reachable with the public anon key: profile self-insertion into any
> account, anonymous listing of every tenant's files in the
> `chat-media` / `flow-media` / `avatars` buckets, a cross-tenant read
> of the AI knowledge base (047 had undone 032's fix), and
> `SECURITY DEFINER` helpers any client could call to exhaust a
> conversation's AI reply cap, disable a webhook or rewrite broadcast
> counters. Also makes `ai_configs`, `webhook_endpoints` and
> `api_keys` admin-only to read, scopes `flow_runs` and
> `broadcast_recipients` like the conversations they describe, and
> stops an agent opening a thread on a contact they can't see.

> **Migration required:** and
> `supabase/migrations/058_dashboard_aggregates.sql` — the dashboard
> charts are now computed in SQL instead of downloading every message
> of the last 30 days into the browser (which was also silently wrong
> past 1,000 rows). **Apply before deploying this build**, or the
> dashboard charts fail to load.

> **Migration required:** and
> `supabase/migrations/059_rls_performance.sql`. Rewrites the
> conversations / messages / contacts row-level-security policies so
> Postgres can use an index on `account_id` instead of scanning every
> tenant's rows and calling the visibility function per row — who can
> see what is unchanged — and adds the indexes the inbox, thread,
> contacts list and inbound webhook were missing.

> **Migration required:** and
> `supabase/migrations/060_whatsapp_channel_access.sql` for multiple
> Whapi numbers. It lets `whatsapp_config` hold any number of Whapi rows
> (the Meta number stays one per account), records the exact number on
> every conversation and message (`channel_id`), and adds
> `whatsapp_channel_members` plus the visibility rule behind number
> allocation. **Apply before deploying this build**: the send and
> inbound paths write `channel_id`. Existing installs are unchanged
> until an admin allocates someone to a number, because a number with
> nobody on it stays shared.

> **Migration required:** and
> `supabase/migrations/061_conversation_send_channel.sql` for choosing
> a chat's sending number. It adds `conversations.send_channel_id`, the
> `conversation_events` table (the notes in the thread) and the
> `set_conversation_send_channel` function, and extends the visibility
> rule. **Apply before deploying this build**, because the send path
> reads `send_channel_id`. Every existing chat stays on automatic.

> **Migration required:** and
> `supabase/migrations/062_channel_access_hardening.sql`, from a
> security and correctness review of 060 and 061:
> - Allocations and a chat's number or pin are tied to their own
>   account by composite foreign keys.
> - The number guards now run when a chat is created, not only when it
>   is edited.
> - A pin can only be set through the chat's number picker, so every
>   pin leaves a note.
> - Signed-in users can no longer insert customer messages.
> - Access lists and the default number are each saved in one
>   transaction.
> - The visibility check is one flat function again, for speed.
> - A tiny index backs the media proxy's new visibility check.
>
> **Apply before deploying this build**, because the app calls
> `set_channel_members` and `set_primary_channel`.

> **Migration required (before deploying this build):** apply
> `supabase/migrations/065_channel_health_notifications.sql`. It lets
> the notifications table hold the new *number disconnected* /
> *number reconnected* alerts. Without it no alert can be stored:
> each sweep marks a logged-out number disconnected, cannot save the
> alert, puts the status back and logs `[channel-health] … the alert
> was not saved`, so the number keeps showing connected; a number that
> comes back is marked connected without its notice.

> **Migration required (before deploying this build):** apply
> `supabase/migrations/066_broadcast_status_reconcile.sql`, then run
> once, as postgres, `SELECT public.reconcile_broadcast_recipient_statuses(NULL, '60 days');`
> to repair older campaigns. It adds
> `reconcile_broadcast_recipient_statuses()`, which replays Meta's cost
> ledger onto broadcast recipients a delivery receipt missed (a receipt
> that arrived before the recipient was recorded left it at *sent*),
> stores Meta's failure reason on failed recipients, and marks a
> campaign whose recipients all failed later as *failed*. The app runs
> it after each delivery pass and on every broadcast cron tick, and
> skips it quietly until the migration is applied.

> **Migration required:** apply
> `supabase/migrations/076_contact_opt_out.sql` (re-runnable) **before**
> deploying the app. It adds `contacts.opted_out_at` (when a customer
> asked not to be messaged) and fills it from any existing `opted-out`
> contact tag. Every broadcast now leaves those customers out, and only
> an admin (or the AI bot) can set or clear the mark. The
> `tags` / `contact_tags` tables are left in place, unused.

> **Migration required:** apply
> `supabase/migrations/075_chat_tags.sql` (re-runnable) **before**
> deploying the app. It adds the `chat_tags` table (admin-defined,
> colour-coded main tags with optional sub-tags, one level deep) and
> `conversations.chat_tag_id` / `chat_sub_tag_id`. A chat carries at
> most one main tag and one sub-tag of it; the database refuses any
> other pair, and switching a chat's main tag drops its old sub-tag.
> Deleting a main tag deletes its sub-tags and clears them from every
> chat. Members read the list, admins and owners edit it.
> `conversations.status` is unchanged, so automations and the public
> API keep working as before.

> **Migration required:** apply
> `supabase/migrations/073_team_activity_accuracy.sql` and then
> `supabase/migrations/074_team_activity_team_leaders.sql` (both
> re-runnable), before deploying the app.
> - 073 corrects the Team activity figures. Its one-time backfill fills
>   `messages.channel_id` / `conversations.channel_id` where the number
>   was unambiguous at the time.
> - 074 opens the report to team leaders, scoped to their team, and adds
>   `team_activity_alerts.recipient_id`.
>
> The new page reads keys that only 073 and 074 produce, and team leaders
> are refused without 074.

> **Migration required:** apply
> `supabase/migrations/072_allocation_grants_no_visibility.sql`
> (re-runnable). It replaces `can_view_conversation` and
> `can_view_contact` so that allocation to a WhatsApp number (directly
> or through a team) no longer shows a member every chat on it. Apply it
> together with the app: the inbox no longer assumes allocated agents
> see other people's chats.

> **Migration required:** apply
> `supabase/migrations/071_team_number_allocation.sql` (re-runnable)
> **before** deploying the app. It adds `whatsapp_channel_teams`, the
> `direct` / `via_team` flags on `whatsapp_channel_members`, the triggers
> that keep team-derived access in step with team membership (and drop
> a removed member's teams and allocations), and the atomic
> `update_team` / `set_channel_access` RPCs the Teams and Numbers &
> access saves now use, over `set_team_members` / `set_channel_teams` /
> `set_team_channels`. Without it, Settings →
> Numbers & access and Settings → Teams fail to load (500).

> **Migration required:** apply
> `supabase/migrations/070_contact_avatars.sql` (re-runnable). It adds
> `contacts.avatar_checked_at`, which throttles profile-picture lookups
> to one per contact per week. Until it is applied the inbox keeps
> showing initials, and its picture request answers 500 (logged, not
> shown).

> **Migration required:** apply
> `supabase/migrations/069_member_deactivation.sql` (re-runnable). It
> adds `profiles.deactivated_at` / `deactivated_by`, the
> `set_member_active` RPC, and makes the RLS role helpers ignore a
> deactivated member. The app reads the new column defensively, so an
> older database keeps working; the Deactivate button needs 069.

> **Migration required (before deploying this build):** apply
> `supabase/migrations/068_team_activity.sql` (`psql -v ON_ERROR_STOP=1
> -f …`; re-runnable). It adds the Team activity limits
> (`team_activity_settings`), the alert log behind the once-a-day bell
> alerts, the `team_activity_alert` notification type, and the report,
> drill-down, per-person, send-check and alert-sweep functions. The
> send path asks `team_activity_start_check` before a person's message
> on a Whapi number and lets the message through if it is missing, so
> an older database keeps sending; the page itself needs 068.

> **Migration required (before deploying this build):** apply
> `supabase/migrations/067_conversation_human_engaged.sql` statement
> by statement (not with `-1`). It adds `conversations.human_engaged_at`,
> which triggers set the first time a conversation is assigned or a
> person sends a message in it, and fills it in for conversations
> people are already on; and `ai_auto_reply_live()`, which tells any
> member whether the bot is on. The Inbox, the Campaign inbox and the
> Inbox's unread dot all read both, and fail to load without them.

> **Migration required (before deploying this build):** apply
> `supabase/migrations/064_typesafe_account_settings.sql` as one
> transaction, after 063. It adds `ts_account_settings`, the
> per-account switches behind Settings → AI safety checks; the
> `ts_decision_log.intervened` column and `ts_activity_summary()`,
> which the panel's activity view reads; and an index the opt-out watch
> uses. No row means off, so nothing changes until an admin switches
> the layer on.

> **Migration required (before deploying this build):** apply
> `supabase/migrations/063_typesafe_decision_layer.sql` as one
> transaction (`psql -1 -v ON_ERROR_STOP=1 -f …`). It adds:
> - per-account threshold policies with two-person activation, enforced
>   on every path, and a one-admin emergency stop (`ts_retire_policy`);
> - an append-only decision log, labels, and the usage and
>   label-agreement views;
> - two new AI hand-off reasons, `triage` and `guardrail`.
>
> It also changes `claim_ai_reply_slot` to refuse a thread that was
> handed off or assigned while a reply was being drafted. With
> `TYPESAFE_API_KEY` set, this build reads 063's and 064's tables on
> every inbound message, so apply both first.

### Added

- **One tag system: chat tags replace contact tags everywhere.** The
  older contact tags are gone from every screen — the contact panel,
  the chat list's filter, the Contacts page, contact form and import,
  and Settings (*Fields & tags* is now **Custom fields**; old
  `?tab=tags` links open Chat tags). Their jobs use chat tags instead:
  **broadcasts** go to, or exclude, everyone with a chat tag or a
  sub-tag such as *Interested · ADCB*; **automations** gain the
  trigger *Chat tag set*, the step *Set chat tag* and the condition
  *Has chat tag*; **flows** set and branch on chat tags; the **Contacts
  page** shows and filters by each contact's chat tag. In the public
  API, conversations carry `chat_tag` and `chat_sub_tag`; contacts keep
  a deprecated `tags` field that is always empty (`tags` sent on create
  or update is ignored, and `?tag=` returns nothing), plus a new
  `opted_out_at`. The MCP tools drop their tag parameters.
- **Opted-out customers are skipped automatically.** When a customer
  asks the AI bot to stop, they are marked **Opted out** (a badge in
  the contact panel and on the Contacts screens), and every broadcast
  leaves them out — the wizard shows how many it skipped, and a
  customer who opts out after a campaign was planned is skipped when it
  sends. Before, they were only tagged, and an admin had to exclude the
  tag by hand.
- **Chat tags, in place of Open / Pending / Closed.** Admins set up
  colour-coded tags in **Settings → Chat tags** — for example *New
  customer*, *Interested customer*, *Not interested* — in the order
  they want. A main tag can have sub-tags with a heading of its own,
  such as *Interested customer* → **Bank**: ADCB, Emirates NBD, FAB. In
  a chat, the tag sits under the customer's name: pick one main tag,
  and if it has sub-tags the sub-tag menu opens straight away
  ("Bank: ADCB"). A chat carries one main tag and one sub-tag of it;
  switching the main tag drops the old sub-tag. The chat list shows
  each chat's tag and filters by main tag or sub-tag (Open / Pending /
  Closed filters are gone; the status itself is kept for automations
  and the public API). Agents and up tag the chats they can see;
  viewers can't. (Contact tags were later retired in their favour;
  see above.)
- **A chat's tag and sub-tag read as one pill.** In the chat header and
  the chat list, the main tag is the bold, tinted half and its sub-tag
  is joined on the right in a lighter tint of its own colour
  (*Interested customer* | ● ADCB), so the two are never mistaken for
  two separate tags; the sub-tag's heading (*Bank*) shows on hover. Tag
  text takes a shade of the tag's colour. In the list the pill sits on
  the right of each row, beside the unread count, and may take most of
  that line: the message preview shortens first.
- **A rebuilt chat header.** Two rows: the customer (photo, name,
  number — on desktop, click it to open or close the contact panel),
  the sending number, who is on the chat and the refresh and panel
  buttons; then the chat's tags. In a narrower chat the sending number
  shows just its name (its phone joins once there is room), your own
  chats read "Me" and long names truncate, so the customer's name keeps
  its room; tooltips and menus show everything in full.
- **Broadcasts to Compass customers.** The broadcast wizard's audience
  step has a fifth option, *Compass contacts*: pick an order (top or
  bottom of the Compass list, newest or oldest added, name A→Z or Z→A),
  a start position and how many numbers — e.g. 100 numbers from the
  bottom of the list. The step shows which numbers it will take ("1–100
  of 4,213"), and the personalize step can map a template variable to
  any Compass field, ERP attributes included. Only customers with a
  phone number count; numbers that fail the contact rules are skipped,
  and recipients become CRM contacts owned by the admin who sends.
  Exclude tags and the frequency cap apply as for any audience. A slice
  over 1,000 numbers that Compass changes while it is being read is
  refused, with nothing sent, rather than sent to the wrong people.
- **Team activity for team leaders.** A team leader can open Team
  activity and sees only their own team. In the bell, they are told when
  someone in their team reaches the daily new-chat limit.
- **Team activity in plain language.** The page now starts with "Needs
  attention today", one card per person or number. Below that are three
  everyday figures with what "safe" looks like, then a card per person
  with a traffic light and one line of advice, and phone numbers with a
  new-chats-today bar. The charts and a "How we count" explanation are
  folded away.
- **Allocate a WhatsApp number to a team.** In Settings → Teams (or the
  Teams section of Settings → Numbers & access), tick the numbers a team
  works. Everyone in the team and its leader get the number, as if
  allocated one by one. Someone who joins the team gets it, and someone
  who leaves loses it, unless they were also allocated by name.
- **Settings → Teams redesigned:** an overview of each team's leader,
  members and numbers, plus who is not in a team yet. Teams are edited in
  a side panel with search, renaming and an explicit Save.
- **WhatsApp profile pictures in the inbox** for chats on Whapi numbers:
  the chat list, the thread header and the contact panel show the
  contact's photo instead of an initial. The picture is copied into your
  own storage (WhatsApp's links expire) and refreshed weekly; a contact
  who hides their picture, or who only wrote to the Meta number, keeps
  the initial. See `docs/whapi.md` → Profile pictures.

- **Deactivate a member** (admins, Settings → Team members). A
  deactivated person stays on the roster with their role, chats and
  history, but cannot sign in: their Supabase Auth login is banned, an
  open session is signed out, and RLS returns them nothing even on an
  access token issued before the switch. Reactivate gives access back.
  The owner and your own row can't be deactivated, and deactivated
  members are no longer offered as assignees or picked by round-robin.

- **Team activity** (admins, sidebar → Team → Team activity). Per person and
  per WhatsApp number, for today, yesterday or the last 7, 30 or 90
  days: chats started (and how many with new contacts), how many got no
  reply and the reply rate, messages sent, messages piled on contacts
  who stopped answering, failed sends, response time, customers waiting
  now, broadcasts, the busiest day, the fastest 10 minutes, chats
  started at night, links in a first message and the same opener sent
  to many people. Each person and number gets a status (OK, Watch, At
  risk) with what to fix and what to tell them, and a click opens the
  chats behind the numbers. Whapi numbers also show Whapi's own Safety
  Meter rating. See `docs/team-activity.md`.
- **Warnings before a risky message.** On a Whapi number the inbox
  composer (and Contacts → Send message) warns as a person nears their
  daily new-chat limit, when they or the number reach it, and when the
  contact has not answered the last few messages. Once an admin has
  saved the limits, owners, admins and the person get a bell alert,
  once a day, when someone goes over the limit or a number reaches its
  own. An admin can also switch on **Block new chats over the limit**,
  which refuses (with a clear error) a person's message that would
  start a chat past the limit. Replies always go out, including a late
  answer to a customer who wrote last, and owners and admins are never
  blocked. The per-person limits count chats started on Whapi numbers
  only.
- **WhatsApp number health monitor.** Every five minutes (from the
  automation cron, or `GET /api/whatsapp/health/cron`) each Whapi
  number is probed without waking it. When one is logged out or its
  token stops working it is marked *disconnected* and every owner and
  admin gets a notification that says what to do and who does it (scan
  the QR code at panel.whapi.cloud on the phone that holds the number);
  another notification follows when it is back. The inbox warns above
  the composer while a chat's number is disconnected.
- **Failed replies can be retried.** A reply WhatsApp refused stays in
  the thread as *Not sent*, with Retry and Discard, and a failed text
  goes back into the composer. Retry is offered only when the gateway
  definitely refused the send, never when it may have gone out.
- **Contact numbers are checked where people type them** (contact form,
  contact screen, CSV import, the broadcast CSV upload, `POST
  /api/v1/contacts`, Compass contact sync): spreadsheet notation
  (`9.71505E+11`), a number without a country code, fewer than 10
  digits, and malformed +971 numbers are refused with a message asking
  for the country code. A number saved without it used to take the
  customer's inbound messages while every reply went to a WhatsApp
  address that does not exist.
- **Settings → WhatsApp flags webhooks that are not this CRM's**, since
  they receive every message on the number.
- **Settings → AI safety checks.** Admins switch the TypeSafe layer on
  and off for their account, choose **Monitor only** or **Live**, pick
  the checks and the languages it may act on, and see what it did: a
  seven-day summary (hand-offs, opt-outs, replies held or blocked,
  excerpts removed, outages, cost, latency) and every decision, with
  the contact. The server now needs only `TYPESAFE_API_KEY` and
  `TS_LOG_HASH_KEY`; `TS_ACCOUNT_IDS`, `TS_ENABLED_*` and `TS_SHADOW`
  became optional install-wide overrides (`TS_SHADOW` defaults to
  `false`). **Live** acts on the built-in thresholds unless two admins
  approved custom ones.
- **Opt-outs are caught on every conversation**, not only the ones the
  bot answers. When *Watch conversations your team handles* is on (the
  default), an inbound message the bot did not judge is triaged after
  every reply has gone out, and in Live a clear opt-out tags the
  contact `opted-out`. It never hands over or replies.
- **TypeSafe decision layer for the AI bot (module 013, off by
  default).** Three checks run on the TypeSafe (Jev) API around the
  auto-reply bot, for each account that switches them on in Settings →
  AI safety checks:
  - **Triage**, before any model call. It hands the thread to the team
    when the customer asks for a person or complains, or might be
    complaining. It also catches free-text opt-outs, where the bot stays
    silent and the contact is tagged `opted-out`. A message that tries
    to steer the bot gets knowledge-base-only answers.
  - **Passage filter**, after knowledge-base retrieval. Irrelevant and
    injected excerpts are dropped, and excerpts that contradict the
    customer's premise are set apart.
  - **Guardrail**, just before the send. It holds or blocks replies
    that:
    - promise approval;
    - quote a figure no source contains;
    - name a non-partner bank;
    - ask for an OTP;
    - share another customer's details.

    The draft is quoted in the hand-off note for the team. Its
    deterministic checks keep acting even while the model is in shadow
    for the reply's language.

  **Monitor only** logs every decision and changes nothing; **Live**
  acts on the built-in thresholds, or on custom ones an owner or admin
  proposed and a **different** one approved. With *English only* (the
  default), Arabic, mixed and other-script traffic is logged only until
  calibrated. Checks in monitor mode add no latency to replies.

  Before any customer text leaves the server, it is redacted (Emirates
  ID, IBAN, cards, phones, e-mail, passport and licence numbers, any
  long number). Only keyed hashes are logged, and deleting a contact
  erases its identifiers from the log. An invalid `TS_*` value turns the
  layer off and says so in the service log; it never stops the bot.

  Setup, rollout, emergency stop and calibration are in
  `docs/typesafe.md`. The pre-eligibility check (E) is included in
  `lib/typesafe` but not wired, since the app has no eligibility step
  yet.
- **Switch a chat's sending number mid-conversation.** The thread header
  has a number picker on every chat, including existing ones.
  *Automatic*, the default, replies on the number the customer last
  wrote to, as before. Picking a number sends everything in that chat
  from it until someone switches again: agent replies, API replies, and
  flows, automations and AI replies in the chat. Each switch leaves a
  note in the thread, e.g. "Alice switched this chat to Support".
  People only see the numbers they may use: every number for admins,
  otherwise their allocated numbers plus shared ones. The database
  enforces this too. A pinned chat stays with the team that had it when
  the customer answers on the new number, and that number's people can
  see it as well. A reply that quotes a message carried by the other
  number is sent without the quote on WhatsApp; the thread still shows
  it.

- **Several WhatsApp numbers, each with its own people.** New admin
  screen **Settings → Numbers & access**: connect another Whapi
  number, name each one ("Sales", "Support"), pick the default, and
  allocate numbers to specific members. People on a number see every
  chat on it, which makes it a shared inbox for them, and their new
  chats start from it. A number with nobody on it works exactly as
  before, and admins still see everything. Replies always leave on
  the number the customer last wrote to. Flows, automations and AI
  replies stay on that number too, unless the admin has routed that
  task to the Meta number. The inbox labels each chat with its number
  when an account has more than one. Settings → WhatsApp gets a
  switcher for each Whapi number's connection panel. See
  `docs/whapi.md` → *Several numbers*.

- **Taamul Compass (ERP) integration.** Compass syncs its customers
  into a dedicated table (`POST /api/v1/compass/contacts`, batch upsert
  keyed by Compass's id, bad records reported per index) and sends
  status notifications (`POST /api/v1/compass/notifications`). A
  notification always goes out on the **Whapi** number — it fails with
  `whapi_not_connected` rather than falling back to Meta — lands in the
  customer's existing chat without changing who handles it, and is sent
  at most once per `idempotency_key`. New API-key scopes
  `compass_contacts:read`, `compass_contacts:write`,
  `compass_notifications:send`; new admin screen **Taamul Compass**.
  Integration guide for the Compass team: `docs/compass.md`.
- **Forward a message to other chats.** Hover a message in the inbox →
  _Forward_, pick up to five chats, send. Text, photos, videos, voice
  notes and documents can be forwarded; templates and button messages
  go out as their text; locations and contact cards cannot. It is a
  re-send rather than a WhatsApp-native forward (only Whapi has one,
  and only within a single channel), so the recipient sees no
  "Forwarded" label — the inbox does. Each target is an ordinary agent
  send: it follows that customer's number, and on the Meta number it
  fails outside the 24-hour window like any free-form message. An
  attachment the gateways can't fetch directly (Meta media, or a Whapi
  link with mirroring off) is copied into `chat-media` first.

- **"Forwarded" label on inbound messages.** A message the customer
  forwarded from another chat is now marked as such in the thread, on
  both the Whapi channel and the Meta number.

- **Personalize a CSV campaign from the file itself.** When the
  audience is an uploaded CSV, the _Personalize_ step lists every
  column of the file as a source for each template variable — with
  row 1's value shown as the example — so `{{1}}` can be an
  `order_id`, a `due_date`, or any other column the contact record
  doesn't have. Each recipient gets their own row's value, including
  contacts that already existed in the CRM under a different name.
  The preview on that step now renders the file's first row.

- **Campaigns that keep going.** A broadcast can name a Flow to start
  for each recipient on their first reply (wizard → _When they reply_;
  `flow_id` on `POST /api/v1/broadcasts` and the MCP `send_broadcast`
  tool). The reply that started it — the tapped template button or the
  typed text — is seeded into the run as `{{vars.campaign_reply}}` /
  `{{vars.campaign_reply_id}}`, so the flow can branch on it without
  asking again. The campaign page shows the linked flow; the run log
  records which campaign started a run.
- **The AI agent inside a Flow.** A new off-script setting on every
  flow (_Off-script replies_ panel in the editor) — _Let the AI agent
  answer, then continue the flow_: when the customer types a question
  instead of picking an option, the agent answers it in the context of
  the step (it is told the prompt and the options) and asks them to
  pick one; the run stays where it is, so the buttons still work. If
  the agent is off, at its cap, on the other number, or the thread has
  a human, the options are re-sent as before; if the agent hands off,
  the run ends and the human takes over. Existing flows keep the
  re-prompt default. The panel also exposes the re-prompt count and
  what happens after it, which previously could only be set through
  the API.
- **Video and document template headers can be uploaded.** The template
  editor and the broadcast wizard's personalise step now offer _Upload
  video_ / _Upload PDF_ next to the URL field (MP4/3GPP ≤16 MB, PDF),
  with an inline player for video, instead of image-only upload with a
  bare URL box for everything else. This matters most for a template
  created and approved in Meta's dashboard: it syncs with a video
  header but no link, and WhatsApp needs the video on **every** send —
  the review sample is never reused — so without a URL the send was
  refused. Upload once in the editor and every send of that template
  carries it.
- **A broken flow no longer strands the customer.** When a run hits an
  unrecoverable error on a message — a node deleted while a customer
  was on it, a send that failed — the run ends as _failed_ and the same
  message is handed to the AI agent and automations, instead of being
  swallowed as "handled". `docs/campaign-journeys.md` describes the
  whole Flow → AI → human chain and what answers at each moment.

- **Broadcast CSV template.** The _Upload CSV_ audience step now links
  a downloadable template (`name,company,phone`) and keeps the
  `company` column: contacts created from a broadcast upload used to
  land with only a name and number, so `{{company}}` variables and the
  contacts screen were blank for them. Only `phone` (E.164) is
  required; the header check and column names are unchanged, so
  existing files still upload.

- **AI agent escalation gates.** Three deterministic checks now run in
  front of the auto-reply bot, each handing the thread to a human with
  a recorded reason instead of letting the model answer, and each
  configured under Settings → AI → _Escalation gates_:
  - _Escalation keywords_ — words or phrases in any language (`refund*`,
    `complaint`, `شكوى`, …) that send the message straight to the
    handoff agent without spending a token. Word-boundary matching; a
    trailing `*` matches word beginnings.
  - _Retrieval threshold_ — the minimum similarity the best
    knowledge-base match must reach; below it the bot hands off and the
    question is logged under _Unanswered questions_ on the same page,
    so the knowledge base can be extended where customers actually ask.
    Needs an embeddings key; short conversational turns (under four
    words) skip the gate.
  - _Strict grounding_ — the knowledge base becomes the bot's only
    source of facts; it may greet and clarify but never states a price,
    timeline, or policy it cannot quote.
    A _handoff message_ is sent to the customer when a gate hands off, so
    they are not left waiting in silence. A provider error or timeout is
    now a handoff too (previously the bot logged the error and the
    customer heard nothing), and the internal note the bot leaves names
    the reason. The Playground exercises the same gates and shows which
    one fired.
- **Scheduled broadcasts.** The wizard's last step now offers _Send
  now_ or _Schedule_ with a date and time; a scheduled campaign is
  delivered server-side by the new broadcast cron, so the tab need not
  stay open. Its page shows the appointment and a _Send now_ override.
- **Quiet hours** on a broadcast — a do-not-send window in your time
  zone. A send that would land inside it (now or scheduled) is moved to
  the moment the window ends, and the wizard says so before you
  confirm.
- **Frequency cap** on a broadcast audience — skip contacts who
  received any campaign in the last _N_ days, whatever list they came
  from (CSV included).
- **Message costs.** Settings → Message costs shows what the Meta
  Cloud API number is spending, priced from the `pricing` object on
  every delivery receipt Meta posts: this month so far, spend per
  month stacked by category, per number (with the position against
  the free tier of 1,000 service messages a month that starts on
  1 October 2026), and per recipient market. Deliveries to a market
  the rate card does not cover are counted and flagged as _no rate on
  file_ rather than silently priced at zero; loading Meta's published
  CSV with the new `scripts/load-meta-rate-card.ts` closes the gap.
  Meta's own billable flag on a receipt overrides the local rules,
  and costing runs last in the webhook and fails open, so a rate-card
  problem can never cost an inbound message. The Whapi channel is a
  flat subscription and is not metered. Admin and owner only.

- **Campaign inbox.** A second tab under Broadcasts listing the
  conversations that started as a reply to a campaign while the AI bot
  is answering them, with a per-campaign filter and, on every row,
  which campaign it came from. Each conversation is listed in exactly
  one place — the Inbox lists every other one. A campaign conversation
  moves to the Inbox for good once a person steps in (it is assigned
  to anyone, or a person replies; releasing the assignment or a reply
  to a later campaign does not bring it back), and it is in the Inbox
  whenever the bot is not answering it: handed off, paused, never
  answered (a reply on a number the bot does not run on, say), or with
  the AI auto-reply switched off. The Inbox's unread dot counts only
  conversations the Inbox lists. Admin and owner only, like the rest
  of the section.
- **The AI bot knows which campaign a customer is answering.** When a
  broadcast recipient replies, the thread is stamped with that
  campaign and the bot is told the campaign name and message, so its
  first reply is about the offer the customer received rather than a
  guess at what they want.
- **Sync templates from Meta.** Settings → Templates has a _Sync from
  Meta_ button that pulls every template registered on the connected
  WhatsApp Business Account — name, language, category, header, body,
  footer, buttons, approval status — into the CRM. Until now only
  templates submitted _from_ the CRM were listed, so an account whose
  templates were built in Meta Business Manager saw an empty list and
  could not start a broadcast. The Templates panel and the Settings
  overview counts are also account-wide now instead of per author.
- **AI agent: _Campaign replies only_.** A switch in Agents → Setup that
  restricts the bot to conversations that came from a broadcast, so a
  business can run bot-handled campaigns on a number that also takes
  ordinary customer chat handled by people.
- **Upload a file to the AI knowledge base.** Agents → Knowledge has an
  _Upload file_ button next to _Add document_: a PDF (with a text
  layer), .txt, .md, .csv or .json is extracted and indexed like pasted
  text. Scanned PDFs are rejected with a clear message rather than
  saved empty.
- **Shared contact cards render as cards.** A contact the customer
  shares from WhatsApp — on either number — now shows in the thread
  as a card with the name, every phone number, email and company,
  plus a _Save to contacts_ action that creates the CRM contact (or
  opens the existing one when the number is already known). Previously
  the numbers were discarded at the webhook and the thread showed a
  bare "[contact] Name" line.
- **`scripts/bot-pack.ts`** loads a Taamul bot-pack (one product line,
  or the manifest for all four merged into one agent) into an
  account's AI agent and knowledge base, and runs the pack's test
  cases through the same path the live bot uses.

- **The inbox agrees with itself about who owns a chat.** The
  conversation list now shows the owner's name on a chat nobody has
  formally assigned, instead of the bare word _Unassigned_, and the
  **Agent** filter returns those chats under that owner's name. The
  amber person icon still marks a chat as unclaimed, so the triage
  signal survives — and **Unassigned** still lists exactly the chats
  nobody has taken, which now deliberately overlaps with their owner's
  name.
- **The chat header names whoever is on the thread.** The Inbox header
  now carries the agent working the conversation next to the status and
  Assign controls, instead of leaving a bare **Assign** button on every
  thread nobody had formally claimed. It shows the assignee when there
  is one; otherwise the last agent who actually replied, falling back to
  the chat's owner — hover it to see which of the three you are looking
  at, and whether the thread is still unassigned. Outbound sends from
  the composer now record who sent them, which is what makes the
  "replying" case possible; threads answered before this update fall
  back to the owner until the next reply.
- **The inbox now says whose chat each one is.** Every conversation in
  an admin's inbox — and in a team leader's `/team-inbox` — carries the
  name of the agent holding it, with unassigned threads called out in
  amber so the ones nobody has picked up are visible at a glance. A
  plain agent's inbox is unchanged: every chat there is already theirs.
- **A chat you start is yours from the first message.** Writing to a
  contact who has no thread yet now opens it assigned to you, so it
  shows your name in the inbox instead of Unassigned. Admins reassign to
  anyone and team leaders within their own team, exactly as before —
  this only sets the starting point. Inbound chats from strangers are
  deliberately left unassigned: that is the triage queue.
- **Filter the inbox by agent.** The same views get an **Agent** filter
  next to Tags and Company — pick a teammate to see everything they are
  handling, or **Unassigned** to work the queue nobody has claimed. It
  combines with the existing status, tag, company and search filters,
  and clears with **Clear all**.
- **Meta WhatsApp Cloud API as a second number.** Connect a Cloud API
  number in Settings → WhatsApp and keep your Whapi channel for
  conversations. It must be a _different_ phone number — registering a
  number on the Cloud API removes it from the WhatsApp app, so no number
  can be on both. See `docs/meta-cloud-api.md`.
- **Per-task number selection.** An admin can point each of inbox
  replies, broadcasts, automations, flows, AI auto-reply and the public
  API at either number, or leave it on the account default. The usual
  split is campaigns and automations on the Cloud API number (the
  sanctioned path for business-initiated messaging) and everything
  conversational on Whapi.
- **Meta inbound webhook** at `/api/whatsapp/meta/webhook`, authenticated
  by `X-Hub-Signature-256` over the raw body. Verification fails closed:
  with no app secret configured, callbacks are rejected rather than
  trusted. Both numbers deliver into the same inbox, and a contact stays
  a single conversation regardless of which number they used.
- **Template review lifecycle is live again** when a Meta number is
  connected. Saving a template in Settings → Templates also submits it
  to your WhatsApp Business Account for review, and approvals,
  rejections and quality ratings arrive on the template webhook. The
  submission is best-effort: if Meta rejects the payload the template is
  still saved and still sendable over Whapi, with the reason recorded.
  One template row serves both numbers — Whapi renders it locally and
  needs no approval.
- New optional environment variables `META_APP_SECRET`,
  `META_VERIFY_TOKEN`, `META_API_VERSION` and `META_TIMEOUT_MS`, for a
  single-app self-host that would rather configure Meta's app-level
  secrets once than per account. See `.env.local.example`.

### Changed

- **The inbox looks and reads like WhatsApp.** WhatsApp Web's own
  palette in light and dark mode, independent of the accent theme:
  green bubbles for what we sent with the bubble tail, the time and
  ticks tucked into the last line, blue ticks once read, and the beige
  or dark chat wallpaper. In the chat list an unread chat is
  unmistakable — bold name and preview, a green time and a green count
  — while a read one is plain; the status dot that looked like an
  unread marker is gone (Pending and Closed now say so in words), rows
  are separated by hairline dividers, and times read `14:05`,
  `Yesterday`, `Monday`, `23/09/2026`. Status filters are WhatsApp-style
  chips with **Unread** always in view. Opening a chat with unread
  messages shows an **"N unread messages"** divider above the first
  one. The header gives the contact's name priority, folding labels
  away in a narrow pane, and the "who is on this chat" chip now opens
  the assign menu itself. Also fixed: on a phone the chat list was
  wider than the screen, cutting off times and unread counts.
- **The sidebar is grouped.** Dashboard, Notifications, Inbox and
  Contacts stay at the top for everyone. Below them, under small
  headings, come **Team** (Team inbox, Team contacts, Team activity),
  **Sales & marketing** (Pipelines, Broadcasts), **AI & automation**
  (Automations, Flows, AI Agents) and **Integrations** (Compass), and
  Settings sits apart at the foot. A heading shows only when there is
  something under it the person may open, so agents and viewers see just
  the top four, and team leaders also get Team.
- **Send failures say what actually happened.** A Whapi refusal is
  followed by a quick status check of the number, so agents see
  "logged out of WhatsApp — re-scan the QR code" rather than "token
  invalid or revoked", which sent admins to re-save a token that was
  fine. Compass notifications answer `409 whapi_not_connected` while the
  number is disconnected, instead of a 502 and an empty chat.
- **Broadcasts** stop sending, leaving recipients pending for Resume,
  when the number itself fails (logged out, token revoked, subscription
  lapsed), instead of failing every remaining recipient. A Meta
  template with an image, video or document header but no media is
  refused at launch (`400 template_media_missing`). Delivery ticks and
  `message.status_updated` webhooks no longer go backwards.
- **An AI reply WhatsApp fails to deliver hands the thread to a
  person** (reason `error`); it used to fail silently.
- **Meta webhook:** callbacks for a number not connected here are
  summarised once an hour per number (messages, statuses, how many are
  signed by this app) instead of one log line per request; template
  callbacks for a WABA not connected here are acknowledged without a
  signature check (a latent 401 while `META_APP_SECRET` was unset could
  have made Meta disable the app's subscription); template quality and
  components callbacks reach the template handler.
- **Meta connect** refuses a different number while one is connected
  (409) instead of silently overwriting the live number, lets the WABA
  id of the connected number be corrected once Meta lists the number
  under the new WABA, and checks that the phone number belongs to the
  WABA before subscribing it (400).
- **Meta webhook robustness:** a POST mixing template changes and
  messages processes both halves (the messages used to be dropped with a
  200); a database error while looking up the WABA or phone number id
  answers 503 so Meta retries; a malformed or forged body is answered
  200 `ignored` instead of a 500.
- **Compass notifications** check the Whapi number the customer's chat
  actually uses before refusing with `409 whapi_not_connected`, and a
  synced phone that is not a valid international number is refused with
  `422 invalid_phone` (it was "sent" to nobody).
- **Contact numbers:** a national number typed without its country code
  (e.g. `98765 43210`) is refused instead of being stored as +98…; a
  trunk 0 after any country code is removed; UAE 600/800 numbers are
  accepted; a `.0` suffix, letters, or more than 64 characters are
  refused instead of silently altered. `POST /api/v1/messages` and v1
  broadcast recipients follow the same rule, and `/messages` matches an
  existing contact by the normalized number.
- **Inbox:** a failed text is put back only in its own chat; when a send
  may have gone out (a timeout or a gateway error) there is no Retry and
  the toast says it may still have reached the customer; a "sent but not
  saved" error no longer deletes the attachment the delivered message
  links to. An attachment kept for Retry is left in storage if the tab
  is closed before it is retried or discarded.
- **Broadcasts:** a campaign stopped by a failure of the sending number
  records the reason on the recipient where it stopped; a delivered
  receipt no longer drops a read receipt that arrives at the same
  moment.

- **Contact detail sends split across the two numbers.** With both a
  Whapi channel and a Meta Cloud API number connected, opening a
  contact and choosing _Send message_ now goes out on the Whapi number
  and _Send template_ on the Meta number — a free-form text is what
  Whapi is for, and an approved template is the only thing that opens
  a business-initiated conversation on Meta. A caption under the two
  buttons names the number each will use. Single-number installs are
  unchanged: both actions use the one connected number. (The dashboard
  send endpoint gained an optional `provider: 'whapi' | 'meta'` pin
  behind this; the inbox composer leaves it unset and keeps following
  the customer's number.)
- **The AI agent hands off at its reply cap.** Once _Max replies per
  conversation_ is reached, the thread is handed to a human with reason
  _reply cap_ (internal note, handoff agent if one is set, the handoff
  message to the customer if one is set) instead of the bot silently
  ignoring every further message. A thread the bot has left is still a
  thread someone must answer.
- **Replies follow the customer's number.** An agent replying in the
  inbox now answers on whichever number the customer last wrote to,
  rather than a single configured channel. On Meta this is also what
  keeps the reply inside the 24-hour service window the customer opened.
- **AI auto-reply answers only on its own number.** With two numbers
  connected, the bot replies to messages that arrive on the number it
  is routed to and leaves the other number to humans — so routing it to
  the Meta number gives you a Meta-only bot. Single-number installs are
  unchanged.
- **The AI bot can say goodbye before handing off.** When it decides a
  human should take over, a closing line it wrote ("a relationship
  manager will contact you within working hours") is sent first instead
  of the customer seeing silence. Counts against the per-conversation
  reply cap like any other bot message.
- **Clearer send failures.** Gateway rejections are translated before
  they reach you — most usefully Meta's closed 24-hour window, which
  previously surfaced as a bare numeric code.
- Disconnecting one number no longer disturbs the other; any task routed
  to the removed number falls back to the account default.

- **Renamed the product to Taamul Connect.** The app title, sidebar,
  UI strings (`en` and `ko`), docs and package names now read Taamul
  Connect. The npm packages are `taamul-connect` and
  `taamul-connect-mcp`; the Docker Compose project is
  `taamul-connect`.

  Nothing you have integrated breaks. Every renamed identifier keeps
  accepting its old value:

  - **API keys** — new keys mint as `taamul_live_…`; existing
    `wacrm_live_…` keys keep authenticating. The prefix is not a
    secret and carries no scope, so there is nothing to rotate unless
    you want to.
  - **Outbound webhooks** — deliveries now send `X-Taamul-Event`,
    `X-Taamul-Webhook-Id` and `X-Taamul-Signature`, _and_ continue to
    send the identical `X-Wacrm-*` headers. Receivers verifying the
    old names need no change. The old names are deprecated and will
    be dropped in a future release.
  - **MCP server** — reads `TAAMUL_BASE_URL` / `TAAMUL_API_KEY` /
    `TAAMUL_ENABLE_WRITES` / `TAAMUL_ENABLE_BROADCASTS`, falling back
    to the `WACRM_*` names, so an existing client config keeps
    working.
  - **Sessions and preferences** — the auth cookie name is
    deliberately unchanged (renaming it would sign everyone out).
    Theme, mode, inbox panel and flow-editor preferences are read
    from their old `localStorage` keys once and migrate on next
    write.

  No database migration is required.

  Two things are **not** renamed automatically because they name
  objects outside this repo: the systemd units, log files and
  checkout path in `scripts/sync-tunnel-url.sh`, and the
  `github.com/ArnasDon/wacrm` URLs in the GitHub issue templates and
  `SECURITY.md`. Update those to match your own deployment and
  repository.

  If you run Docker Compose, the project name changed, so the old
  containers are no longer tracked. Run `docker compose -p wacrm
down` once before bringing the new project up. There are no named
  volumes, so no data is involved.

### Fixed

- Broadcasts: a template variable that came out blank for some
  recipients (a Compass field or CSV cell they lacked, a contact with
  no email) failed every one of them on Meta with `(#131008) Required
  parameter is missing`, and on Whapi sent "Hi ,". Each variable in the
  Personalize step now has an *If empty, use* fallback, and the step
  warns how many CSV rows, or how many customers in a sample of a
  Compass selection, would get a blank. A blank value that still
  reaches a Meta send is refused before the gateway call, and the
  recipient's error names the variable; a #131008 from Meta is worded
  plainly too. Values are fixed when a broadcast is created, so an
  affected campaign is fixed by creating it again with a fallback, not
  by *Retry failed*.
- Team activity figures and warnings were inaccurate:
  - Since a second phone number was connected, older chats belonged to no
    number, so per-number and per-person totals read low.
  - "Messaged without an answer" only looked back 7 days.
  - "Customers waiting" counted threads that ended weeks ago.
  - Chats started minutes earlier already counted as "no reply".
  - Compass notifications showed up as replies.
  - "At the limit" meant different things on the page, in the bell and in
    the message box.
  - The reply-rate warning told people to reach a rate they were already
    above.
  - Failures on the official number were blamed on agents.
  - Near-identical first messages that differed only by a name went
    unnoticed.
  - New phone numbers now have a lower daily limit (10) for their first
    two weeks.
- Number allocation: an agent allocated to a WhatsApp number (or in a
  team allocated to it) could see every other agent's chats and
  contacts on that number. Allocation now only controls which numbers
  they send from and start new chats on; they see their own and
  assigned chats (team leaders also their team's), and admins and owners
  see everything. Settings wording and docs updated to match (migration
  072).
- Inbox: after a Whapi channel was re-paired to a different phone, the
  number picker, the conversation list and the alerts kept showing the
  old number, which was only stored when the token was saved. Settings
  showed the new one. The channel health check and Settings → WhatsApp
  now store the number Whapi reports paired, so these screens follow it
  within one health tick.
- Inbox: a chat that receives (or sends) a new message now jumps to the
  top of the list, as in WhatsApp; it used to stay where it was until a
  reload. Chats with no messages at all — left behind when a first send
  failed — no longer appear, and no longer sit above every real chat.
- Re-saving a Whapi token while the phone was logged out erased the
  number's stored phone number.
- Inbound contact lookup preferred whichever of two near-duplicate
  contacts the database returned first; it now prefers the exact number,
  then the oldest.
- Broadcast failure reasons were never stored ("-" on every failed
  recipient); the legacy broadcast route logged full customer phone
  numbers.

- **Multi-number review.**
  - *Wrong number:*
    - Reactions go out through the number that carried the message.
    - The AI replies only when the number it would answer from is the
      one the customer wrote to. An explicit AI route to one Whapi
      number keeps the other Whapi numbers human-only.
    - A quoted reply to an older message is sent unquoted when it
      could have been carried by another number.
  - *Robustness:*
    - One number with an unreadable token no longer stops every other
      number from sending.
    - When no default is flagged, the fallback is a Whapi number, not
      Meta.
    - An agent on no number no longer starts new chats from a number
      allocated to someone else.
    - A pin set while an inbound message is being processed is no
      longer overwritten.
    - Switching back to automatic re-syncs which number the chat is
      on.
  - *Speed:* fewer database round trips per send.
  - *Screens:*
    - The chat header fits on phones.
    - Rapidly switching chats no longer mixes up their number or their
      notes.
    - Routing dropdowns show names instead of `__inherit__`.
    - The inbox list no longer loads twice on open.
- **Security.**
  - *Outside the multi-number work:*
    - Delivery-status callbacks only touch the authenticated account's
      messages and broadcasts.
    - A Meta callback that batches several numbers is split and each
      part is filed under its own number and account.
    - Automation read/edit/delete/duplicate routes are scoped to the
      caller's current account, so a removed admin can no longer edit
      automations they wrote. Any admin of the account can now open an
      automation, not only its author.
    - The legacy media proxy only serves media that a message the
      caller can see points at.
    - Webhook URLs are checked for private addresses when saved.
  - *Public API:*
    - Pagination cursors are validated as strict timestamps.
    - The send error no longer carries raw database text.
  - *Legacy broadcast endpoint:* capped at 100 recipients per call.

- **A large CSV broadcast import failed with a page of HTML instead of
  an error.** Importing an audience looked up every phone number in the
  file in one request, and PostgREST echoes the whole
  `?phone_normalized=in.(...)` filter back in the `Content-Location`
  response header. Past roughly 250 rows that header outgrew the
  default 4 KB buffer in a reverse proxy sitting in front of a
  self-hosted Supabase, which answered 502 — so the upload stopped with
  the proxy's "Bad gateway" markup quoted back as the reason, while the
  identical query was fine against Supabase directly. The lookup is now
  chunked like the insert beside it. Self-hosters behind a proxy should
  also raise its response-header buffers; see `docs/docker.md`.

- **A tapped template button got no reply from the AI agent.** A
  campaign sent without a follow-up Flow whose recipient answered by
  tapping a quick-reply button ("Get a quote") was never handed to the
  bot: button taps were reserved for Flows and _interactive reply_
  automations, and the agent's transcript only read typed messages, so
  with neither in place the customer heard nothing back. The agent now
  answers a tap nothing else claimed, reading the tapped title as the
  customer's message; it still stands down when a Flow consumed the tap
  or an active _interactive reply_ automation owns the buttons.
- **The AI agent's _Campaign replies only_ switch did nothing.** The
  setting (migration 049) was saved and shown but never checked when
  a message arrived, so the bot answered every chat on its number
  regardless. It is now enforced: with the switch on, the bot only
  answers threads a broadcast reply has stamped.
- **A resumed broadcast lost its media header.** The wizard passed the
  image / video / document URL per request and never stored it, so a
  Resume or Retry sent the template's stored sample instead. The URL is
  now persisted on the campaign and used by every server-side pass.
- **A media header chosen in the broadcast wizard never reached the
  Cloud API.** The provider-neutral send layer forwarded the header URL
  to Whapi but dropped it on the Meta branch, so a video / image /
  document template synced from Meta (which carries no stored media
  link) failed every recipient with _"video header requires a media
  link or id at send time"_ even though the wizard had the URL. The URL
  is now folded into the Meta send.
- **Inbound messages from a contact whose number was typed with spaces
  were silently dropped.** The duplicate-contact lookup pre-filtered on
  the raw `phone` column, so a contact saved as `971 50 455 5843` was
  invisible to the webhook; the insert then tripped the unique index
  and the message never reached the inbox. The lookup now filters on
  the normalised column the index is built on.
- Every screen under the dashboard (`/flows`, `/agents`,
  `/notifications`, `/team-inbox`, `/team-contacts`) now redirects a
  logged-out visitor to `/login` at the edge, like the rest. Data was
  never exposed — RLS and the client-side guard still applied — but the
  page shell was served before the redirect fired.

## [0.8.1] — 2026-07-10

Fixes inbound chats fragmenting into multiple threads for the same
number.

> **Migration required:** apply `supabase/migrations/036_conversation_contact_dedup.sql`
> (merges any existing duplicate conversations into the oldest thread —
> no messages are lost — then adds a `UNIQUE (account_id, contact_id)`
> index so one contact can only ever have one conversation).

### Fixed

- **Message costs no longer zero-rates a template send.** Meta attaches
  the `pricing` object to the `sent` receipt and does not always repeat
  it on `delivered`. A delivery with no category of its own was filed
  as _service_ — free, and invisible to the _no rate on file_ counter —
  so a marketing or utility send could disappear from the ledger
  entirely. Such a delivery now adopts the category already recorded
  for the same message, and the pre-per-message `user_initiated` origin
  maps to _service_.
- **Message costs: "Free service messages used" counts.** The tile read
  the ledger's quota flag, which is only ever set once the 1,000-message
  allowance is what makes a message free — so it showed a flat zero
  until 1 October 2026 while the per-number rows beneath it counted
  normally. It now reads the same free-tier figure they do.
- **Message costs: a service message Meta bills is no longer also
  counted as free.** Meta's `billable` flag overrides the local rules,
  but the row kept its quota-free mark, charging the message and
  spending an allowance slot for it.
- **Message costs: an unrecognised category is shown, not dropped.** A
  category outside the known list (a pre-per-message `business_initiated`,
  or one Meta adds later) vanished from the stacked chart — leaving the
  bars short of the headline total — and rendered as a raw translation
  key in the breakdown list.

### Changed

- The migrations workflow now also replays
  `supabase/ci/verify-message-costs.sql`, which drives
  `record_whatsapp_message_cost` with real receipt shapes and asserts
  the ledger rows it writes. The costing rules live in SQL, so `npm
test` cannot reach them, and a wrong rate is silent by nature — it
  under-reports spend without erroring.
- **AI knowledge base keyword search matches natural questions.** See
  the migration note above.
- **Broadcast audience → Upload CSV actually offers a file picker.**
  The option, its copy and the send-side handling all existed, but the
  panel with the upload button was never rendered, so choosing it left
  nothing to click. A `phone` column (E.164) is required; `name` is
  optional.
- **CSV audiences no longer fail on contacts that already exist.**
  Sending to a CSV matched the file's numbers against the raw phone
  string of the sender's own contacts, so a number a teammate had
  already saved — or the same number written with spaces or a `+` —
  was re-inserted and rejected by the per-account unique phone index
  (`duplicate key value violates … idx_contacts_account_phone_normalized`).
  Matching is now on the normalized number, account-wide.

- **Duplicate chats for a single contact.** An inbound message could
  create a second conversation for a contact under a race (Meta retries a
  delivery, or a batch fans out to concurrent runs). Once two existed,
  the `.single()` lookup errored on every later message and the webhook
  created yet another conversation each time, snowballing into a wall of
  duplicate chats. The find-or-create now resolves to the oldest existing
  thread and a DB unique index makes the one-conversation-per-contact
  rule authoritative. The same hardening was applied to the public-API
  conversation resolver. (Issue #363)

## [0.8.0] — 2026-07-08

Polishes the AI auto-reply bot: it's now **visible and controllable from
the inbox**, its **handoff actually hands off**, and its **token spend is
logged**.

> **Migration required:** apply `supabase/migrations/033_ai_reply_polish.sql`
> (adds `messages.ai_generated`, `ai_configs.handoff_agent_id`,
> `conversations.ai_handoff_summary`, and the `ai_usage_log` table).

### Added

- **"AI" badge in the inbox.** Replies the bot sent are tagged with a
  small ✨ AI badge, so agents can tell an automated reply from their own
  or a Flow's at a glance. (New `messages.ai_generated` flag; only the
  auto-reply bot sets it.)
- **Take over / Resume from the thread.** A banner on AI-handled
  conversations lets an agent **Take over** (pauses the bot for that
  thread and assigns it to them) or **Resume AI** (hands the thread back
  and clears the pause). Backed by `POST /api/ai/autoreply/[id]`.
- **Real handoff.** When the bot bails (can't help, or hits the reply
  cap) it now (1) routes the conversation to a configurable **handoff
  target** — a specific agent, or the unassigned queue — and (2) leaves a
  short **internal note** summarizing the exchange for whoever picks it
  up. Assigning fires the existing assignment notification. Pick the
  target under **AI Agents → Setup → Hand off to**.
- **Token-usage logging + dashboard.** Every draft and auto-reply records
  its provider token counts to the new `ai_usage_log` table
  (admin-readable). A new **AI Agents → Usage** tab (admin-only) charts
  daily token spend on your BYO key with per-mode and per-model
  breakdowns, backed by `GET /api/ai/usage`. Counts only — no message
  content is stored or shown.

### Changed

- Auto-reply now has an **account-wide rate limit** (30/min) on top of
  the existing per-conversation cap, so a burst of inbound can't run your
  provider key past its limit. Over the limit, inbounds simply wait in
  the inbox for a human instead of being auto-answered.

## [0.7.0] — 2026-07-02

Promotes the AI assistant to a first-class **AI Agents** section in the
sidebar — it's no longer tucked inside Settings.

### Added

- **AI Agents (sidebar).** A dedicated `/agents` area with two tabs:
  - **Playground** — a test chat to message your agent and see its
    grounded, multi-turn replies (and where it would hand off to a human)
    _before_ it ever answers a real customer. Runs the exact same path as
    the auto-reply bot (knowledge-base retrieval + your provider), and
    works even before you flip the master switch on, so you can try, then
    enable. Backed by `POST /api/ai/playground`.
  - **Setup** — the provider/key, business context, knowledge base, and
    auto-reply controls (moved here from Settings → AI Assistant).

### Changed

- The AI configuration moved out of **Settings → AI Assistant** into the
  new **AI Agents** section. No data change — same account config, new
  home. No migration required.

## [0.6.0] — 2026-07-02

Adds an **AI knowledge base** so the assistant (0.5.0) can answer from
your own content instead of handing off. Paste FAQs, policies, or
product details under **Settings → AI Assistant → Knowledge base**; the
relevant excerpts are retrieved into every draft and auto-reply.

### Added

- **Knowledge base with hybrid retrieval.** Lexical Postgres full-text
  search works for every account with no extra credentials. Optional
  **semantic search** (pgvector, OpenAI `text-embedding-3-small`) turns
  on when you add an **embeddings key** — semantic-primary, topped up
  with lexical to fill the result set. Anthropic-only accounts (Anthropic
  has no embeddings API) keep the lexical path with zero extra setup.
- **Knowledge base manager** in Settings — add/edit/delete documents and
  a **Reindex** action to backfill embeddings after adding a key. Both
  drafts and the auto-reply bot are grounded in the retrieved excerpts,
  and the prompt still instructs the model to hand off (auto-reply) or
  say it will follow up (draft) when the KB doesn't cover the question.
  **Migration required:** apply `supabase/migrations/030_ai_knowledge.sql`
  (enables `pgvector`; adds `ai_knowledge_documents` + `ai_knowledge_chunks`
  and an `embeddings_api_key` column on `ai_configs`).

## [0.5.0] — 2026-07-02

Adds the **AI reply assistant** — bring-your-own-key. Each account
pastes its own OpenAI or Anthropic key under **Settings → AI
Assistant**; wacrm calls the provider directly with that key, so
there's no per-seat AI fee and your conversation data never leaves
your own infrastructure for a wacrm-run service. The key is stored
AES-256-GCM-encrypted at rest (same as WhatsApp tokens) and never
returned to the client after saving.

### Added

- **AI-drafted replies in the inbox.** A ✨ button in the composer
  (agent+) reads the recent conversation and drops a suggested reply
  into the box for the agent to edit and send. Read-only server-side —
  `POST /api/ai/draft` never sends or stores anything. Respects your
  business context / persona from the settings prompt.
- **AI auto-reply bot.** When enabled, inbound messages that no
  deterministic Flow consumed and that have no agent assigned get an
  automatic LLM reply. Bounded by a per-conversation cap
  (`auto_reply_max_per_conversation`, default 3) and a clean human
  handoff: when the model can't confidently help — or the customer
  asks for a person — it stays silent and leaves the message for a
  human, and won't auto-reply on that thread again until re-enabled.
  Flows always win over the bot.
- **Settings → AI Assistant** (admin+ to edit): pick provider + model,
  paste your key, add business context/tone, toggle the assistant and
  auto-reply, set the per-conversation cap, and **Test key** against
  the provider before saving.
- Providers: OpenAI (Chat Completions) and Anthropic (Messages) behind
  one interface; model is a free-text field with sensible defaults, so
  you can point it at any current model your key can access.
  **Migration required:** apply
  `supabase/migrations/029_ai_reply.sql` (adds `ai_configs` +
  per-conversation auto-reply columns on `conversations`).

## [0.4.0] — 2026-07-01

Completes the public API (#245): **outbound event webhooks** so
automations can _react_ to activity instead of polling.

### Added

- **Outbound event webhooks (`/api/v1/webhooks`).** Register an HTTPS
  endpoint (scope `webhooks:manage`) to be POSTed to when an event
  happens in your account — `message.received`, `message.status_updated`,
  or `conversation.created`. Manage endpoints with
  `GET/POST /api/v1/webhooks` and `GET/PATCH/DELETE /api/v1/webhooks/{id}`.
  Each delivery is signed with an `X-Wacrm-Signature`
  (HMAC-SHA256 over `timestamp.body`) so receivers can verify
  authenticity and reject replays; the signing secret is returned once
  at creation and stored encrypted. Delivery is best-effort — an
  endpoint that fails repeatedly is auto-disabled after a threshold of
  consecutive failures. See `docs/public-api.md`.
  **Migration required:** apply
  `supabase/migrations/028_webhook_endpoints.sql`.
  ([#245](https://github.com/ArnasDon/wacrm/issues/245))

## [0.3.0] — 2026-07-01

Multi-user accounts ship. Every wacrm install is multi-tenant on the
database side: a single user's signup creates a fresh "account", and
every row is scoped to that account rather than to the user directly.
This release also opens the user-visible **Members** surface — invite
teammates by link, manage their roles, transfer ownership — to all
users. The `'account_sharing'` beta gate that hid it during
development is removed (mirrors the Flows soft-GA in 0.2.0). Existing
self-hosted instances keep working: every existing user is backfilled
as the sole owner of their own account and sees identical data, and a
solo owner who never invites anyone sees the same single-user app they
always did.

### Added

- **Public REST API (`/api/v1`) — groundwork.** A scoped, revocable
  **API key** system so you can drive wacrm from your own scripts and
  automations. Create keys under **Settings → API keys** (admin+),
  grant only the scopes each integration needs, and authenticate with
  `Authorization: Bearer <key>`. Keys are account-scoped and stored
  hashed (plaintext shown once). This release ships the auth layer,
  scopes, per-key rate limiting, the management UI, and a
  `GET /api/v1/me` probe to verify a key. See
  `docs/public-api.md`. **Migration required:** apply
  `supabase/migrations/026_api_keys.sql`. ([#245](https://github.com/ArnasDon/wacrm/issues/245))
- **Public REST API — data endpoints.** Built on the key auth above,
  so external automations can read and drive the CRM:
  - `POST /api/v1/messages` — send a text / template / media message to
    a phone number; finds-or-creates the contact + conversation
    (`messages:send`).
  - `GET/POST /api/v1/contacts`, `GET/PATCH /api/v1/contacts/{id}` —
    list (search + tag filter), create (find-or-create by phone), read,
    and update contacts, including tags (`contacts:read` /
    `contacts:write`).
  - `GET /api/v1/conversations`, `GET /api/v1/conversations/{id}`, and
    `GET /api/v1/conversations/{id}/messages` — browse conversations and
    their message history with delivery status (`conversations:read` /
    `messages:read`).
  - `POST /api/v1/broadcasts` + `GET /api/v1/broadcasts/{id}` — launch a
    template broadcast to a recipient list and poll its progress
    (`broadcasts:send`).
    All list endpoints share one cursor-pagination contract
    (`{ data, meta: { next_cursor } }`). No migration required — the
    scopes already existed and the tables are unchanged. Outbound event
    webhooks (react to inbound messages) are the remaining roadmap item.
    See `docs/public-api.md`. ([#245](https://github.com/ArnasDon/wacrm/issues/245))

### Changed

- **Tenancy moves from per-user to per-account.** RLS on every
  domain table (contacts, conversations, messages, broadcasts,
  automations, flows, pipelines, templates, tags, …) now checks
  account membership via a new SECURITY DEFINER helper
  `is_account_member(account_id, min_role)` instead of
  `auth.uid() = user_id`. The `user_id` columns stay on every row
  for assignment / audit but no longer enforce isolation.
- **WhatsApp config is one-per-account, not one-per-user.** The
  `whatsapp_config.UNIQUE(user_id)` constraint is replaced by
  `UNIQUE(account_id)`.
- **`flow_runs` idempotency key swaps to `(account_id, contact_id)`**
  so two accounts sharing a contact phone number can each run their
  own flows independently.
- **The signup trigger (`handle_new_user`) now also creates a
  personal account** and links the new profile to it as `owner`.

### Changed

- **Flow-media storage is now account-scoped.** Migration 016
  pathed uploaded files under `auth.uid()/...`, which orphaned
  flow media when a teammate left a shared account. New uploads
  go under `account-<account_id>/...` and any account member
  with the right role can edit them. Legacy paths remain
  writable by the original uploader for backward compatibility.
- **Webhook contact lookup now pre-filters in SQL.** Previously
  pulled every contact in an account just to JS-filter to one
  row by phone — fine when account = one user, painful when
  account = team. Pre-filter by phone suffix on the database
  side; re-apply `phonesMatch` on the (typically 0-2 row)
  candidate set.

### Migration required

- `supabase/migrations/020_account_sharing_followups.sql` —
  composite partial indexes on `automations(account_id,
trigger_type) WHERE is_active` and `flows(account_id) WHERE
status='active'` for the engine dispatch hot path; updated
  `flow-media` storage RLS to allow account-member writes under
  the new path convention. Idempotent.

- **Role-aware UI gating across the app.** The inbox composer's
  send button + textarea, the "New broadcast / automation / flow"
  buttons, the "Add pipeline / deal" buttons, and the "Add /
  Import contact" buttons are now disabled-with-tooltip for
  viewers (and for agents on settings-class actions). Choice:
  show-but-disable rather than hide, so the UI never feels
  silently broken to a teammate looking at a feature they don't
  yet have permission for.
- **Sidebar surfaces the active account** above the user info
  whenever the account name differs from your own — i.e. once
  you've renamed the account or joined a shared one. A default
  solo account is named after you, so the strip stays hidden to
  avoid duplicating your name in the footer.
- **Members is open to all users.** The `account_sharing` beta
  flag that hid the Settings → Members tab and the sidebar
  account strip during development is gone; the multi-user
  surface is now part of the standard app. (Same soft-GA move as
  Flows in 0.2.0.)

### Fixed

- **Inbound WhatsApp messages now land in the shared inbox.** The
  webhook + automations + flows engines used to route inbound
  events by `user_id`, which after the 017 migration only matched
  the WhatsApp config owner's automations / flows — teammates'
  rules never fired. PR 8 of the multi-user series flips every
  lookup to `account_id` so any member of the account sees the
  inbound message and any teammate's automation or flow can react
  to it. Also fixes incipient NOT NULL violations on
  `automation_logs`, `automation_pending_executions`, `flow_runs`,
  and `deals` — those tables gained `account_id NOT NULL` in 017
  but the engines hadn't yet been updated to populate it.

### Added

- **Duplicate phone numbers are now prevented across contacts.** A
  phone number can no longer become more than one contact in the same
  account. Adding a contact whose number already exists is blocked
  with a link to the existing record (and a softer warning for
  near-matches that share their last 8 digits); CSV import de-dupes
  within the file and against existing contacts, reporting
  "X imported, Y duplicates skipped". The rule is enforced by a
  database unique index on the normalized number, so the WhatsApp
  webhook, the form, import, and any future path all agree. Existing
  duplicates are merged into the oldest contact on upgrade (their
  conversations, deals, notes, and tags are re-pointed, nothing is
  lost). Closes #212.
- **Configurable default deal currency.** Each account can now pick
  its default currency under **Settings → Deals** (admin+); the app
  previously hardcoded USD throughout. New deals default to it, and
  pipeline-stage totals, the dashboard "Open Deals Value" card, the
  pipeline-value donut, and automation-created deals all use it.
  Existing deals keep the currency they were saved with — totals are
  shown in the account default with no exchange-rate conversion (one
  currency per account). Full guide:
  [Default currency](https://wacrm.tech/docs/settings#deals).
- **Members tab in Settings.** The user-facing surface for the
  multi-user APIs below, available to everyone (no beta flag). From
  Settings → **Members** an admin or owner can: see who's on the
  account with their role and join date, invite teammates by
  generating a one-time share link (pick the role + optional
  expiry), revoke pending invites, change a member's role, remove a
  member, and — as owner — transfer ownership. Recipients accept via
  a public `/join/[token]` page. Full guide:
  [Members docs](https://wacrm.tech/docs/members).
- **Account & member management API** — server-side endpoints
  backing the Members tab. All routes are role-gated and
  return Supabase-RLS-scoped data.
  - `GET /api/account` — caller's account + role. Any member.
  - `PATCH /api/account` — rename the account. Admin+.
  - `GET /api/account/members` — list members. Email visible to
    admin+ only; agents/viewers see name + avatar + role +
    joined date.
  - `PATCH /api/account/members/[userId]` — change a member's
    role. Admin+. Owner promotion/demotion goes through the
    transfer endpoint instead.
  - `DELETE /api/account/members/[userId]` — remove a member.
    Admin+. The removed user keeps their login and is moved to a
    freshly-created personal account (mirror of the signup flow).
  - `POST /api/account/transfer-ownership` — owner only. Atomic
    swap with the named member.
- **Invitation API + redeem flow** — the no-email, link-only
  invite path that powers the Members tab's "Invite member" button
  and the `/join/[token]` accept page.
  - `GET /api/account/invitations` — list outstanding (admin+).
  - `POST /api/account/invitations` — create an invite, returns
    the plaintext token + share URL **exactly once** (we store
    only the SHA-256 hash on the row). Body
    `{ role, expiresInDays?, label? }`. Admin+.
  - `DELETE /api/account/invitations/[id]` — revoke (admin+).
  - `GET /api/invitations/[token]/peek` — public, per-IP
    rate-limited. Returns `{ ok, account_name, role, expires_at }`
    or `{ ok: false, reason }` so the join page can render
    "You're being invited to <Account> as <Role>".
  - `POST /api/invitations/[token]/redeem` — authenticated.
    Atomically moves the caller's profile to the inviter's
    account and cleans up the orphan personal account. Refuses
    with 409 if the caller's current account already contains
    domain data (no silent data loss).

### Migration required

Apply against your Supabase project before deploying this version:

- `supabase/migrations/017_account_sharing.sql` — introduces the
  `accounts` and `account_invitations` tables plus an
  `account_role_enum` type; adds `account_id` to every
  user-scoped table and backfills it; rewrites every RLS policy;
  replaces the new-user trigger. Idempotent. **No data loss** —
  every existing user is mapped to a freshly-created account
  with role `owner` and every existing row of theirs is linked
  to that account.
- `supabase/migrations/018_account_member_rpcs.sql` — adds three
  `SECURITY DEFINER` RPCs (`set_member_role`,
  `remove_account_member`, `transfer_account_ownership`) that
  back the member-management API. They self-check the caller's
  role and raise SQLSTATE `42501` / `22023` on forbidden / bad
  input so the API layer can map cleanly to 403 / 400.
  Idempotent.
- `supabase/migrations/019_invitation_rpcs.sql` — adds two
  `SECURITY DEFINER` RPCs: `peek_invitation` (anonymous read by
  token hash, returns a fixed-shape JSON envelope) and
  `redeem_invitation` (authenticated atomic move + orphan
  cleanup, with a domain-data safety check). Both bypass the
  RLS that would otherwise block their reads/writes. Idempotent.
- `supabase/migrations/021_account_default_currency.sql` — adds
  `accounts.default_currency` (`TEXT NOT NULL DEFAULT 'USD'`, with a
  3-letter-code `CHECK`) backing the configurable default currency.
  Idempotent; existing accounts backfill to `USD`. **Apply before
  deploying** — the app now reads this column when loading the
  account, so an un-migrated database breaks account loading.
- `supabase/migrations/022_contact_phone_dedup.sql` — adds the
  generated `contacts.phone_normalized` column, **merges existing
  duplicate contacts into the oldest** (re-pointing conversations,
  deals, notes, tags, custom values, and broadcast recipients — no
  data loss), then adds a `UNIQUE (account_id, phone_normalized)`
  index. Idempotent. **Apply before deploying** — CSV import reads
  `phone_normalized`, and the index is what enforces de-duplication
  for every write path. The one-shot merge runs inside the migration.

## [0.2.2] — 2026-05-29

Flow nodes can now send media. Closes the most-requested gap from user
feedback after the v0.2.0 Flows launch — flows were text-only and
couldn't deliver an invoice, receipt, product photo, or short demo
video mid-conversation.

### Added

- **`send_media` flow node.** Send an image (PNG / JPEG / WebP), video
  (MP4 / 3GP), or document (PDF, Word, Excel, PowerPoint, TXT) to the
  customer from any point in a flow. Pick a file in the builder, it
  uploads to the new `flow-media` Supabase Storage bucket, and Meta
  fetches the public URL at send time. Optional caption (1024 char cap,
  supports `{{vars.X}}` interpolation); documents also take an optional
  filename shown in the recipient's chat. Auto-advances after send —
  same suspend semantics as `send_message`.
  ([#156](https://github.com/ArnasDon/wacrm/pull/156))

### Migration required

Apply against your Supabase project before deploying this version:

- `supabase/migrations/016_flow_media.sql` — does two things:
  1. Adds `'send_media'` to the `flow_nodes.node_type` CHECK
     constraint. Without this the `send_media` node fails to save with
     a constraint violation.
  2. Creates the public `flow-media` Supabase Storage bucket (16 MB
     file-size cap, image / video / document MIME allowlist) plus
     per-user RLS policies (path prefix = `auth.uid()`). Without this
     the builder's file picker fails on upload. Same shape as the
     `avatars` bucket from migration 008 — the bucket is **public** so
     Meta can fetch the URL without credentials.

The migration is idempotent and safe to re-run.

## [0.2.1] — 2026-05-26

Bug-fix release. Plugs a silent inbound-message drop that triggered
when two users on the same instance saved the same WhatsApp
`phone_number_id`.

### Fixed

- **Inbound WhatsApp messages no longer silently disappear** when two
  users have claimed the same `phone_number_id`. Previously the
  webhook used `.single()` to look up the owning config, which errors
  `PGRST116` for both 0 rows _and_ ≥2 rows — the second user's save
  put the DB into the ≥2-row state and every inbound message was
  dropped while the log misleadingly reported _"No config found for
  phone_number_id"_. Three layers of fix: `POST /api/whatsapp/config`
  now returns **409** when another user has already claimed the
  number, the webhook lookup distinguishes 0 rows from ≥2 rows and
  logs the conflicting `user_id`s, and a new DB constraint
  (`UNIQUE(phone_number_id)`) prevents the bad state at the storage
  layer. Reported in
  [#136](https://github.com/ArnasDon/wacrm/issues/136), fixed in
  [#143](https://github.com/ArnasDon/wacrm/pull/143).

### Migration required

Apply against your Supabase project before deploying this version:

- `supabase/migrations/013_whatsapp_config_phone_number_id_unique.sql`
  — adds `UNIQUE(phone_number_id)` to `whatsapp_config`. **Fails
  loudly with a copy-pasteable resolution hint** if duplicate rows
  already exist; auto-deduping would destroy encrypted tokens, so
  the operator picks which row keeps the number. To check first:

  ```sql
  SELECT phone_number_id, array_agg(user_id) AS owners, count(*) AS n
  FROM whatsapp_config
  GROUP BY phone_number_id
  HAVING count(*) > 1;
  ```

  If that returns rows, `DELETE` the duplicate row(s) you want to
  drop, then re-run the migration.

### Note on multi-user setups

wacrm is intentionally **single-tenant per WhatsApp number**. RLS on
`conversations`/`messages` is `auth.uid() = user_id`, so a second
user physically cannot read messages routed to a different owner —
two users sharing one number was never supported. If you need
multiple humans handling the same inbox, run them under one shared
account.

## [0.2.0] — 2026-05-22

The **Flows** release. Adds a no-code, branching, button-driven WhatsApp
conversation engine that runs alongside Automations. Also ships a
5-theme color picker in Settings and opens Flows to all users.

### Added

#### Flows — branching chatbot conversations

- **Module + schema.** New `flows`, `flow_nodes`, `flow_runs`,
  `flow_run_events` tables with partial unique indexes that enforce
  one active run per contact. Widened `messages.content_type` CHECK
  to accept `'interactive'`; added `interactive_reply_id` column so
  the inbox can render button/list taps.
  ([#112](https://github.com/ArnasDon/wacrm/pull/112))
- **Runner engine.** `dispatchInboundToFlows` parses every inbound
  webhook, decides whether the message is a reply on an active run
  or a fresh trigger, advances the state machine, and reports back
  to the webhook so consumed messages don't also fire automations.
  Idempotent on Meta's `message_id`.
  ([#114](https://github.com/ArnasDon/wacrm/pull/114))
- **No-code builder UI** at `/flows`. Linear-list editor with
  per-node config forms, live validator, draft/active/archived
  status, and a 5-route REST API (`GET/POST /api/flows`,
  `GET/PUT/DELETE /api/flows/[id]`, `POST /api/flows/[id]/activate`,
  `GET /api/flows/[id]/runs`, `GET /api/flows/templates`).
  ([#115](https://github.com/ArnasDon/wacrm/pull/115))
- **Templates + v1.5 node types.** Three starter templates
  (Welcome menu, FAQ bot, Lead capture) cloneable from the New-flow
  dialog. Three new node types: `collect_input` (capture customer
  text into a variable), `condition` (branch on var / tag / contact
  field), `set_tag` (add or remove a tag). `{{vars.X}}` interpolation
  in send_message + collect_input prompts. Per-flow run-history
  viewer at `/flows/[id]/runs`.
  ([#117](https://github.com/ArnasDon/wacrm/pull/117))
- **Stale-run sweep cron** at `GET /api/flows/cron` — marks runs
  past their configured timeout (default 24h) as `timed_out` so
  abandoned conversations free up the contact for new triggers.
  Reuses `AUTOMATION_CRON_SECRET`.
  ([#114](https://github.com/ArnasDon/wacrm/pull/114))

#### Color themes

- **5 color themes** (Violet default, Emerald, Cobalt, Amber, Rose)
  selectable from a new **Appearance** tab in Settings. CSS variables
  scoped under `html[data-theme="..."]`, applied at runtime via
  `dataset.theme`, persisted to `localStorage`. Inline boot script in
  `layout.tsx` replays the choice before first paint so there's no
  flash of the default.
  ([#132](https://github.com/ArnasDon/wacrm/pull/132))
- **Theme tokenization sweep** — every previously hard-coded
  `violet-*` Tailwind class replaced with `primary` tokens across
  ~49 files. Picking a non-violet theme now themes the whole app,
  not just the chrome.
  ([#133](https://github.com/ArnasDon/wacrm/pull/133))

### Changed

#### Flows — soft-GA

- **Flows is now available to every authenticated user.** The
  per-account beta gate is gone; the sidebar entry + page header
  carry a small "Beta" chip as the only remaining signal.
  ([#134](https://github.com/ArnasDon/wacrm/pull/134))
- **Editor UX**:
  - Internal `node_key` + per-button/row `reply_id` identifiers
    hidden behind a per-node "Show advanced" disclosure.
    ([#118](https://github.com/ArnasDon/wacrm/pull/118))
  - `send_list` nodes can have multiple sections.
    ([#119](https://github.com/ArnasDon/wacrm/pull/119))
  - Collapsed node cards show a 1-line content preview per node
    type (text excerpt, button titles, condition summary, etc.).
    ([#120](https://github.com/ArnasDon/wacrm/pull/120))
  - Validation issues are clickable: jump to + flash the offending
    node.
    ([#121](https://github.com/ArnasDon/wacrm/pull/121))
  - Unsaved-changes "● Edited" indicator + `beforeunload` reload
    guard.
    ([#122](https://github.com/ArnasDon/wacrm/pull/122))
  - New-flow dialog actually widens to fit the 3 template cards
    (was capped at 384px by a baked-in `sm:max-w-sm` from shadcn).
    ([#129](https://github.com/ArnasDon/wacrm/pull/129),
    [#131](https://github.com/ArnasDon/wacrm/pull/131))
  - Validation panel pinned to the viewport bottom so
    activate-readiness follows the user as they scroll through nodes.
    ([#130](https://github.com/ArnasDon/wacrm/pull/130))

#### Engine reliability

- **Atomic `execution_count` increment** via SECURITY DEFINER RPC —
  prevents lost counts when two webhooks start runs concurrently.
  Mirrors the automations engine pattern.
  ([#124](https://github.com/ArnasDon/wacrm/pull/124))
- **Preload all flow_nodes once per dispatch** — one SELECT per
  inbound instead of one per advance-loop iteration. A 5-node
  auto-advance chain now costs 1 round trip, not 5.
  ([#125](https://github.com/ArnasDon/wacrm/pull/125))
- **Wasted re-read dropped** after reprompt reset; `loadActiveRun`
  switched to defensive `.limit(1)` so a migration glitch producing
  duplicates can't crash dispatch.
  ([#126](https://github.com/ArnasDon/wacrm/pull/126))

### Security

- **PII redacted from `reply_received` event payload** — customer
  text is no longer persisted to `flow_run_events.payload`; only
  the length is. A `collect_input` prompt asking "what's your card
  number?" used to leave the PAN sitting in the events table.
  ([#123](https://github.com/ArnasDon/wacrm/pull/123))
- **Constant-time cron-secret compare** on `/api/flows/cron`
  (`crypto.timingSafeEqual`) to close a theoretical
  timing-side-channel on the `x-cron-secret` header check.
  ([#127](https://github.com/ArnasDon/wacrm/pull/127))

### Fixed

- **`/flows` no longer spuriously redirects to `/dashboard`** when
  navigating in. Root cause: `useAuth` flipped `loading: false`
  before the profile fetch resolved. `use-auth` now exposes a
  separate `profileLoading` boolean.
  ([#128](https://github.com/ArnasDon/wacrm/pull/128))

### Migration required

Apply, in order, against your Supabase project:

1. `supabase/migrations/010_flows.sql` — Flows core tables, indexes,
   RLS policies, and the `messages` schema widening.
2. `supabase/migrations/011_profile_beta_features.sql` — adds the
   `profiles.beta_features` column. Surviving for future betas;
   Flows no longer reads it.
3. `supabase/migrations/012_flows_increment_counter.sql` — atomic
   counter RPC. Without this the engine still runs but
   `flows.execution_count` is racy.

Each migration is idempotent — safe to re-run if you're not sure
whether you applied a previous one.

### Removed

- **`src/lib/flows/feature-flag.ts`** + its tests. Flows is open to
  all users; the `profiles.beta_features` column itself survives
  for future beta gates.
  ([#134](https://github.com/ArnasDon/wacrm/pull/134))

---

## [0.1.1] — 2026-05-19

### Added

- Chat actions in the inbox: emoji reactions, reply-with-quote, and
  copy-text on individual messages. Hover on desktop, long-press on
  touch. Outbound reactions and replies forward to WhatsApp via the
  Cloud API; inbound reactions and swipe-replies from customers
  arrive through the webhook and appear in real time.

### Migration required

- Apply `supabase/migrations/009_message_actions.sql` to your
  Supabase project. It adds `messages.reply_to_message_id` and the
  new `message_reactions` table (with RLS and realtime). The
  migration is idempotent — safe to re-run.

### Changed

- The webhook no longer stores inbound customer reactions as fake
  text messages. They are written to `message_reactions` instead,
  so any custom queries that counted reactions as messages will
  need updating.

---

## [0.1.0]

Initial template release. Core CRM: inbox, contacts, pipelines,
broadcasts, automations (with a Wait-step cron drain), WhatsApp
Cloud API integration, Supabase auth + RLS.
