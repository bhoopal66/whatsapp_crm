> Moved verbatim from `CLAUDE.md` (2026-11-22). Read this file before changing this area.

### TypeSafe decision layer (`lib/typesafe/*`, migrations 063–064)

Module 013: TypeSafe (Jev) judgments around the auto-reply bot, hooked
from `auto-reply.ts` through `lib/ai/typesafe-gates.ts` — triage before
the model (may hand off with reason `triage`, or force strict
grounding), a passage filter between retrieval and gate 2, and a
guardrail between the model and the send (reason `guardrail`). The host
rule is absolute: **a decision with `act: false` changes nothing**.

Control is per account (migration 064, `ts_account_settings`, Settings →
AI safety checks, `/api/typesafe/{settings,activity}`): on/off, monitor
or live, which checks, English only or all languages. The server keeps
only the secrets (`TYPESAFE_API_KEY`, `TS_LOG_HASH_KEY`) plus optional
overrides that no account can undo (`TS_ENABLED_<CHECK>=false`,
`TS_SHADOW=true`, the `TS_ACCOUNT_IDS` allowlist). `checkState()` in
`config.ts` combines the two; `SwitchesStore` caches an account's row
for 30 s, and the settings PUT writes the saved row into it (`set`,
generation-checked so an older in-flight read cannot win). No row means
off, so an account that never opened the panel is never sent to
TypeSafe. A read error with nothing read before is `unknown`: off,
except that the guardrail holds (`guardrailWhenSwitchesUnknown`). The
PUT is version-checked (`expectedUpdatedAt`, else 409) and needs
`confirmLive` to start acting. A store
without `accountSwitches` (tests, the eval harness) is "unmanaged":
on and live, so the install configuration alone decides.

`act` needs the check on, live, the language not held back, TypeSafe
answering with the pinned model, and no shadow-flagged custom policy.
Live runs on the built-in thresholds unless a custom policy was approved
by a *second* admin for the pinned model and question set; an invalid
or mismatched one falls back to the built-ins with an alert. Three
exceptions, all guardrail and all fail-safe: degraded mode acts on the
fail mode plus the code checks rather than send unscreened; in a
held-back *reply* language the code checks act and a model flag holds
for review (the bot answers in the customer's language, so log-only
would be a customer-controlled switch); and with an invalid config an
account whose guardrail is on and live still holds its drafts
(`guardrailWhenConfigInvalid`, which reads the settings row). The
customer's own text is never a figure source. Monitor-mode checks run
off the reply path through `TsRef.defer` and are awaited in the
dispatcher's `finally`.

`lib/ai/typesafe-watch.ts` is the opt-out watch: the last step of the
inbound pipeline triages any text the bot's own triage did not judge
(found by the keyed message hash) and, in live, only marks the contact
opted out (`contacts.opted_out_at`) —
it never hands off or replies, because a person or a flow owns those
threads. No database id goes into TypeSafe state (a UUID trips the
last-line PII guard); ids stay local and ordinals are sent. Threshold
bounds live twice — `THRESHOLD_BOUNDS` in `policy.ts` and
`ts_threshold_bounds` in SQL — and `policy.test.ts` keeps them equal.
Changing question wording means a new `QS_VERSION`. The DB side is
asserted by `supabase/ci/verify-typesafe.sql` (one statement — the
pinned CLI rejects more), not vitest. `docs/typesafe.md` is the
operator contract.
