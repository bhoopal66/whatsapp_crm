# AI agent

The auto-reply bot answers inbound WhatsApp messages with the AI
provider you configured (Settings → AI Agents). This guide covers how it picks
a model, what happens to a draft TypeSafe holds, when it pauses and
resumes, and how to find out why it did not answer a message.

Apply `supabase/migrations/077_ai_agent_v2.sql` and
`078_partner_banks_and_attention.sql` **before** deploying the build
that includes this behaviour; see the CHANGELOG.

## Model tiers

Settings → AI Agents → Assistant has three models:

| Tier     | OpenAI default      | Anthropic default   | Used for                                      |
| -------- | ------------------- | ------------------- | --------------------------------------------- |
| Small    | `gpt-5.4-nano`      | `claude-haiku-5-5`  | greetings, thanks                             |
| Standard | the account's model | the account's model | ordinary questions                            |
| Large    | `gpt-5.5`           | `claude-opus-5-5`   | multi-part, sensitive or negotiation messages |

Migration 077 fills Small and Large once for existing accounts, from the
provider. An empty tier falls back to the Standard model. A re-run never
refills a tier you cleared.

### Route each message to the right model

On by default. With it off, every message uses the Standard model.

1. **TypeSafe Jev judges the message.** One request returns the kind of
   message, how complex a good reply is, and whether it needs facts
   about your business. It has a hard deadline of 2.5 seconds and runs
   in parallel with triage, so it adds no wait. See
   [typesafe.md](./typesafe.md#route-judgment).
2. **Otherwise a simple rule decides.** This applies when there is no
   `TYPESAFE_API_KEY`, the account is not allowed, the judgment timed
   out, or another model answered:
   - a greeting or thanks of 5 words or fewer: Small;
   - more than 60 words, or two or more questions: Large;
   - everything else: Standard.

Further rules:

- A greeting that needs no business facts **skips knowledge
  retrieval**, so no embeddings call is made.
- A customer TypeSafe triage marks **urgent** or **ready to apply**
  never gets the Small model, and the prompt tells the model to
  acknowledge the urgency or give the next step.

### Escalation

- A tier model the provider **rejects** (for example, a model name your
  key cannot use; not a bad key and not a rate limit) is retried once on
  the Standard model.
- A Small-model reply that asks for a person is retried once on the
  Standard model before the chat is handed off.

## What the AI reads before answering

The bot looks up the knowledge base for the customer's **open
question**, not just their last message: every message since the bot
last spoke, newest turns kept. So a customer who sends two messages in
a row gets one answer to both.

A greeting or thanks does not replace the question. If the open
messages are only greetings, the bot also reads the customer's last two
earlier questions, so "Hi" after an unanswered question (or after a
hand-off farewell, once a person presses **Resume & reply**) still
retrieves for that question instead of answering it blind. A true first
"hi" still skips retrieval.

## Held drafts

When the TypeSafe guardrail holds a draft it really judged, the Large
model **rewrites it once**, given the guardrail's reasons. This is
Settings → AI Agents → Safety checks → _Rewrite a held draft once…_, on by default.

If the rewrite is held too, or TypeSafe could not judge (the fail-safe
hold), the chat goes to a person and the draft waits in the inbox
banner with three buttons:

- **Send draft**: send it as written.
- **Edit**: change it, then send.
- **Discard**: drop it.

The customer receives the hand-off message you configured.

Only a **hold** waits for review. A draft the guardrail **blocked**
(asking for a secret, sharing someone else's data, and similar) is never
queued for one-click sending. The chat is handed to a person, and the
blocked draft is quoted in the hand-off note for context. If two people
press **Send draft** at once, only one send goes out; the other gets
"already sent or discarded".

## Pause and resume

**A person replying pauses the bot in that chat.** Settings → AI Agents → Auto-reply → _Pause the
AI when a person replies_, on by default. A database trigger enforces
it, so every send path counts. Bot sends and API-key sends that carry
no user do not.

**Auto-resume.** Settings → AI Agents → Auto-reply → _Give the chat back to the AI after_:
Never, 30 min, 1 h, 4 h, 12 h or 24 h. The bot resumes on the
customer's **next message** after that much quiet from the person, and
only if nobody is assigned to the chat. Each new reply from a person
restarts the clock. **Hand-offs and Take over never auto-resume.**

The inbox banner says why the bot is paused:

| Banner                                | Cause                               |
| ------------------------------------- | ----------------------------------- |
| Took over                             | someone pressed Take over           |
| A person replied                      | the pause-on-reply rule             |
| Handed off                            | the bot handed the chat to a person |
| AI is off while this chat is assigned | the chat has an assignee            |

When the customer's message is waiting, the banner offers **Resume &
reply**, which answers it immediately.

## Important chats

When the AI hands a chat to a person, the chat is marked **Important**
until someone acts on it:

- It is **pinned at the top of the Inbox** with a red _Important_
  label, newest hand-off first.
- An **Important · N** filter chip shows only those chats.
- Inside the chat, a **red bar at the top** says the AI needs a person,
  with **Take over** and **Resume**.

The mark clears when a person replies, presses Take over or Resume, or
sends or discards a held draft. Assigning the hand-off agent does not
clear it. Chats handed off before migration 078 are marked once, when
it is applied, if the customer's message is still waiting.

**Hand-off notes** are plain sentences that lead with what to do, e.g.
"🤖 AI needs a person after 2 replies: the customer's message matched
the escalation keyword “refund”. Last customer message: “...”". They
no longer carry reason codes.

## Every number

**Settings → AI Agents → Auto-reply → Reply on every WhatsApp number.**

- **On:** the bot answers each chat on the number the customer wrote to,
  Whapi or Cloud API. Because it replies where the customer wrote, Meta's
  24-hour service window is open for a fresh inbound. Resume & reply
  skips a Meta message older than 24 hours. The AI's own number is set
  in the same place (Reply on); the switch overrides it.
- **Off (default):** the bot answers only on the number set for AI
  auto-reply in Settings → AI Agents → Auto-reply → Reply on (or the
  default number when there is no route).
- A chat a person **pinned to another number** is skipped
  (`skipped_number`) in both modes: the pin is a person's decision.

Needs migration 079. Before it, the bot keeps answering on its routed
number and the switch cannot load.

## Approved answers only (migration 081)

In this answer mode the bot **never writes text**. It sends one answer
an admin approved, word for word, or hands the chat to a person. The
default mode (`generate`) is unchanged.

For each message the bot is allowed to answer, in order:

1. The usual eligibility checks, the reply cap and the
   sensitive-data warning (below).
2. Escalation keywords, the account rate limit and TypeSafe triage
   (including its hand-offs and opt-out marking), exactly as in
   `generate` mode. The model router does not run: nothing is
   generated, so there is no tier.
3. A **shortlist** of up to 8 approved answers for the customer's open
   question (`kb_shortlist`, a lexical match; an account with at most
   12 approved answers gets all of them).
4. A **TypeSafe selection judgment** (`kb_select`) of every shortlisted
   answer: does it fully answer the question, and is it the same
   intent? Plus three hand-off conditions: a pricing request, a legal
   or regulatory question, an angry tone.
5. The **policy**: a hand-off condition at **0.5** or above hands off
   (reason `kb`). Otherwise the best answer's score is the lower of its
   two figures; below **Approved minimum score** (`approved_min_score`,
   default **0.8**, 0.5–0.99) it hands off (reason `no_knowledge`, and
   the question is logged as a knowledge gap). An Arabic message gets
   the Arabic answer; when that answer has none, or the message is in
   another language, it hands off (`no_knowledge`).
6. The chosen answer is **sent verbatim**. An answer marked _hand off
   after_ is sent and then the chat goes to a person (reason `kb`),
   with no second message: the answer was the farewell.

The guardrail does not run on approved answers: it screens text a model
wrote, and these were approved word for word.

Every doubt ends with a person, with the configured hand-off message:

| Situation                                                   | Hand-off reason |
| ----------------------------------------------------------- | --------------- |
| No approved answer shortlisted, or none scored high enough  | `no_knowledge`  |
| A pricing, legal or angry signal at 0.5+                    | `kb`            |
| An answer marked _hand off after_ (after sending it)        | `kb`            |
| The shortlist lookup failed                                 | `error`         |
| TypeSafe unavailable, failed or answered with another model | `error`         |
| Not enough of the dispatch budget left to ask TypeSafe      | `error`         |

**It needs TypeSafe.** Set `TYPESAFE_API_KEY` and list the account in
`TS_ACCOUNT_IDS`. Without them every message is handed to a person
("Approved-answer check unavailable (DISABLED)"): an answer nobody
judged is never sent. The selection is not a safety check, so the
switches under Settings → AI safety checks do not turn it on or off.

**Internal answers never reach customers.** `kb_shortlist` hard-codes
the two client audiences (prospective and existing clients) in SQL;
`internal_staff` rows are never returned to the bot, whatever the
caller asks.

### Importing answers

Answers are imported from the review spreadsheet: the sheet named
`Knowledge_Base` (else the first sheet with a question and an answer
column). Recognised columns: ID / Ref, Audience, Category, Question,
Bot answer (English), Arabic answer, Source, Status, Reviewer comments,
Handoff. Rows are matched by ref; rows missing from the file are left
alone. **Only rows with status Approved are ever sent.** An answer that
is blank or still contains a `[TO CONFIRM …]` placeholder can never be
approved: the import files it as _To confirm_, and the database refuses
it as approved.

### Sensitive-data warning

In **both** answer modes, when **Sensitive-data reply**
(`sensitive_data_reply`) is set and a customer message contains an
Emirates ID, a card number (Luhn-checked) or an IBAN, the bot sends
that text and nothing else for the message: no TypeSafe call, no model.
It counts against the reply cap. Empty means off. The outcome is
recorded as `replied`, "Sensitive-data warning sent".

## Why didn't the AI reply?

Every dispatch records an outcome on the conversation and in an events
table (admins read it). The banner warns **"AI didn't answer the last
message: <reason>"** for a wrong number, an automation that answered,
rate limiting, campaign-only mode, or a provider error.

| Outcome                 | Meaning                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------- |
| `replied`               | The bot sent a reply.                                                                             |
| `handed_off`            | The bot handed the chat to a person (a gate or the model).                                        |
| `held_for_review`       | TypeSafe held the draft; it waits on the chat.                                                    |
| `skipped_number`        | The message arrived on a number the bot does not answer, or the chat is pinned to another number. |
| `skipped_automation`    | A Flow or automation consumed the message.                                                        |
| `skipped_assigned`      | The chat is assigned to a person.                                                                 |
| `skipped_paused`        | The bot is paused on this chat.                                                                   |
| `skipped_campaign_only` | Campaign-only mode is on and the chat did not come from a campaign.                               |
| `skipped_rate_limited`  | The provider or the per-chat pace refused the call.                                               |
| `skipped_superseded`    | A newer customer message took over this dispatch.                                                 |
| `skipped_cap_race`      | Another dispatch claimed the last reply slot first.                                               |
| `skipped_nothing`       | Nothing to answer: no text, AI off, or nothing new.                                               |
| `error`                 | The dispatch failed.                                                                              |

Settings → AI Agents → Overview also shows an **activity card for the last 7 days**:
replies by tier and model, hand-offs, held drafts, the reasons the bot
did not reply, and how many routings came from Jev versus the rule.

### Troubleshooting: the AI didn't reply

| Outcome                                  | What to do                                                                                                                                                                     |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `skipped_number`                         | Turn on _Reply on every WhatsApp number_ in Settings → AI Agents → Auto-reply, or set the AI's number under *Reply on* there. A chat pinned to another number stays skipped. |
| `skipped_automation`                     | A Flow or automation answered first. Check the keyword automations and Flows on that number.                                                                                   |
| `skipped_assigned`                       | Unassign the chat, or reply yourself.                                                                                                                                          |
| `skipped_paused`                         | Press **Resume & reply** in the banner, or set an auto-resume time. Hand-offs and Take over need a manual resume.                                                              |
| `skipped_campaign_only`                  | Turn off _Campaign replies only_ in Settings → AI Agents → Auto-reply, or reply to the customer yourself.                                                                                          |
| `skipped_rate_limited`                   | The provider is limiting you. Check the provider's quota and billing, then wait.                                                                                               |
| `skipped_superseded`, `skipped_cap_race` | Normal: another dispatch answered. No action.                                                                                                                                  |
| `skipped_nothing`                        | The message had no text (a sticker or media only), or AI is off.                                                                                                               |
| `held_for_review`                        | Open the chat and Send, Edit or Discard the draft.                                                                                                                             |
| `error`                                  | See the detail in the banner and the server log. The usual cause is a provider error: check the API key, model name and quota.                                                 |

## Behaviour changes

- The bot no longer stands down for every message when **any** keyword
  automation exists. It stands down only when one **matches** the
  message.
- **Two quick messages get one reply that answers both.** The bot waits
  3 seconds (`AI_BURST_WAIT_MS`) for the customer to finish; messages
  within 2 minutes of each other are joined. A photo or voice note with
  no caption never makes the bot drop the text before it.
- A WhatsApp send failure after the bot drafted a reply now **hands the
  chat to a person**.
- Hand-offs ring a **bell for owners and admins** when no hand-off agent
  is set. When one is set, the assigned agent already gets the
  assignment notification.

## Environment variables

| Variable                   | Default | Effect                                                                                                                                                     |
| -------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AI_BURST_WAIT_MS`         | `3000`  | How long the bot waits for a customer to finish typing before answering. `0` disables the wait; the newest-message check still runs.                       |
| `AI_REQUEST_TIMEOUT_MS`    | `30000` | Per-call timeout for the AI provider.                                                                                                                      |
| `AI_DISPATCH_BUDGET_MS`    | `50000` | Total time one auto-reply may take (the webhook allows 60 s). A retry or rewrite that would not fit is skipped and the chat is handed to a person instead. |
| `AI_CONTEXT_MESSAGE_LIMIT` | `20`    | How many recent text messages are given to the model.                                                                                                      |

Restart the app after changing them.
