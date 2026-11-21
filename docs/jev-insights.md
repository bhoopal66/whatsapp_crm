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

| Setting                                       | What it does                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Customer insights                             | Shows what each customer wants, how close they are to applying, and who is upset or urgent: in the inbox, on the customer page, on deals and on the home page.                                                                                                                                                             |
| Pin until someone acts                        | Under Customer insights: four boxes (time pressure, asks for a person, upset, asks for a call back) choose which causes pin a chat to the top of the inbox. A pinned chat stays there until someone replies, clicks Handled, or closes it. A switch notifies the assigned person when a chat is pinned. All on by default. |
| Chat tag suggestions                          | **Off**, **Suggest** (a one-click suggestion in the chat header) or **Auto** (also tags untagged chats on its own when Jev is at least the chosen percentage sure). Auto never changes a tag a person set.                                                                                                                 |
| Campaign reply sorting                        | Sorts replies to a broadcast into interested, question, not now, not interested, wrong person, stop and other; optionally tags interested replies with a chosen main tag.                                                                                                                                                  |
| Message check before sending                  | **Off** or **Warn**: agents see a warning before sending a message that promises an approval, quotes an unconfirmed rate, names a bank you don't work with, asks for card details or OTPs, or reads like spam. It never blocks a message.                                                                                  |
| Knowledge-gap topics                          | Lets Jev label the intent of recurring unanswered questions and check whether an approved answer already covers them. Topics still form without it.                                                                                                                                                                        |
| Reminder suggestions in chats                 | Offers an "Add reminder" chip under a message that names a later time. See Reminder suggestions below. Off by default.                                                                                                                                                                                                     |
| Flows and automations that understand meaning | Lets flow and automation triggers match what the customer means, not only exact keywords, and lets flows understand typed answers to buttons and lists.                                                                                                                                                                    |

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
  whether they ask for a person, plus the deep figures: their mood
  (sentiment, very negative to very positive), the objections they
  raise (price, documents, eligibility, trust, timing, comparing; each
  shown at 60% or more), whether the message waits for a reply, and
  whether they ask to be called back. With Chat tag suggestions on: which of
  the workspace's main tags (and sub-tag) fits, over the tags' names and
  their "when does this tag apply" hints, in display order.
- **One request.** When the bot's triage or the opt-out watch already
  judged this exact message with the pinned Jev model, its five signals
  are reused from that log row and Jev is asked only the deep figures
  (and the tags, when suggestions are on): still one request per
  message.
- **Forward only.** The figures, deep ones included, are stamped with
  the message's own time (`insight_at`) in one update. A judgment of an
  older message that finishes after a newer one's does not overwrite it.
- **History.** Every judged message also leaves one row of figures
  (numbers and codes, never text) in `conversation_insight_events`; each
  chat keeps its newest 30. A failure there is logged and changes
  nothing else.
- **Pinned until someone acts.** A message that is urgent, asks for a
  person (85% or more), is upset (85% or more) or asks for a call back
  (75% or more) pins the chat, for the reasons switched on in Settings
  (all on by default), with the highest of them as its label: Urgent ›
  Wants a person › Upset › Asked for a call back. The pin carries the
  message's time. It is not set on a closed chat, nor when a person has
  already replied at or after that message (a judgment that lands after
  the answer). A chat already pinned keeps its time; a more important
  reason replaces the label. Only a person clears a pin: their reply,
  closing the chat, or **Handled**. Each pin, raise and clear is noted
  in the chat's events.
- **The bell.** A new pin (not a raised one) rings the bell once, when
  the workspace's "notify" switch is on, for the chat's assigned agent,
  else its owner, whichever is live staff in the workspace; nobody when
  neither is. The bell names the customer from the contact's name; that
  name never goes to Jev.
- **Suggestions.** A tag is suggested when Jev is at least 55% sure, no
  one dismissed that tag in this chat, and it would change the chat's
  tags; a sub-tag is included only when Jev is at least 55% sure of it
  too. Otherwise any earlier suggestion is cleared, so a stale one
  vanishes on the customer's next message.
- **Failures.** When Jev is slow or fails, nothing is written: the chat
  keeps what the last good judgment said.
- **Rate limit.** At most 120 judgments per workspace per minute; above
  that, messages are simply not judged.

The figures are display signals (badges, sorting, priority), and the
pin and its bell only ask for a person; neither is an action: nothing
here sends, tags, assigns or opts anyone out.

## What agents see in the Inbox

Only while Smart insights signals are on for the workspace; with them
off the Inbox and Team inbox fetch and look exactly as before.

- **Colour-coded rows.** Each row carries a left stripe in its signal's
  colour (the attention reason, else an urgent priority, else a hot or
  ready lead; none otherwise) and up to three small chips in its bottom
  line: the mood (wants a person, upset, very negative), the lead band
  (warm, hot, ready) and what the customer wants. On a narrow list the
  chips shrink to coloured dots. Hovering them lists what Jev last
  judged: lead band, what the customer wants, urgency, mood, and when it
  was updated. The colours are the same on every screen; the **What do
  the colours mean?** button beside the filter chips explains each one.
- **Pinned until handled.** A chat Jev flags for a person (urgent, wants
  a person, upset, or asked for a call back) is pinned at the top with a
  coloured label until a person replies, clicks **Handled**, or closes
  it, together with the chats the AI handed over (**Important**). Order:
  urgent › Important › wants a person › upset › call back, the longest
  waiting first. An older thread pinned while the Inbox is open moves to
  the top live. **Handled** appears on the row on hover or keyboard
  focus (always on touch screens); it unpins the chat at once and leaves
  it in the list.
- **Filter chips** beside All / Unread: **N pinned** (red when any is
  urgent) shows only the pinned chats; **Hot leads** (lead temperature
  at least hot), **Upset** and **High priority** (priority 1 or 2)
  narrow together and also work as a deep link,
  `?insight=hot,upset,attention`.

**The Customer insights card** sits in the Inbox's contact panel (kept
live as new judgments arrive) and on the customer page (read when the
page opens). Every value wears its colour from the legend. A pinned
chat shows a banner at the top ("Pinned — Wants a person · 10 minutes
ago") with **Mark handled** for agents and up (viewers see the banner
only); it clears the pin at once and puts it back if the save fails.
Below it: what the customer wants and how sure Jev is, plus "Waiting for
a reply" and "Asked for a call" when Jev reads those; a four-step lead
meter (Just curious, Comparing options, Hot lead, Ready to apply) with
the lead trend (Warming up / Steady / Cooling off); urgency; mood (the
sentiment band, Upset and/or Wants a person, and the mood trend; Calm
only once the upset figure has been judged and no sentiment is known);
what holds them back (one chip per objection, hidden when none); up to
two next best actions with a one-line hint; and tiny trend lines for
mood and lead over the chat's judged messages, read from the history
endpoint when the card opens and after each new judgment ("Not enough
history yet" below four messages; a failed read shows nothing). The
footer says when the judged message arrived and opens the colour
legend. A chat never judged says so instead. **Two home tiles** join "Needs
your attention": **Hot leads waiting** (lead temperature at least hot
and still unread, since conversations do not record who wrote last)
and **Upset customers waiting** (judged upset and still unread). Both
leave out chats the Campaign inbox holds, as the unread tile does, so
each count is what its link shows: each opens the Inbox (the Team inbox
for team leaders) with the matching filter and Unread
(`?insight=hot&filter=unread`). Card and
tiles appear only while signals are on.

## Chat tag suggestions

With **Chat tag suggestions** on, Jev reads each new customer message
(with the few turns before it) and judges which of your workspace's own
chat tags fits the chat: first the main tag, then, if that main tag has
sub-tags, which sub-tag. It chooses only from the tags in **Settings →
Chat tags**, and it reads each tag's optional **AI hint**, a short
plain-language "when does this tag apply" (for example "the customer
wants to apply for a loan"). A clear hint makes the suggestions better;
a tag without one is judged on its name. Jev can also answer "none of
these", and then nothing is suggested. A workspace with no main tags
gets no suggestions.

A suggestion is saved only if, when Jev answers, the chat's tags and
dismissal are still what they were when it asked and nothing has been
decided since it read the chat (`conversations.suggestion_basis_at`: the
server time at which the latest decision read the chat, which a
person's tag change moves to now), so a tag you set (even one you then
removed again) or a suggestion you dismissed while Jev was thinking is
never undone; Auto mode's tagging checks the same and does nothing when
the suggestion was refused.

### Suggest mode

When Jev is reasonably sure of a main tag (at least 55%) that would
change the chat, a suggestion chip appears in the chat header, with the
sub-tag too when Jev is as sure of that. **Apply** tags the chat
exactly as picking the tag yourself would. **Dismiss** removes the
chip, and that tag is not suggested again for that chat; Jev may still
suggest a different one. A suggestion clears itself when it goes stale:
each new customer message is judged afresh against the chat's current
tags, so a suggestion that no longer fits, or that the chat's tags have
since made pointless, is replaced or cleared. Suggestions are only ever
shown; in Suggest mode nothing is tagged without a person's click.

### Auto mode

Auto mode does everything Suggest mode does, and also tags a chat on
its own when all of these hold:

- the chat has **no main tag** yet. Auto mode never changes or removes
  a tag a person (or a flow or automation) set, and if someone tags the
  chat while Jev is still deciding, their tag wins;
- Jev is **at least the chosen confidence** sure of the main tag (the
  percentage set next to Auto, 60% to 99%, 85% by default);
- you have not dismissed that tag for that chat.

The sub-tag is set only when Jev is at least as sure of it; otherwise
the chat gets the main tag alone and you can add the sub-tag yourself.

An automatic tag counts exactly like a manual one: your "chat tag set"
automations run, and a pipeline stage linked to that tag opens or moves
the deal as it would for a person's tag. The chat shows a **Tagged
automatically** note in the thread (never sent to the customer), and any
suggestion chip is cleared, since the chat now carries the tag.

### Suggest a tag now

**Suggest a tag** in the chat header asks Jev straight away, on the
chat's latest customer message, without waiting for a new one. It
follows the Suggest-mode rules above (it can say "no confident
suggestion", "already tagged that way" or "you dismissed that tag"), and
it never tags the chat itself, in Auto mode either: applying the result
is your click. It is offered whenever Chat tag suggestions are not off
and Jev is available for the workspace.

## Campaign reply sorting

When **Campaign reply sorting** is on, Jev reads a customer's _first_
reply to a broadcast next to the broadcast itself (the template's text,
with every variable replaced by a neutral `[…]`: the customer's own
values, such as their name, are never sent) and sorts the reply into one
of seven classes:

| class            | the customer…                                                                          |
| ---------------- | -------------------------------------------------------------------------------------- |
| `interested`     | wants the offer, asks to go ahead, asks how to apply, or asks to be contacted about it |
| `question`       | asks a question about the offer before deciding                                        |
| `not_now`        | may be interested later but not now                                                    |
| `not_interested` | declines the offer but does not ask to stop all messages                               |
| `wrong_person`   | was the wrong person, never asked for it, or does not know the business                |
| `stop`           | asks to stop messages, unsubscribe or not be contacted again                           |
| `other`          | anything else: a greeting, an acknowledgement, an unrelated message                    |

The class and Jev's probability for it are stored on the recipient and
counted per broadcast on the broadcast's page. Only the first reply is
sorted; a second reply to the same broadcast is not. A message is sorted
against a broadcast only if it is the customer's first message since that
broadcast was sent to them: when an older broadcast went unanswered and
the customer replied to a newer one first, a later message is not judged
against the older one.

**When it runs.** On the inbound message itself, right after the reply
is matched to its broadcast and before the campaign's follow-up Flow
starts, with a budget of 1.5 seconds for the whole sorting (its lookups
included). If Jev has not answered by then, the Flow starts without a
class and the reply stays unclassified (the backfill below can sort it
later). A broadcast with no follow-up Flow does not hold anything up:
the sorting runs alongside the Flows step. A broadcast whose template has no
local copy in Settings → WhatsApp → Templates cannot be sorted: there is
nothing to read the reply against.

**In the follow-up Flow.** When a class came back in time, the run
starts with two more variables next to `campaign_reply` /
`campaign_reply_id` (see `docs/campaign-journeys.md`):

| var                               | value                                               |
| --------------------------------- | --------------------------------------------------- |
| `{{vars.campaign_reply_class}}`   | the class, e.g. `interested`                        |
| `{{vars.campaign_reply_class_p}}` | Jev's probability for it, two decimals, e.g. `0.86` |

Both are absent (not empty) when no class came back. A first
**condition** node on `var campaign_reply_class equals interested` sends
a typed "yes, how do I apply?" down the same branch as the "Interested"
button; `var campaign_reply_class present` tells a sorted reply from one
that was not judged in time.

**Tagging interested replies.** If you pick a tag under _Tag interested replies with_
(a main chat tag), a reply sorted `interested` with a probability of at
least 0.7 tags the chat with it. That happens after the Flows step, so
the follow-up Flow's first message goes out first, and only on a chat
with no main tag: a tag a person set is never changed. The tag change
runs your `chat_tag_set` automations and the pipeline deal trigger, as a
manual tag does.

**Backfill.** Replies that arrived before the switch was on (or that
ran out of time) can be sorted from the broadcast's page. One press walks
through every unsorted reply once, in batches of up to 500 (about 25
seconds each), judging each recipient's first customer message after the
broadcast was sent to them, and stops at the end of the list or at the
first error. A reply that cannot be sorted (no text message, such as a
voice note) is passed over and stays unsorted; it never holds up the
replies after it.

**"stop" is display-only.** Sorting a reply as `stop` changes nothing:
the contact is not marked opted out by this feature. Opt-outs stay with
the opt-out watch (`docs/typesafe.md`), which reads every inbound
message the bot did not judge and acts when it is switched on.

## Message check before sending

**Settings → Smart insights → Message check before sending** (off by
default; owners and admins switch it to **Warn**). When it is on, the
inbox composer checks a message before it goes out:

- **What is checked:** free text an agent (or anyone above) types and
  sends, including the caption of a photo, video or document, once it is
  at least 12 characters long (spaces at either end don't count).
  Templates, interactive messages, voice notes and attachments without a
  caption are never checked.
- **What happens:** if nothing is found the message goes straight out.
  If something is, a **Check this message before sending** box lists
  each warning in plain words. **Edit message** closes it with the text
  still in the box, ready to change (closing the box any other way does
  the same); **Send anyway** sends it exactly as written, with the same
  reply quote, number and attachment.
- **It never blocks.** The check waits about 2.5 seconds at most. If it
  fails, is rate-limited or takes longer, the message is sent as if the
  check were off. While it runs the send button shows a spinner, so a
  second press does not send twice. Switching to another chat while it
  runs (or while the box is open) sends nothing: the text and its reply
  quote wait in the chat they were written in (put back into its empty
  box when you return), the new chat starts with an empty box, and a
  notice says the message was not sent.

What each warning means:

| Warning                  | Meaning                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Asks for secrets         | It asks for card numbers, CVV, PIN, OTP or passwords. Never ask for these in chat.                                 |
| Promise                  | It sounds like it promises an approval or a timeline. Only the bank can decide.                                    |
| Rates and amounts        | It quotes a rate, fee or amount. Make sure the bank has confirmed it.                                              |
| Regulator claim          | It says the company is licensed or regulated by the Central Bank.                                                  |
| Bank you don't work with | It names a bank outside the account's partner-bank list.                                                           |
| Cold pitch               | The message would start a new chat and reads like a marketing blast, which can get the WhatsApp number restricted. |
| Tone                     | It may come across as rude or dismissive.                                                                          |

The box lists them most serious first, in that order. Some are fixed
rules (secrets, partner banks, regulator wording) and some are Jev
judgments; without Jev only the rules run.

The cold-pitch warning applies only to a message that would **start** a
chat on a phone number (Whapi or OpenWA), using the Team activity
definition: no message in the conversation for 24 hours, unless the
customer wrote last (then it is a late reply, not a start). Replies and
Meta Cloud API numbers never get it.

**What is stored:** for a message that got warnings, the warning codes,
who sent it, the chat, and the agent's choice (sent anyway, edited, or
still pending if the page was closed). The message text is never
stored.

**Stats:** under the setting, owners and admins see a **Last 7 days**
line: how many warnings were shown, how many were sent anyway and how
many edited, and the three most common warnings. It is hidden when there
were none.

## Flows and automations that understand meaning

A keyword trigger misses every customer who says the same thing in other
words or another language. With **Flows and automations that understand
meaning** on, a flow can start on a **Customer means…** trigger and an
automation can fire on one (`intent` on a flow, `intent_match` on an
automation). Owners and admins set it up in the Flow or Automation
builder: pick **Customer means…** as the trigger and fill in three things.

- **What the customer means** (10–300 characters). Describe the
  customer's goal in plain words, as you would brief a new colleague:
  _wants a card machine for their shop_, _asks to cancel their
  application_. Name one need per trigger. Don't list keywords, and don't
  describe your reply ("send the pricing sheet"); describe what the
  customer wants.
- **Example messages** (optional, up to 5, 120 characters each). Real
  wordings customers use, ideally varied: a short one, a long one, one in
  Arabic or with typos. Examples sharpen the description; they are not
  matched word for word.
- **Sensitivity**: **Strict** fires only on clear matches (85% or more),
  **Balanced** (the default) at 75%, **Loose** at 65%, catching more
  rewordings at the cost of more false starts. The percentages have not
  yet been calibrated against real traffic.

**Test a message** under the fields: type a message a customer might
send and see _Matches (82%)_ or _Doesn't match (31%)_ against the chosen
sensitivity. It needs the setting on and Jev available, is limited to 20
tests a minute per person, and stores nothing. Use it with a few
messages that should match and a few that shouldn't before switching a
flow or automation on.

The trigger saves whatever the setting says, but while the setting is
off (or Jev is unavailable) the builder shows a warning and the trigger
never fires.

**Which trigger wins.** An inbound message is offered to, in order: a
flow run already active for the customer, the campaign follow-up flow
(the first reply to a broadcast that has one), keyword and first-message
triggers, and only then meaning triggers. So a meaning trigger never
takes a message a keyword would have caught. Among meaning-triggered
flows, the one Jev is most sure of (at or above its own sensitivity)
starts; a tie goes to the most recently edited flow.

**One automation per message.** At most one `intent_match` automation
runs for a message: the one Jev is most sure of (at or above its own
sensitivity), a tie going to the most recently edited, as for flows. And
none runs when a `keyword_match` automation already acted on the same
message: a keyword wins over a meaning, for automations as for flows.

**One request per message.** Flows and automations share a single Jev
request per inbound message. Whichever engine asks first asks about
every active meaning trigger of the workspace, flows and automations
alike (the list is re-read at most every 30 seconds), so the other finds
its answers already there. The request has a 2-second deadline; when it
fails or times out, no meaning trigger fires for that message and it is
not asked again; keyword triggers are unaffected. Only typed text is
judged. One request judges at most 20 triggers: with more active, flows
come first, then the most recently edited, the rest cannot fire, and the
server log warns (at most once an hour per workspace). A trigger whose
saved description is invalid (for instance empty after an API edit) is
skipped.

**Automations step aside for flows.** Like `keyword_match`, an
automation's `intent_match` is not run when a flow (or the journey bot)
consumed the message.

**Typed answers to buttons and lists.** With the same setting on and Jev
available, a flow waiting on buttons or a list also accepts a typed
answer. In order: the option's **label** (case, Arabic diacritics and
tatweel, emoji, spacing and surrounding punctuation are ignored; a text
that names two options matches neither), its **number** in the order
shown (`2`, `2.`, `#2`, `option 2`, `number 2`, `٢`; not `no 2`, which
may mean "not 2"; a list counts rows across its sections, as the
numbered menu on an OpenWA number prints them; skipped when an option's
own label is a number), and then its **meaning**: one Jev request with a
1.2-second deadline, so a miss delays the fallback only briefly,
accepted when Jev picks an option rather than "none of these" and is at
least 75% sure (not yet calibrated against real traffic). A text over
160 characters is a question, not an answer: it is not sent to Jev (a
label or number still matches). A match moves the flow on exactly as a
tap would, and once the move has gone through the run's history records
how it matched (`matched_by`: `label`, `number` or `meaning` with its
probability). When nothing matches, or
the setting is off, the flow's fallback (reprompt, hand off, end, ignore
or AI) runs as before.

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
  recorded as _Suggested by Jev_ with its probability), a stage picker with
  **Save** (recorded as _Set by admin_), and **Leave**, which hides the row
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

Pipelines deal cards carry a **lead score** while Customer insights
(Smart insights signals) are on: a 0 to 100 figure such as "84 · Hot" on
every open deal. With signals off, nothing is read and nothing is shown.
Won and lost deals get no score.

What goes into it, in points out of 100 when every figure is known:

| Factor           | Weight | From                                                             |
| ---------------- | ------ | ---------------------------------------------------------------- |
| Lead temperature | 40     | Jev's lead temperature for the customer's chat (0..3)            |
| Recent activity  | 20     | the chat's last message, fading to nothing over 14 days          |
| Urgency          | 15     | Jev's urgency for the chat (0..2)                                |
| Stage progress   | 15     | how far along the pipeline's stages (by their order) the deal is |
| Waiting on us    | 10     | the chat has unread customer messages                            |

- **Bands.** Hot at 70 or more, Warm at 40 or more, Cold below.
- **At risk.** A small warning dot marks a deal whose customer seems
  upset (Jev's dissatisfaction band), or whose chat has had no message
  for 14 days or more. Silence counts from the later of the last message
  and the deal's creation, so a deal opened yesterday is not at risk.
  "Last message" is the chat's latest in either direction: conversations
  keep no separate customer-only time.
- **Reasons.** The tooltip lists up to three reasons in plain words, risks
  first ("Customer seems upset", "No message for 2 weeks"), then what
  brought the most points ("Ready to apply", "Customer is waiting on a
  reply", "Late in the pipeline"…).
- **Activity only.** A chat Jev has never judged has no temperature or
  urgency; the score is then worked out over activity, waiting and stage
  alone (rescaled to 100) and the tooltip says "Based on activity only".
- **Stage only.** A deal with no conversation data (no contact, a contact
  with no chat, a chat the viewer cannot see, or a failed read) is scored
  on its stage progress alone, rescaled to 100, and the tooltip says
  "Based on the deal's stage only". Silence is counted only when the
  chat's last message time is known, so such a deal is never marked
  at risk for quiet it cannot see.
- **Sorting.** The board's **Sort** menu (shown with the score) offers
  **Sort by lead score**: highest first within each stage column, deals
  without a score last. The default order (newest first) is unchanged.
- **A guide.** The weights and bands are uncalibrated first judgments,
  not fitted to won and lost deals. Use the score to decide where to look
  first, not as a forecast. It is computed in the browser from figures
  the viewer may already read; who sees a deal is unchanged.

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
- **The Jev labels and coverage need the Knowledge-gap topics switch** in Settings → Smart insights; it is off until an admin turns it on.
- **Without Jev** (or with the switch off) topics still form, but carry no coverage badge and no
  intent.

## Reminder suggestions

When a WhatsApp chat message names a later time, Jev may offer a small
chip under it, such as **Add reminder · Tomorrow 15:00**. This covers a
customer's inbound message and a person's own text sent from the inbox.

- **Add reminder** opens the chat header's **Remind me** dialog
  prefilled: the title comes from the kind of thing ("Call Ahmed"), the
  time is the one found, and the message is the note. Saving files the
  usual follow-up task (`kind` `follow_up`, `source` `chat`). It shows on
  the calendar, the customer page and the home Tasks panel, and the chip
  becomes **Reminder set**.
- **×** hides the chip for everyone; **Undo** brings it back.
- If the task is deleted, the chip offers **Add** again.
- Agents and up see the chip and act on it. Viewers see no chip.

**Off by default.** Turn it on in **Settings → Smart insights →
Reminder suggestions in chats** (`ai_insight_settings.reminder_suggest_enabled`,
migration 197). Like every Smart insights feature it also needs Jev
available: `TYPESAFE_API_KEY` set and the workspace in `TS_ACCOUNT_IDS`.

### How a message is judged

`src/lib/reminders/suggest.ts` runs these steps in order and never
throws:

1. The message's text, at most 1,000 characters. For a customer that
   is what they typed, a media caption, or the title of a button or
   list option they tapped (a tapped "Call me tomorrow" is a request
   too). A person's own send counts only when it is plain text.
2. The time finder (`src/lib/reminders/time-phrases.ts`) looks for a
   time. It reads English and Gulf/MSA Arabic, Arabic-Indic digits and
   day-first dates. A day with no time means 09:00. A bare hour from 1
   to 7 is PM, 8 to 11 is AM. Past words such as "yesterday" or "امس"
   never count. It works in the workspace's saved time zone (Team
   activity settings), else UTC.
3. Only times at least 2 minutes ahead are kept.
4. Company chats only; a personal-number chat is never judged.
5. At most 60 judgments per minute per workspace.
6. One Jev request (`qs-reminder-v1`) asks whether the message is
   something to be reminded of, what it is about (call, documents,
   payment, meeting, other), and which time it means when it names
   several.
7. The suggestion is stored when Jev's probability is at least 0.6.

The message is redacted and clipped before it reaches Jev. The times go
as ordinal options. No ids or names are sent.

Never judged: our own templates, media and interactive messages,
replies from the bot, automations, flows or AI, public-API sends, and
personal-number chats.

### Storage and access

`message_reminder_suggestions` holds one row per message. Whoever can
see the chat can read the row (RLS: same workspace and the chat visible
to them). Only the service role writes it. The chip's actions go
through `POST /api/inbox/reminder-suggestions/[id]` with `added` plus the
task id, `dismissed`, or `reopen`. Each is a compare-and-set: it answers
409 when someone else got there first.

### Calibration

On 2026-11-12, against the real model (jev-1.13.0), 22 synthetic English
and Arabic messages: 21 agreed with the expected answer at 0.6. Opening
hours, delivery estimates and greetings were rejected. The one miss was
"Good night, talk tomorrow".

## Privacy

What Jev receives is redacted text: phone numbers, emails, card and
account numbers and other identifiers are removed before a request
leaves the server, and a request that still carries one is refused
locally. No database id, contact name or phone number is ever sent;
dynamic options (your chat tags, flow buttons, case stages) are sent as
numbered choices and mapped back on the server.

## Desk case suggestion

`desk_case` (migration 235, `lib/desk/suggest.ts`, `qs-desk-case-v1`):
which candidate case a desk tray document belongs to. Ordinal options
(`c1 … cN`, `unsure`); the state carries the document's type, file name
and caption and each candidate's bank, product and missing documents,
all through `redactClipped`, never a company or person name or an id.
Asked only when a person presses *Suggest a case*; advice only, never
pre-selected; no suggestion under 0.6 or within 0.1 of the runner-up.

