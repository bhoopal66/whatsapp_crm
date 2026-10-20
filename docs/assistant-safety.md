# Assistant safety

The **assistant safety** layer is the gate an AI assistant's tool calls
would go through: risk levels, human confirmation, rate limits, a loop
guard and an audit. This is the operator contract for module 019a
(migration 120, `lib/assist/*`).

**It is idle.** wacrm has no assistant yet, so nothing calls the guard or
the tool router. The registry (`src/lib/assist/registry.ts`) names default
tools in `DEFAULT_TOOL_RISKS`, but none has a handler, so the router would
refuse every call as `UNKNOWN_TOOL`. Nothing here changes what staff or
customers see today.

## Risk levels and modes

Every tool has a risk level:

| Risk          | Needs a human confirmation    |
| ------------- | ----------------------------- |
| **READ**      | never                         |
| **WRITE**     | only in the `supervised` mode |
| **DANGEROUS** | always, in every mode         |

The modes are `supervised`, `cautious` (the default) and `autonomous`. A
tool missing from the registry counts as DANGEROUS. Nothing the model puts
in a tool's arguments (`confirm: true`, `approved: "yes"`) approves
anything: the arguments only identify the action.

## Confirmation

When a call needs a person, the database records a **pending action** and
makes its nonce: 20 hex characters, stored only as its sha256. The prompt
with the nonce goes to the person, never to the model; the model gets only
the pending action's id.

- A pending action expires after **300 seconds**.
- One person has at most **5 open** pending actions, counted across all
  their workspaces. Beyond that a call is refused (`PENDING_CAP`).
- The signed-in person confirms or denies it with
  `POST /api/assist/pending/[id]` `{ decision: 'confirm' | 'deny', nonce }`.
  It answers 400 on bad input, 404 `NOT_FOUND`, and 409 for the other
  refusals: `WRONG_USER` (another person's or another workspace's action),
  `BAD_NONCE`, `EXPIRED`, `NOT_PENDING`.
- A confirmed action runs **once**, and only with exactly the tool and
  arguments that were confirmed (compared by hash). A changed argument is
  refused; a second run is refused.

## Rate limits

**30 calls a minute per person** and **300 a minute per workspace**. Each
call takes a slot on both together or on neither, in the database. When the
database cannot answer, the call is refused (`RATE_STATE_UNAVAILABLE`).
Clearing one key, `assist_rate_reset`, is not granted to the app: it is an
owner task from psql, and it is audited.

## Loop guard

Per assistant run:

- at most **8** tool calls, refused ones included (`CALL_CAP`);
- the **3rd** identical call is refused (`LOOP_REPEAT`);
- after **3** consecutive errors the breaker opens (`CIRCUIT_OPEN`) for
  1 s, then 5 s, then 30 s (and 30 s after that), letting one trial call
  through each time; a trial that succeeds closes it.

## Audit

Every decision and every execution is appended to `assist_audit`: who,
which run, which tool, the action's hash and the outcome, never the
arguments. It is append-only: no update, delete or truncate, not even by
the database owner. If a decision cannot be written, the call is refused
(`AUDIT_UNAVAILABLE`).

The app never removes audit rows. Retention (for example archiving old
rows) is an operator task; nothing is partitioned today.

## The cron

The automations cron (`GET /api/automations/cron`) runs, inside `after()`:

- every minute, the **sweep**: pending and confirmed actions past their
  expiry are marked expired;
- every hour, the **prune**: rate-limit events older than two of their
  windows are removed.

Both only tidy up: expiry and the window are checked on every call, so a
missed run is never a wrong answer. A failure is only logged.

## Agent middleware and prompt caching (019e, 019f)

Still idle: no assistant exists, so nothing calls `runAgent`. The code is
in `src/lib/assist/` (`middleware.ts`, `middleware.builtin.ts`,
`promptcache.ts`).

**Hook order.** Per run `beforeAgent`, then per model round
`beforeModel`, `wrapModelCall` (an onion: the first middleware is the
outermost, the terminal calls the model once), `afterModel` (reverse
order), and at the end `afterAgent` (reverse order). A hook can change
text or remove tool calls but never add or alter one. A hook that throws
aborts the run.

**The 019a router stays the tool layer.** Every proposed call still goes
to `createModelToolRouter().execute()`; the guard, the confirmation gate
and the risk levels above are unchanged. Middleware has no handler map.

**Built-ins.**

- `redactBeforeModel` redacts every message at the terminal step, after
  all wrap layers and whatever its position in the list. A redactor that
  throws or returns something malformed aborts before the model is called.
- `contextBudget` offloads an oversized message (never a system message),
  then summarises or drops older turns to fit the token budget.
- `auditAfterAgent` appends one `agent_run` row per run: rounds and tool
  counts only, never text or arguments. If the append fails the result is
  withheld. `supabaseAgentRunAuditSink` writes it to `assist_audit` on a
  service-role client (migration 132 adds the kind; no new function).

**Prompt-cache tiers.** `promptCacheMiddleware` lays the request out as
STATIC (system constants and tool definitions), then WORKSPACE (the
workspace's policy constants), then VOLATILE (everything else), with at
most two cache breakpoints. It fails closed with `PromptCacheError` on an
unknown constant, a volatile marker or text copied from the messages, or
personal data in a cacheable tier, and the run aborts. Only the exact tier
objects it installed keep their cache fields at the terminal step; every
other message loses them. Cache read and write counts go into the
`agent_run` audit detail.

**Unverified.** How `cacheControl` maps onto a provider's request is the
model client's job and has not been checked against either provider.

## Applying it

Migration 120 must be applied as a superuser or BYPASSRLS role. The tables
are RLS-forced with no policy; the app reaches them on the service role,
and changes a pending action only through the `assist_pending_*`
functions. `supabase/ci/verify-assistant-safety.sql` asserts the SQL.
