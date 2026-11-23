> Moved verbatim from `CLAUDE.md` (2026-11-22). Read this file before changing this area.

### Cases (`lib/cases/*`, migrations 122-130)

One case per submission group: bank, product, amount, stages, tasks,
documents, notes, bank contact log, SLA timers, the coordinator inbox at
`/cases`, and bank spaces at `/banks`. `docs/cases.md` is the contract.

- **Tenancy first.** `case_role` / `case_can_*` ignore which workspace is
  active, so a case route checks the case's account against the caller's
  **active** account before any service-role call (`lib/cases/http.ts`,
  the TENANCY comment); a case the caller may not read answers 404.
- **Roles** are worked out live, never stored: owner (super admin),
  admin, the team leader of the **agent's** team, the named coordinator,
  the named agent. Viewers and bank guests get nothing; there is no IT
  role. The mirrors in `lib/cases/access.ts` are pinned to 122-124 by
  `access.test.ts`: change one, change both.
- **Pinned lists.** `DEFAULT_STAGES` (`lib/cases/ui.ts`) equals
  `case_default_stages()` and `OUTCOME_REASON_CODES` equals 127's CHECK;
  tests read the migrations.
- **SLA events from SQL.** The stage-change and document-received events
  fire from the triggers `case_stage_history_sla` and `case_documents_sla`
  (124); don't call them from TS as well.
- **Sends.** A case reply, take-over and documents request go through the
  group's send path and honour the per-person group send limit
  (`assertUnderGroupSendLimit`). Notes, bank contacts and bank workspaces
  never reach a send path (`lib/cases/never-sent.test.ts`).
- **Ending the group.** A case's first move to a final stage ends its
  WhatsApp group exactly once, through a claim token; the automations
  cron sweeps failed ends.
- **SQL habits.** A blank check uses `~ '^[[:space:]]*$'`, never
  `btrim(x) = ''`: `btrim()` strips spaces only, so a tab or newline
  passes (this bit twice; older checks still use `btrim`). Appending a
  literal to a `text[]` needs `::text` (`v || 'x'::text`). When a
  set-returning function gains columns, verify files must not name its
  columns in `WITH ORDINALITY AS x(…)`; use `WITH ORDINALITY x` +
  `x.ordinality`.
- **Case files, views, macros, rules (179-187, `docs/cases.md`).** Apply
  179, 180, 181, 182, 185, 186, 187 in order as a superuser/BYPASSRLS role.
  - Every automatic behaviour (checklist sync, ready-move, intake prompts,
    rules) is off or empty by default and never acts under the Compass lock
    (`case_managed_externally`, `MANAGED_EXTERNALLY`).
  - The system actor is `author_id`/actor NULL plus a label
    (`system:files`, `system:rules`), written only by no-grant definer
    helpers (`case_note_add_system`, rule actions); no API role, the service
    role included, may execute them.
  - Lock order everywhere: the case `FOR NO KEY UPDATE`, then the file /
    build row.
  - Build paths are content-addressed (`bundle-<sha256>.pdf`) and a version
    is reserved (10 min) before any bytes are stored; a record is refused
    unless it matches the current passed files.
  - A download writes its audit row before the signed URL is minted.
  - Rules never send (no gateway path) and their own writes neither fire
    rules nor count as activity; each action is isolated in a
    sub-transaction.
  - Macro actions run through the normal case functions as the caller, so a
    macro never widens access; the run stops at the first refusal and
    earlier actions stay.
- **Leads (130).** A case with `group_id` NULL at Interested. Nobody
  opens one any more: cases come only from the submission tracker, and
  `POST /api/cases/leads` was removed (`case_open_lead` has no caller). A later
  submission of the same contact and bank attaches to it. Every stage list
  starts with the three pre-submission stages (`PRESUB_STAGES`, mirrored by
  `validateStages`). A lead has no group: no send, no group end
  (`requireCaseGroup` -> 422 `NO_GROUP`). Cold lead = Withdrawn + `NO_RESPONSE`.
  `verify-case-leads.sql`.
- All seven migrations must be applied as a superuser or BYPASSRLS role.
  `verify-cases.sql`, `verify-case-tools.sql`, `verify-case-sla.sql`,
  `verify-case-inbox.sql`, `verify-bank-workspaces.sql`,
  `verify-bank-dashboard.sql`.
- **Compass sync (134).** Compass (the submission app) is the master of a
  submitted case; a lead stays the CRM's. The API writers are
  `case_sync_from_submission` and `case_apply_submission_status` (a
  status names its stage since 137; an explicit `stage` in the same PATCH
  wins), both actor NULL, role `api`. The sync is stale by
  `cases.external_changed_at`, stage rules as 122/130, per-item refusals
  in `rejected`. The lock is `case_account_settings.managed_externally`
  (`case_settings_set`, owner/admin) refusing people with
  `MANAGED_EXTERNALLY`, mirrored in TS by `isManagedExternally`; the API
  path is never locked. `docs/compass.md` is the contract;
  `verify-compass-sync.sql`.
- **Stage automation (214, release 029e).** Rule triggers
  `stage_entered` (needs condition `stage`; fire key = the stage) and
  `last_required_doc_received` (from `case_doc_set_status` only, never
  181's files); actions `create_task` / `start_sla` (stage_entered only)
  and `advance_stage` (the only action there: one stage forward, never
  into an outcome, never a closed case or a lead past pre-submission, once
  per transaction via `app.case_rules_advanced`; it fires the new stage's
  rules itself because hooks skip while rules fire).
  `case_tasks.created_by` and `case_task_status_log.actor_id` are NULL
  for a rule's task. Restates 187/189/134 bodies: apply in order, once.
  `verify-case-rules-stage-automation.sql`.

- **Case file reviewer (225, `lib/case-review/*`, package 031).** Off
  by default (`case_account_settings.review_enabled` /
  `review_send_to_model`). A file turning `passed` queues its case 60 s
  out (`case_review_on_file_passed`, debounced); the automations cron
  runs `runCaseReviewTick` each minute. Drafts only: never a document,
  file, stage or task write, no send path. The checklist is always
  there; a model narrative only with the switch, an AI key, clean
  `redact()` output (fail closed) and `assertAiTransfer` (224) via
  `generateReply({ purpose: 'case_review' })`. PDF text via
  `extractPdfPages` (no OCR; under 40 characters a page = scanned).
  `case_review_draft_create` is idempotent on input_hash and supersedes
  the pending draft. `verify-case-review.sql`.
- **Case file reuse (270).** A superseded file goes back only to
  `pending_checks`, by a person, as a new version and a new `classify_seq`
  (the guard). SQL does not know whether it will pass: `classifyAndCheck`
  runs the checks before it classifies (`REUSE_WOULD_FAIL`), since a failed
  newest version un-readies the case. A file that counts as another document
  needs `moveFrom` to name it (`ALREADY_FILED_AS`). Classify takes the
  `classify_seq` and status the caller read (`CHECK_MISMATCH`); a retry
  re-reads and re-decides, never re-sends. 270 restates 181's guard and
  classify: never re-apply 181 without 270 after it.
