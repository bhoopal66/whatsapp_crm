# Smart insights (Jev)

Smart insights are the CRM features that use Jev, TypeSafe's System One
model, outside the AI auto-reply bot. Jev does not write messages: it
reads a conversation and answers narrow questions about it (which tag
fits, how close a customer is to applying, whether a draft promises an
approval), with probabilities. The CRM's own code decides what to do
with the answers.

They run on the same TypeSafe gateway as the bot's safety checks
(`docs/typesafe.md`): the same API key, the same PII guard and size
budget, and their own circuit breakers. Unlike the safety checks they
are **selection judgments**: they never send, block or opt anyone out,
write no `ts_decision_log` row and have no Live/Monitor mode.

## Requirements

- `TYPESAFE_API_KEY` set on the server.
- The workspace listed in `TS_ACCOUNT_IDS` when that allowlist is set.
- An admin switches each feature on in **Settings → Smart insights**.
  Every feature is off until then, and an install without a key or a
  workspace outside the allowlist behaves exactly as before.

When Jev is slow or unreachable, every feature falls back to what the
CRM did before it: no badge, no suggestion, no warning, keyword
matching only.

## Settings

Admins and owners switch each feature on in **Settings → Smart
insights** (`ai_insight_settings`, migration 147, one row per workspace;
no row means everything is off). Everyone on the staff can read the
settings, so the inbox and the composer know which features are on;
only admins and owners can change them. A save is version-checked: if
someone else saved in between, the screen asks you to reload instead of
overwriting their change.

| Setting                                       | What it does                                                                                                                                                                                                                              |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Customer insights                             | Shows what each customer wants, how close they are to applying, and who is upset or urgent: in the inbox, on the customer page, on deals and on the home page.                                                                            |
| Chat tag suggestions                          | **Off**, **Suggest** (a one-click suggestion in the chat header) or **Auto** (also tags untagged chats on its own when Jev is at least the chosen percentage sure). Auto never changes a tag a person set.                                |
| Campaign reply sorting                        | Sorts replies to a broadcast into interested, question, not now, not interested, wrong person, stop and other; optionally tags interested replies with a chosen main tag.                                                                 |
| Message check before sending                  | **Off** or **Warn**: agents see a warning before sending a message that promises an approval, quotes an unconfirmed rate, names a bank you don't work with, asks for card details or OTPs, or reads like spam. It never blocks a message. |
| Flows and automations that understand meaning | Lets flow and automation triggers match what the customer means, not only exact keywords, and lets flows understand typed answers to buttons and lists.                                                                                   |

When Jev isn't available for the workspace (no `TYPESAFE_API_KEY`, or
the workspace isn't in `TS_ACCOUNT_IDS`), the screen says so and the
switches are disabled.

## Customer insights

With **Customer insights** or **Chat tag suggestions** switched on,
every inbound customer text (a media caption included) is judged once,
after the message is saved and after TypeSafe's opt-out watch, at the
end of the webhook's background work: off the reply path, so the
customer, the bot and the next message never wait for it.

- **What is judged.** With Customer insights on: what the customer
  wants (intent), urgency, lead temperature, whether they are upset and
  whether they ask for a person. With Chat tag suggestions on: which of
  the workspace's main tags (and sub-tag) fits, over the tags' names and
  their "when does this tag apply" hints, in display order.
- **One request.** When the bot's triage or the opt-out watch already
  judged this exact message with the pinned Jev model, its figures are
  reused from that log row and Jev is asked only about tags, so one
  request covers both; with tag suggestions off, no request is made at
  all.
- **Forward only.** The figures are stamped with the message's own time
  (`insight_at`). A judgment of an older message that finishes after a
  newer one's does not overwrite it.
- **Suggestions.** A tag is suggested when Jev is at least 55% sure, no
  one dismissed that tag in this chat, and it would change the chat's
  tags; a sub-tag is included only when Jev is at least 55% sure of it
  too. Otherwise any earlier suggestion is cleared, so a stale one
  vanishes on the customer's next message.
- **Failures.** When Jev is slow or fails, nothing is written: the chat
  keeps what the last good judgment said.
- **Rate limit.** At most 120 judgments per workspace per minute; above
  that, messages are simply not judged.

The figures are display signals (badges, sorting, priority), never
actions: nothing here sends, tags, assigns or opts anyone out.

## What agents see in the Inbox

Only while Smart insights signals are on for the workspace; with them
off the Inbox and Team inbox fetch and look exactly as before.

- **One badge per chat**, in the row's top line, by precedence:
  **Urgent** › **Upset** › **Wants a person** › **Ready to apply** ›
  **Hot lead** (the loudest wins; a chat with none of these shows
  nothing). Hovering it lists what Jev last judged: lead band, what the
  customer wants, urgency, mood, and when it was updated.
- **Three filter chips** beside All / Unread: **Hot leads** (lead
  temperature at least hot), **Upset**, and **Needs attention**
  (priority 1 or 2). They narrow together and also work as a deep link,
  `?insight=hot,upset,attention`.
- **The Urgent pin.** An urgent chat (priority 2) that is still unread
  is pinned under the Important chats with a red **Urgent** label, newest
  first, until someone reads it. An Important chat stays with the
  Important ones.

## Chat tag suggestions

<!-- section: C -->

## Campaign reply sorting

<!-- section: D -->

## Message check before sending

<!-- section: E -->

## Flows and automations that understand meaning

<!-- section: F -->

## Compass status to case stage

**Settings → Cases → Compass status mapping** (owners and admins, migration
151). Compass reports each application's `status`. A status that names a
stage of the case's bank list moves the case there (migration 137), but
Compass now sends its own names ("Bank Review", "Returned to RO"), which
match no stage, so those cases stopped moving. The card lets an admin say
"this status means that stage"; a mapping also overrides a stage of the
same name.

- **Unmapped statuses** are the statuses with no mapping held by open cases
  whose bank list has no stage of that name, most open cases first. A
  mapped status is never listed here (there is one mapping per status for
  the whole workspace, so offering it again would silently re-target it). Each row shows how many open
  cases hold it, Jev's suggestion ("Under review · 87%", or "No stage change"
  when Jev thinks the status names no stage), **Accept** (saves Jev's stage,
  recorded as *Suggested by Jev* with its probability), a stage picker with
  **Save** (recorded as *Set by admin*), and **Leave**, which hides the row
  until the page is reloaded and saves nothing. "No stage change" has no
  Accept: it is not a mapping, so the status simply stays unmapped.
- **How suggestions work.** The table paints first; Jev is asked in the
  background for the 30 unmapped statuses with the most open cases, shown
  the account's allowed stages and its existing mappings as examples, and
  answers a stage (or none) with a probability. Answers are cached for an
  hour per status, stage list and set of mappings (saving a mapping gives
  Jev a new example, so it is asked again), so only a cold load waits on
  Jev (5–15 s).
  A suggestion is advice: nothing is mapped until someone accepts or saves.
  Without Jev (Settings → Smart insights) the card says so and works by
  hand.
- **Final statuses** (`APPROVED`, `DECLINED`, `WITHDRAWN`, `CLOSED`) always
  close the case and cannot be mapped. Pre-submission and final stages are
  never offered as targets, and the server refuses them (`STATUS_FINAL`,
  `STAGE_NOT_ALLOWED`, `STAGE_NOT_CONFIGURED`).
- **Mapped statuses** list status → stage with who set it. A mapping also
  overrides a stage of the same name. A warning ("N open cases are at banks
  without this stage; they won't move") counts the open cases holding the
  status whose bank list has neither the mapped stage nor a stage of that
  name. Remove (with a confirm) deletes the
  mapping; cases already moved stay where they are.
- **Move N open cases now.** A mapping applies to the next status update
  Compass sends. Right after a save the row offers to move the open cases
  already holding that status; it re-applies the mapping through the same
  path a Compass update takes (same stage rules, actor the API), **forward
  only**: a case moves only when the mapped stage comes later in its bank
  list than its current stage, since the stored status may be older than a
  person's later move. It reports how many moved and how many did not
  (already there or further along, or their bank has no such stage).

## Lead score

<!-- section: H -->

## Knowledge gaps

Settings → AI Agents → Knowledge → **Unanswered questions** has two
views: **All questions** (every question the bot could not answer, as
before) and **Topics**, the default once any topic exists.

- **A topic** is a group of similar unanswered questions, shown by one
  representative question with how many questions it holds, when it was
  last asked, and up to three other ways it was asked. Grouping is by
  meaning when the account has an embeddings key, else by word overlap.
- **Coverage** says whether an approved answer already covers the
  topic: _No answer yet_, _Partly answered by …_ or _Answered by …_.
  An answered topic can still be handed off: the answer may not be
  approved yet, or may score below the approved-answer floor for a
  given wording. Jev also labels the topic's intent (POS machine,
  business loan, …).
- **Dismiss** hides a topic you do not mean to answer; **Reopen** brings
  it back. A dismissed topic stays dismissed when the questions are
  regrouped, unless 5 or more new questions arrive in it.
- Topics are **recomputed daily**. **Refresh** recomputes now, at most
  once every 10 minutes per workspace.
- **Write an approved answer** creates a draft approved answer with the
  topic's question and opens it in the Answers tab's editor. It only
  goes live once it is approved; closing the editor without saving
  deletes the draft.
- **Without Jev** topics still form, but carry no coverage badge and no
  intent.

## Privacy

What Jev receives is redacted text: phone numbers, emails, card and
account numbers and other identifiers are removed before a request
leaves the server, and a request that still carries one is refused
locally. No database id, contact name or phone number is ever sent;
dynamic options (your chat tags, flow buttons, case stages) are sent as
numbered choices and mapped back on the server.
