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

<!-- section: A1 -->

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
