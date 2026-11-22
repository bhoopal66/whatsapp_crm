> Moved verbatim from `CLAUDE.md` (2026-11-22). Read this file before changing this area.

### Assistant safety (`lib/assist/*`, migration 120)

The gate for a future AI assistant's tool calls. `docs/assistant-safety.md`
is the contract.

- **Idle.** No assistant exists; nothing calls the guard or
  `createModelToolRouter`. `DEFAULT_TOOL_RISKS` has no handlers, so the
  router would deny every call `UNKNOWN_TOOL`.
- **Risk.** READ / WRITE / DANGEROUS; modes supervised / cautious
  (default) / autonomous. An unregistered tool is DANGEROUS; DANGEROUS
  always needs a person, WRITE only in supervised. Model arguments only
  feed the action hash, never approve.
- **The router exposes only `execute()`.** The human prompt (with the
  nonce) goes to `notifyHuman`, never to the model; the person confirms
  through `POST /api/assist/pending/[id]`, whose HumanOrigin is minted
  from the session.
- **The database owns the nonce, TTL (300 s) and cap** (5 open per
  person, across workspaces) in `assist_pending_request`; status moves
  only through the `assist_pending_*` SECURITY DEFINER functions.
- **Consume and its decision audit row are one SQL call**
  (`assist_pending_consume`): wacrm has no client transactions. A failed
  audit insert rolls the consume back (`AUDIT_UNAVAILABLE`).
- **Fail closed.** Rate state unavailable, audit unavailable and
  confirmation state unavailable all deny. `assist_rate_reset` is not
  granted to the service role.
- `assist_audit` is append-only, owner included. Crons: pending sweep
  every minute, rate prune hourly (automations cron).
  `verify-assistant-safety.sql`.
- **Middleware (019e, 019f; migration 132).** Still idle. `middleware.ts`
  runs hooks in a fixed order and the 019a router stays the only tool
  layer; redaction is terminal, applied to every message just before the
  model. `promptcache.ts` lays out STATIC, WORKSPACE, VOLATILE tiers and
  fails closed (`PromptCacheError`). The provider mapping of
  `cacheControl` is UNVERIFIED. `agent_run` audit rows hold counts only.
- **Tool advisor (019d, `advisor.ts`).** Idle: nothing calls
  `adviseTools`. It ranks registered tools for a piece of text through
  the `tool_advice` selection caller: suggestions only, never
  `execute()`. Text is vault-tokenised (when given) then
  `redactClipped`; each tool goes as an ordinal noul (`t1 … tN`)
  carrying its description, never its name. Model mismatch or any
  failure is `unavailable`; no key or a disallowed account is `off`.
