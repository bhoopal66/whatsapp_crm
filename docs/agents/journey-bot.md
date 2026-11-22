> Moved verbatim from `CLAUDE.md` (2026-11-22). Read this file before changing this area.

### Journey bot (`lib/journeys/*`, migration 086)

A JSON workflow (`workflows/`) per customer. `engine.ts`'s `step()` is pure
(no I/O, clock or randomness); `runner.ts` does load → step → commit → drain
through the ports in `ports.ts`, whose Supabase adapters live in `host/`,
outside the engine barrel. `docs/journey-bot.md` is the contract.

- **`journey_commit` is the write.** Once `ensureOpenFile` has inserted
  version 0 it is the file's only writer, in one transaction: a replayed event
  id is `duplicate` before any version check, a stale version is `conflict`
  (neither writes), else the body at version+1, the processed event and the
  outbox rows. Event ids are `wa:<message id>` and `timer:<kind>:<fireAt>`, so
  overlapping ticks dedupe.
- **Delivery.** Only SEND is at-most-once: `journey_claim_delivery` stamps the
  claim before the gateway call, and a claim over 2 minutes old with no
  `delivery_ref` is recorded `unconfirmed`, never resent. Other actions are
  at-least-once, idempotent on the outbox item id. The drain runs in `seq`
  order and stops at the first failure; a file backs off only if the sink is
  wrapped in `withFailureRecording` (the exponent is capped first: an overflow
  once stopped every account's drain).
- **Quiet hours** come from the workflow (09:00–20:00 at a fixed UTC+4, timers
  and cold starts only). A held send gets `not_before`; the drain skips it and
  its LOG_COST without holding later items, so an opt-out confirmation still
  goes out at night. That SEND+LOG_COST pairing lives in SQL and in the
  runner: change both.
- **Consent.** An opt-out is applied to `contacts.opted_out_at` inside
  `journey_commit` and re-applied idempotently on delivery; a resubscribe
  clears only an older stamp, so the newer decision wins. Delivery re-checks a
  marketing send against opt-out and opt-in. Below admin, the
  `contacts_consent_guard` trigger lets someone who can see the contact only
  **set** a do-not-contact (with a reason) where none exists; moving or
  clearing it is admin-only. Every change lands append-only in
  `contact_consent_events`.
- **Inbound.** The hook sits in `inbound-pipeline.ts` after Flows (the
  campaign follow-up flow included) and before automations, and runs only when
  no Flow consumed the message. A message it consumes suppresses the
  content-level automation triggers and the AI reply, as a Flow does.
- The tick (`runJourneyTick`) runs from `GET /api/journeys/cron` and the
  automations cron. `SHIPPED_WORKFLOW_KEY` (`host/tick.ts`) equals 086's
  default key; `host/tick.test.ts` reads the migration. `verify-journeys.sql`.
