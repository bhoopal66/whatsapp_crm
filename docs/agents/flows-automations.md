> Moved verbatim from `CLAUDE.md` (2026-11-22). Read this file before changing this area.

### Flows vs Automations

Two independent engines, deliberately kept apart:

- `lib/flows/*` — stateful, per-contact conversational runs over a node graph
  (`flow_runs`), suspending on customer input. Concurrency is enforced in the DB
  (idempotency on `meta_message_id`, optimistic update on `current_node_key`,
  partial unique index for one active run per contact). Abandoned runs are swept
  by `GET /api/flows/cron`.
- `lib/automations/*` — stateless trigger → steps rules (keyword, chat
  tag, inbound message, schedule). Scheduled work runs via `GET /api/automations/cron`.

A flow's `fallback_policy.on_unknown_reply` (JSONB, resolved in
`lib/flows/fallback.ts`) decides what an off-script reply does: reprompt,
hand off, end, ignore — or `ai`, which answers with the AI agent while
the run stays on its node.

**Seven cron endpoints**, all authenticated by `AUTOMATION_CRON_SECRET` in
an `x-cron-secret` header, none of which the app pings itself (Vercel
Cron / GitHub Actions / any pinger):

- `GET /api/automations/cron` — scheduled automation steps. It also
  carries the others' work, each throttled per process (`everyInterval`)
  inside `after()`, a failure only logged: channel health, Team
  activity alerts, case SLA, case rules sweep (187) and case group-end
  retries (5 min), edge
  purge and chat file sweep (15 min), deal-room reconcile and
  submission groups (2 min), journey tick, PBX housekeeping, push
  delivery, calendar reminders, the assist pending sweep and the
  personal-number history import and the HR automated-message drain
  (1 min),
  closing empty instant meetings, the HR rule sweep with draft
  expiry and reply nudges, and desk tray escalation (5 min),
  assist rate prune (1 h), memory expiry, knowledge-gap topics and
  the unsent-attachment sweep (24 h). An install that pings
  only this one is covered. A new background job joins this list.
- `GET /api/flows/cron` — sweeps abandoned runs.
- `GET /api/whatsapp/broadcast/cron` (migration 053) — delivers
  scheduled broadcasts. It is deliberately the *resume* machinery from
  migration 038 (`broadcast-resume.ts` → `broadcast-core.ts`), not a
  third fan-out: claim the delivery lock, plan from the frozen
  `broadcast_recipients`, deliver in `after()`. Quiet hours
  (`lib/broadcasts/quiet-hours.ts`, jsonb `{start, end, tz}`) defer a due
  campaign to the end of its window. The tick only selects `scheduled`,
  so a large campaign left `sending` is finished by the detail page's
  Resume, not by the next tick. Every tick also runs migration 066's
  recipient reconcile.
- `GET /api/whatsapp/health/cron` (migration 065) — the channel health
  sweep. The automation cron also runs it, throttled to once per 5
  minutes per process, so an install that pings only that one is
  covered.
- The automation cron also drains the inbound WhatsApp queue (migration
  264, `lib/whatsapp/inbound-drain.ts`) once a minute per process: it has
  no endpoint of its own, so an install without that cron retries nothing.
- `GET /api/journeys/cron` (migration 086) — the journey tick: due
  timers and outbox items.
- `GET /api/deal-rooms/cron` (migration 088) — rooms stuck in
  `creating`, and stale invite claims.
- `GET /api/pbx/cron` (migration 089) — recordings, call-backs, event
  retries, purge.
