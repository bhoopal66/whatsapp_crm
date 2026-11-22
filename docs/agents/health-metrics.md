> Moved verbatim from `CLAUDE.md` (2026-11-22). Read this file before changing this area.

### Health and metrics (`lib/metrics/*`, migration 228)

Port of package 033c and 033f-g. `docs/monitoring.md` is the contract.

- `GET /api/healthz` never touches the database (Docker's HEALTHCHECK
  uses it); `GET /api/readyz` is a 2 s one-row read, 503 with no detail.
- `GET /api/metrics`: Prometheus text 0.0.4, `Authorization: Bearer
  METRICS_TOKEN` (>= 32 chars, timing-safe; unset 501). Per process; the
  registry is a `globalThis` singleton because route chunks may each
  bundle the module. Families cap at 500 label sets (then `overflow`).
- Edge refusals are counted at the refusal points (`admitAdmin`,
  `screenWebhook`'s `done`, `rateLimited()` in `lib/api/v1/respond.ts`)
  through `countEdgeRefusal`, which never throws and never changes the
  answer.
- Queue gauges read `hr_automsg_outbox_stats()` (228, service role only,
  counts only) with a 2 s timeout; failure renders `wacrm_outbox_stats_up
  0` only. `startupPosture` reads each integration's own config reader;
  `instrumentation.ts` logs it at start (no refusal, unlike the package).
  `verify-hr-automsg-outbox-stats.sql`.
