# Campaign journeys — a broadcast that keeps going

A broadcast used to end at the send. The template went out, replies
landed in the Campaign inbox, and whatever happened next was up to
whoever was watching. This page describes how a campaign now
**continues as a conversation** — a Flow picks the customer up when they
reply, the AI agent answers whatever the Flow did not expect, and a
human is brought in only when neither can help — and the rule the whole
thing is built on:

> **The conversation never stops.** Every inbound message from a
> campaign recipient is answered by *something*: the Flow, the AI
> agent, or a person who has been handed the thread with a note saying
> why.

## The three layers

```
broadcast template ──reply──▶ Flow (deterministic, per-contact run)
                                  │
                     off-script   │  ends / breaks / hands off
                     message      ▼
                              AI agent (grounded in the knowledge base,
                                        knows the campaign and the step)
                                  │
                        cannot help / cap reached
                                  ▼
                              human (thread routed, reason recorded)
```

1. **The Flow** is the script: menus, prescreens, document requests.
   It runs one suspended run per contact and advances on button taps
   and captured text. It is the cheapest and most predictable layer,
   and it is where the *paid-message discipline* of a journey lives —
   a Flow sends exactly what it was built to send.
2. **The AI agent** catches everything the script did not plan for: a
   question in the middle of a menu, a remark after the Flow finished,
   a reply that arrived after the run timed out. It has the campaign
   message, the step the customer is on, the conversation so far, and
   the knowledge base; it is bound by the escalation gates and the
   per-conversation reply cap.
3. **A human** gets the thread when the agent hands off — an escalation
   keyword, nothing in the knowledge base, the model asking for help, a
   provider error, or the reply cap — with an internal note naming the
   reason and quoting the last customer message.

## Setting it up

### 1. Build the Flow

Under **Flows**, build the conversation the campaign should run. Two
things specific to campaign Flows:

- **Trigger: *Manual only*.** A campaign-started Flow does not need a
  keyword or first-inbound trigger — the campaign is its door. A manual
  trigger keeps it from also starting on unrelated inbound messages.
  (A keyword or first-inbound Flow works too; it simply has two doors.)
- **Branch on the button they tapped.** The reply that started the run
  is seeded into the run's variables before the first node:

  | var | value |
  |---|---|
  | `{{vars.campaign_reply}}` | the typed text, or the tapped button's title |
  | `{{vars.campaign_reply_id}}` | the tapped button's id (`""` for typed text) |

  So a Flow whose entry is a **condition** node on `var campaign_reply
  contains POS` routes a template quick-reply straight into the POS
  branch without asking the customer to choose again; the false branch
  (typed text, or a button the Flow does not know) can send the menu.
  Match on the title rather than the id unless you set ids
  deliberately: on the Whapi number a template button's id is the one
  saved in Settings → WhatsApp → Templates (or `btn_1`, `btn_2`, …), while on the
  Meta number it is the button's text unless a payload was set.

### 2. Choose how off-script replies are handled

The Flow editor's **Off-script replies** panel decides what the runner
does when a reply matches none of the options on the current step:

| Setting | What happens |
|---|---|
| **Let the AI agent answer, then continue the flow** | The agent answers in the context of the step (it is told the prompt and the options) and asks the customer to pick one. The run stays on the same step, so the buttons still work. Needs *Auto-reply* on under Settings → AI Agents → Auto-reply. If the agent is off, at its cap, routed to the other number, or the thread already has a human, the options are sent again instead. If the agent hands off, the run ends and the human takes over. |
| Send the options again | Re-prompt up to *N* times, then hand off or end. The pre-054 default. |
| Hand off to a human right away | No retries. |
| Ignore it | The run stays put and the message is left for automations. |

For a campaign journey, choose the first.

### 3. Point the campaign at the Flow

In the broadcast wizard's last step, **When they reply → Start a Flow**.
The campaign page shows the link. On the public API and the MCP
server, pass `flow_id` (see [public-api.md](./public-api.md)).

The Flow starts on each recipient's **first** reply to that campaign —
a tapped template button or a typed message. A later reply from the
same recipient goes to the run if one is still active, and otherwise to
the AI agent; the Flow is not started twice.

If the recipient already has an active run from another Flow when the
campaign reply arrives, that run keeps the message — one active run per
contact is a database invariant, and interrupting a conversation in
progress is worse than answering a campaign reply late.

### 4. Turn the AI agent on

Settings → AI Agents → Auto-reply. Everything on this page that is not the
Flow depends on it. Two settings matter for campaigns:

- **Campaign replies only** keeps the bot on campaign threads and off
  ordinary support chat on the same number. A campaign-started run
  stamps the conversation, so the bot is eligible on it.
- **Max replies per conversation** bounds the spend. When it is reached
  the thread is handed to a human with reason *reply cap* — the bot
  does not simply go quiet.

Route `broadcast` and `flow` to the **same number**
(Settings → WhatsApp → Routing) on a two-number install, and set the
AI's own number to it too (Settings → AI Agents → Auto-reply → Reply on);
the agent answers only on its own number.

## What happens when

| Moment | Handled by |
|---|---|
| Recipient taps a template button / types a reply | The campaign's Flow starts (seeded with the reply); with no Flow attached, the AI agent answers — a tapped button's title is read as the customer's message |
| Recipient taps a button on a Flow step | The Flow advances |
| Recipient types a question mid-Flow | AI agent answers and steers back to the options (with the *AI* fallback); otherwise the options are re-sent |
| The Flow reaches an *end* node | Run completes; the next message goes to the AI agent |
| The Flow reaches a *handoff* node | Conversation set to *pending*, routed to the chosen agent; the bot stands down |
| The Flow breaks (a node was deleted mid-run, a send failed) | Run ends as *failed*; **the same message** is handed to the AI agent so the customer is not left mid-sentence |
| The run times out (`on_timeout_hours`, swept by the flows cron) | Run ends as *timed out*; the next message goes to the AI agent |
| The AI agent hits a gate or its cap | Thread handed to a human with the reason; if the Flow was mid-run it ends as *handed off*. The thread moves from the Campaign inbox to the Inbox |
| A human replies from the inbox | The run is paused (*paused by agent*). The bot keeps answering unless the thread is assigned to someone or paused with the thread banner's switch — assign it or pause it when a person is taking over. Either way the thread moves to the Inbox for good |
| The thread is assigned to anyone | The bot stands down, and the thread moves to the Inbox for good — whether a person assigned it, or a Flow's handoff node, an automation or the AI agent's hand-off did |

## Where it shows

- **Broadcasts → the campaign page** — the linked Flow.
- **Broadcasts → Campaign inbox** — the threads that replied and that
  the AI agent is answering: it has replied, has not handed off or been
  paused, and no person has stepped in. **The Inbox** lists every other
  thread, so each one is in exactly one place. A thread moves to the
  Inbox for good once it is assigned to anyone or a person replies in
  it — releasing the assignment, or the customer answering a later
  campaign, does not bring it back. A chat tag moves it too, for as
  long as the thread carries one, whoever set it — and it is in the
  Inbox whenever
  the bot is not answering it: a reply the AI agent has not answered
  (on a number it does not run on, say, or one a Flow is still
  handling), a hand-off, or the AI auto-reply switched off. A brand-new
  reply therefore shows in the Inbox for the few seconds until the
  agent's first answer moves it.
- **Flows → the flow → Runs** — campaign-started runs are logged with
  `trigger_type: campaign` and the broadcast id; every AI fallback is a
  `fallback_fired` event with `action: ai` and the agent's outcome.
- **The conversation** — the handoff note (`🤖 AI needs a person …: …`
  — what happened and what to do, in plain words) and, under Settings →
  AI Agents → Knowledge, the unanswered questions the retrieval gate logged.

## Limits

- **Timers are not in the Flow.** "Remind on day 3 if no documents"
  is an automation (`time_based` trigger) or a follow-up campaign,
  not a Flow node. A Flow run that hears nothing is swept after
  `on_timeout_hours` and the next inbound goes to the AI agent.
- **Paid-message caps** ("one re-engagement per file") are a matter of
  what the Flow and your automations send; nothing counts them yet.
- **One conversation per contact across both numbers.** A journey does
  not fork per number.

## Code map

| Piece | Where |
|---|---|
| Campaign → Flow start, reply seeding | `lib/whatsapp/inbound-pipeline.ts` (`flagBroadcastReplyIfAny`), `lib/flows/engine.ts` (`dispatchInboundToFlows`, `campaignReplyVars`) |
| Off-script → AI | `lib/flows/fallback.ts` (`on_unknown_reply: 'ai'`), `lib/flows/engine.ts` (`flowContextForNode`), `lib/ai/auto-reply.ts` (`flowContext`, `AiReplyOutcome`) |
| Broken run → AI | `DispatchInboundResult.outcome === 'failed'` with `consumed: false`; the pipeline's AI eligibility check |
| Reply cap → human | `lib/ai/auto-reply.ts` (`handOff('cap', …)`), `lib/ai/handoff.ts` |
| Schema | `supabase/migrations/054_campaign_flow_continuation.sql` |
