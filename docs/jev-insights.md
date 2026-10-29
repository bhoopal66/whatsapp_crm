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

<!-- section: A2 -->

<!-- section: B -->

## Chat tag suggestions

<!-- section: C -->

## Campaign reply sorting

<!-- section: D -->

## Message check before sending

<!-- section: E -->

## Flows and automations that understand meaning

<!-- section: F -->

## Compass status to case stage

<!-- section: G -->

## Lead score

<!-- section: H -->

## Knowledge gaps

<!-- section: I -->

## Privacy

What Jev receives is redacted text: phone numbers, emails, card and
account numbers and other identifiers are removed before a request
leaves the server, and a request that still carries one is refused
locally. No database id, contact name or phone number is ever sent;
dynamic options (your chat tags, flow buttons, case stages) are sent as
numbered choices and mapped back on the server.
