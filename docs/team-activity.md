# Team activity

Team activity (sidebar → Team → **Team activity**, owners and admins) shows who
starts WhatsApp chats, how many of those chats get an answer, and the
sending habits that get a phone number restricted. It also drives three
things employees see: warnings above the composer, bell alerts, and the
hard restrictions that refuse a send over the limits (on by default, see
**Hard restrictions**).

It needs migrations `068_team_activity.sql` and
`073_team_activity_accuracy.sql`, and `145_team_activity_openwa.sql` for
OpenWA numbers. The hard restrictions, unlock requests and the My activity
page need `204_team_activity_enforcement.sql`,
`205_team_activity_unlocks.sql` and `206_team_activity_self_view.sql`,
applied in that order **before** the build that uses them: the new build
calls the three-argument `team_activity_start_check`, and before 204 every
human send would be allowed.

## Phone numbers and official numbers

Team activity sorts every WhatsApp number into one of two kinds:

- a **phone number**: a number paired to a phone as a linked device,
  connected through Whapi or OpenWA (`docs/openwa.md`). Both carry the
  same ban risk, so since migration 145 they are counted the same way
  everywhere on this page;
- an **official number**: the Meta Cloud API number.

## Why it matters on phone numbers

A phone number (Whapi or OpenWA) is an ordinary WhatsApp account driven
through a linked device. WhatsApp restricts or bans such numbers based on what recipients
do with their messages. Its main signals are unanswered first messages,
blocks and spam reports. Whapi's guidance:

- [How to not get banned](https://support.whapi.cloud/help-desk/blocking/how-to-not-get-banned)
- [Warming up new numbers](https://support.whapi.cloud/help-desk/blocking/warming-up-new-phone-numbers-for-whatsapp-api)
- [Safety Meter](https://support.whapi.cloud/help-desk/tools/whatsapp-activity-safety-meter)

In short, the guidance is:

- aim for at least 30 replies per 100 chats you start;
- start a new number at 5–10 new chats a day and raise it over two
  weeks;
- avoid bursts: about one or two messages a minute at most;
- don't send links, or the same text to many people, in a first
  message;
- don't keep writing to someone who doesn't answer. Five to ten
  complaints from first-time recipients can be enough for a ban.

A Meta Cloud API number cannot start a chat without an approved
template. Meta enforces its own quality rating there, so the new-chat
limits and composer warnings apply to phone numbers only. Meta numbers
still appear in the report.

## How the figures are counted

These definitions live in SQL (`team_activity_starts`,
`team_activity_report`). Change the code and this section together.

| Term | Meaning |
|---|---|
| **Chat started** | A message sent (by a person, the API or a bot) into a conversation that had no message from anyone in the previous 24 hours. This is WhatsApp's own business-started conversation. If the customer wrote last, the message is a reply, however late. |
| **New contact** | A started chat with someone who had never written to us before it. |
| **Replied** | The customer wrote back before the next chat was started with them. A contact messaged once a day for a week who answers only the last message gives 6 unanswered starts and 1 answered. |
| **Waiting for a reply (pending)** | A started chat less than 24 hours old that has no reply yet. It is too early to call it unanswered, so it is left out of the reply rate on both sides and shown on its own. |
| **Unanswered in a row** | The outbound messages since the customer last wrote, or since the start of the conversation if they never did. The run is counted from its real start, however long ago, not only inside the chosen range. A message whose position in that run is above the limit counts as one too many. |
| **Chasing** | The same run, but follow-ups sent within 10 minutes of the previous message count as one message. A chat goes past the limit on this count when the person keeps coming back to someone who does not answer. It is split into new chats (the customer never wrote in that conversation) and existing chats (they wrote before). |
| **Burst** | The most chats one person started within any 10 minutes. |
| **Night start** | A chat started inside the quiet hours (local time). |
| **Link in first message** | A first message to a new contact containing `http(s)://`, `www.` or `wa.me/`. |
| **Identical opener** | An opener of 20 or more characters whose text (case and spacing ignored) opened 5 or more chats on the same number in the range. |
| **Similar first message** | A first message that matches at least one other first message from the same sender in the range once names and details are taken out. Both texts are lower-cased; links, digits and punctuation are removed; every word after the first that began with a capital letter is dropped (names); spaces are collapsed and the first 60 characters compared. So "Hello Rahul, your order 1234 is ready" and "Hello Priya, your order 5678 is ready" are similar. |
| **Response time** | Median minutes from the first message of a customer's unanswered stretch to the reply. |
| **Customers waiting** | Open chats, assigned to the person, whose last message is the customer's. This is the state right now, not a range figure. The headline counts customers who wrote in the last 24 hours. Those who wrote between 24 hours and 7 days ago are shown separately as older. Anyone who wrote more than 7 days ago is not counted. Unassigned chats are counted the same way, on their own. |
| **Failed** | A message WhatsApp refused (status *failed*). It reached nobody, so it counts as a failure but never as a start or part of a run. Failures are counted separately for phone (Whapi or OpenWA) numbers and for official (Meta) numbers. Only phone-number failures raise a finding for a person. |

Sender rows:

- **People** are members (`messages.sender_id`). Every member is
  listed, including those who sent nothing.
- **API & integrations** are messages with no person: the public API,
  Compass notifications.
- **Bots & automations** are flows, automations and AI auto-reply.

The API and bots are not given replies or response times (those figures
are empty for them), because answering customers is not their job.

## Which number a message belongs to

A message belongs to the number recorded on it (`messages.channel_id`).
Whether that is a phone (Whapi or OpenWA) or official (Meta) number comes from
the number itself, or from the message's own provider when no number
is recorded. The conversation's current number is never used for this.

Older messages were stored without a number. Migration 073 filled them
in once: a message gets the account's number of its provider if exactly
one such number existed when it was sent. A conversation without a
number gets one by the same rule on its first message. Anything that was
ambiguous stays empty.

Chats started from a message with no number are counted as
**unattributed** (`unattributed_starts`). They count for the person who
sent them, but not in any number's row. So connecting a second number
no longer changes how older messages are counted.

The per-person limits protect the phone numbers. So a person's daily
count, busiest day, days over the limit, bursts and "today" include
only chats started on phone (Whapi or OpenWA) numbers.

Broadcasts are counted per person from `broadcast_recipients`. They
record no number, so a report narrowed to one number leaves them out.

Messages typed on the phone itself, outside the app, are not stored and
do not appear here. WhatsApp still counts them.

## Limits

Settings are per account (**Limits** on the page; table
`team_activity_settings`). Without a saved row the defaults apply. The
defaults are kept identical in the migration, `TEAM_ACTIVITY_DEFAULTS`
(`lib/team-activity/limits.ts`) and here; `limits.test.ts` checks the
first two.

| Limit | Default | Used for |
|---|---|---|
| New chats per person per day | 20 | composer warning from 80%, alert when reached, the block |
| New chats per phone number per day | 50 | warning from 80%, alert when reached, the block. Phone (Whapi or OpenWA) numbers only. A number connected less than 14 days ago is warming up and gets at most 10 a day (or the limit, if lower) |
| Minimum reply rate | 30% | flags below it, or within 10 points of it. Needs 10 started chats for a person, 20 for a number |
| Messages in a row without a reply | 3 | flags the next one |
| New chats per person in 10 minutes | 10 | burst flag |
| Quiet hours | 22:00–08:00 | night starts. Equal hours turn it off |
| Time zone | viewer's, until saved | what "today" means everywhere. Must be a named zone (`Asia/Dubai`): offsets like `+04` are refused, because Postgres reads their sign backwards |
| Bell alerts | on | see below |
| Hard restrictions | on | the master switch for **Hard restrictions** below |

A limit is reached when the count is equal to it, not only when it goes
over. The page, the bell alerts, the composer warnings, the block and a
number's "days at the limit" all count it this way.

The warm-up limit is used by the page, the composer, the block and the
bell alerts. The report shows it as `warming_up`, `age_days` and
`effective_daily_limit` on each phone number.

Saving the limits also saves the time zone. From then on the page, the
composer warnings, the alerts and the block all use the same day.

## What employees see

- **Composer warnings** (inbox, and Contacts → Send message) appear only
  when the message goes out on a phone (Whapi or OpenWA) number:
  - at 80% of the person's daily limit;
  - at the limit itself;
  - when the number is at its limit;
  - when the contact has not answered the last N messages;
  - a short tip before a first message to someone new.

  The person's counts come from `team_activity_my_day()`.
- **Bell alerts.** These start once an admin has saved the limits;
  until then nobody has chosen the limits or the time zone. The
  automation cron runs `team_activity_alert_sweep()` at most every 5
  minutes. When a person reaches their daily limit,
  they get a "you" notice and every owner and admin gets one naming
  them. When a phone number reaches its daily limit, owners and admins
  are told. Each alert fires once per person or number per local day
  (`team_activity_alerts`, kept 90 days). Turn alerts off with **Bell
  alerts**.
- **The block** is the hard restrictions below. It is no longer an
  option that is off by default.

## Hard restrictions

Migrations 204-206. The limits above stop being advice: a human send
that breaks a rule is refused before it reaches the gateway.

**Who and where.** On by default, also for an account that never saved
its limits (a missing settings row means every default below). Everyone
is bound except the **owner**; admins, team leaders and agents are not
exempt. Only company phone numbers are checked (Whapi and OpenWA with
`is_personal = false`), and only company chats. Personal numbers and Meta
numbers are never restricted. An admin switches the whole thing off with
**Hard restrictions** (`block_over_limit`, the master switch), or any
single rule off in Settings → limits → Restrictions (owners and admins).
Migration 204 turns the master switch on once for existing accounts;
re-running it does not undo a later "off".

**Start and reply.** A *start* is the definition above: no non-failed
message in the chat for 24 hours, unless the customer wrote last. Only
the chase rule also applies to messages that are not starts.

**The rules**, checked in this order; the first that applies refuses the
send. Each has its own switch (default on).

| Rule | Refuses when | Setting (default) |
|---|---|---|
| Unlock | not a rule: when a rule (or Jev) would block, an approved unlock for this person and chat is spent instead and the send goes out. A send no rule blocks leaves the unlock alone, and one the gateway then refuses gives it back | see Unlock requests |
| `chase` | the customer did not write last and this send would make more steps in a row than the limit. Only the last 7 days count, so old campaign messages never lock a chat. Messages less than 10 minutes after the previous one are one step; failed messages are not counted | `enforce_chase`, messages in a row 3 |
| `quiet_hours` | a start, with the account's local time inside the quiet hours (wrapping midnight; equal hours turn it off). Only once an admin has saved the limits: until then the time zone is unknown and the rule is skipped | `enforce_quiet_hours`, 22:00-08:00 |
| `daily_user` | a start, and the person's starts today on company phone numbers have reached the limit | `enforce_daily_user`, 20 a day |
| `daily_user_throttled` | the same, but the limit is cut to `reply_rate_throttle_pct` of itself (rounded up) because the person's reply rate over the last 7 days is below the minimum. Needs 5 starts older than 24 hours | `enforce_reply_rate`, 50%, minimum reply rate 30% |
| `daily_number` | a start, and the number's starts today, by anyone (people, bots, the API), have reached its limit (warm-up aware) | `enforce_daily_number`, 50 a day |
| `burst` | a start, and the person started as many chats in the last 10 minutes as the limit allows | `enforce_burst`, 10 |
| `link_first` | a start whose text contains `http(s)://`, `www.` or `wa.me/` | `enforce_links_first` |
| `same_opener` | a start whose text (same normalisation as *Similar first message*) matches that many of the person's own starts today | `enforce_same_opener`, 3 (1-50) |
| `jev_cold_pitch` | a start that Jev judges a cold pitch with probability at or above the threshold | `enforce_jev`, 0.85 (0.50-0.99) |

A blocked send returns HTTP `429` with code `restricted`, the rule, the
figures and whether it can be unlocked (the old `new_chat_limit` code is
gone). The composer shows a card naming the rule in plain words, keeps
the text, and offers **Ask to unlock** when unlocks are on. Every block is
recorded in `team_activity_blocks` (person, chat, number, rule, figures,
never the message text) and kept 90 days.

**Jev.** For a start that passes the rules above, the text goes to the
same cold-pitch question as the pre-send message check, with a 1.5 s
deadline, whatever the message-check mode is. Only the redacted state Jev
already gets leaves the server. Any Jev failure, timeout or mismatch lets
the message through.

**Unlock requests.** A blocked person, within 24 hours of the block,
asks with a reason of 5-500 characters (`allow_unlock_requests`, default
on; one pending request per person and chat). Every live owner and admin,
and the live leaders of the person's teams, get a bell
(`team_activity_unlock_request`, which never carries the reason) and
approve or deny it on **Team activity → Unlock requests**. Nobody
decides their own. An approval lasts 2 hours and covers the person's next
send in that chat, once; it is then used up. The person gets a bell with
the decision.

**Automatic senders.** Broadcasts, public API v1 sends, flows and
automations are checked against the number's daily limit only
(`enforce_auto_senders`, default on, together with `enforce_daily_number`).
A blocked broadcast stops on that number and its remaining recipients
stay pending: the campaign stays "sending" until someone presses Resume
after the day turns (the cron only picks up scheduled campaigns). The
API answers `429` `number_daily_limit`. A flow or automation records a
failed step. **Known limit:** the AI auto-reply (it only answers), Compass
notifications, HR automated messages and the journey bot are not
checked, and the last three can start a chat.

**Fails open.** Every SQL check lets the message through on an unexpected
error, and so does a Jev failure. A deliberate block is never swallowed.

**Who sees what.**
- Agents open **My activity** (`/my-activity`) with their own figures
  (today, 7 days, 30 days), findings worded for them, their blocks and
  their unlock requests. Switch `agent_view_enabled`, default on.
- Team leaders see their team's report (as under *Team leaders*) while
  `leader_view_enabled` is on, default on. With either switch off the
  report refuses that role, and that includes a leader's own My activity
  page. A person's own figures count every chat they started, including
  one later reassigned out of their sight, as the limits do.
- Team activity has a **Blocked sends** tab (by person and rule) and an
  **Unlock requests** tab with Approve and Deny, for leaders, owners and
  admins. Blocks are readable by the person, their leader and owners
  and admins (RLS).

## Whapi Safety Meter

The Safety Meter is Whapi's own API, so only Whapi numbers have one; an
OpenWA number's card shows none.

Each Whapi number's card shows Whapi's own rating, read with the
number's channel token from `https://tools.whapi.cloud/services/riskOfBlocking`
(`WHAPI_TOOLS_URL` overrides the host):

- overall;
- number age;
- response rate;
- contacts coverage.

Each is rated 1 (use caution), 2 (needs attention) or 3 (good). The page
reads the stored rating and caches it 15 minutes per server process.
**Recalculate** asks Whapi to compute it again; Whapi does so at most
once a day per number. The token Whapi echoes back is never passed to
the browser. An overall rating of 1 or 2 is flagged on the number.

## Access

- The page and the report route are open to team leaders and up; agents
  read their own figures through `/my-activity` while `agent_view_enabled`
  (`TeamLeaderOnlyLayout`, `requireRole('team_leader')`); the settings
  and Safety Meter routes stay owner/admin only.
- `team_activity_report` and `team_activity_chats` refuse anyone below
  team leader, and give a team leader their team only (see below).
- `team_activity_my_day` returns only the caller's own counts, plus how
  many chats each number started.
- `team_activity_start_check` acts only for the signed-in sender.
- `team_activity_alert_sweep` runs as the service role only.
- The behaviour is asserted in `supabase/ci/verify-team-activity.sql`,
  and the team scope in `supabase/ci/verify-team-activity-leaders.sql`.

## Team leaders

A team leader sees Team activity for their own team only: the members
of the teams they lead, plus themselves. The API, the AI assistant and
automations are left out. Every figure (people, days, hours, numbers,
customers waiting) counts only those people's messages. Customer
messages and waiting chats count when the chat is assigned to, or else
owned by, one of them.

Numbers shows the phone and official numbers the team used in the range
or that are allocated to one of its teams, with the team's own figures.
It also shows today's new chats on the whole number, against the
number's daily limit and status, so a leader can see a number filling
up. Only that count comes from outside the team, and no messages are
shown.

Opening a person outside the team answers "Unknown sender". Leaders can
read the limits but not change them, and get no Safety Meter.

In the bell, a leader is alerted when a team member reaches the daily
new-chat limit, and when a number allocated to their team reaches its
limit, once per day each. Owners and admins still see the whole
account, unchanged.
