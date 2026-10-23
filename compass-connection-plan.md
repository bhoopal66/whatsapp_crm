# Taamul Connect ⇄ Taamul Compass — connection plan

Date: 2026-10-21 · Environment: dev server `https://crm.taamul.ae`, workspace **QA Test**

## 1. Where things stand today

Compass is the **submission tracker**: agents create and submit cases and
upload documents there, and coordinators update case status there. The CRM
already has most of the receiving side. None of it is connected yet.

| CRM piece (already built) | Endpoint | Live state |
|---|---|---|
| Customer sync (migration 056) | `POST/GET/DELETE /api/v1/compass/contacts` | 0 records, no key |
| Status notifications 1:1 on WhatsApp | `POST/GET /api/v1/compass/notifications` | 0 sent, no key |
| Submission group + Case on submit (115, 122–130) | `POST /api/v1/submission-groups` | never called, no key |
| Final status from the tracker | `PATCH /api/v1/submission-groups/{id}` | never called |
| Outbound webhooks (signed) | `POST /api/v1/webhooks` | only `message.*` / `conversation.created` events |

Blockers and defects found:

1. **No WhatsApp number connected** in any workspace. Notifications and
   submission groups both need a **Whapi** number, so nothing can be sent.
2. **No API keys** with `compass_*` or `submission_groups:*` scopes.
3. `docs/compass.md` gives the base URL as `https://wacrm.taamul.ae/api/v1`.
   The live host is `https://crm.taamul.ae/api/v1`.
4. **Status sync is one-way and final-only.** `PATCH` moves the CRM case
   only on `APPROVED / DECLINED / WITHDRAWN / CLOSED`. Every intermediate
   coordinator update in Compass (Bank acknowledged, Documents requested,
   Query raised …) changes nothing in the CRM, so the `/cases` inbox, its
   SLA timers and the bank dashboard drift away from Compass.
5. **Case details are fill-once.** Bank, product and amount can be set only
   at `POST`, and a repeat fills only empty fields. A correction made in
   Compass never reaches the CRM.
6. **Documents live in Compass, but the CRM checklist doesn't know.**
   Documents can't be marked received through the API, so "documents
   missing", the document-chase SLA and **Request missing documents** all
   work from stale data.
7. **Two masters for the stage.** Staff can move a submitted case's stage
   in the CRM and coordinators can move it in Compass, and neither side
   tells the other.
8. **Compass learns nothing back.** There are no webhook events for
   group-ready (the `202 pending` path), group failed or ended, leads
   opened in the CRM, or a customer opting out.
9. A submitted customer is not linked to their `compass_contacts` record:
   the link is made only when a notification is sent.

## 2. Target design (decisions)

- **Compass is the master of a submitted case**: its stage, outcome,
  bank, product, amount and documents. The CRM mirrors these and owns the
  WhatsApp side: the group, the chat, the SLA clock and the coordinator inbox.
- **The CRM is the master of a lead** (pre-submission: Interested →
  Data collection → Review). On submit, Compass's `POST` attaches to the
  open lead, as it already does.
- **Stage names are the CRM's.** Compass keeps a map from its own status
  codes to the CRM stage names (the default list, or a bank's own list)
  and sends `stage`. The CRM exposes the list so Compass can check it.
- **Ordering:** every update carries `changed_at`. The CRM ignores an
  update older than the last one it applied, so retries and out-of-order
  queue deliveries are safe.
- **Customer status messages** stay 1:1 through `/compass/notifications`
  (with an idempotency key). Staff conversation happens in the submission
  group.
- **Echo suppression:** every CRM → Compass event carries
  `source: "crm" | "compass"`, and Compass ignores events with `source: "compass"`.

## 3. Phases

### Phase 0 — Setup (no code, ~1 hour, an admin)

1. In **QA Test**: Settings → WhatsApp → connect a **Whapi** channel and
   confirm it shows *Connected*.
2. Settings → Integrations → API keys: create three keys and store them in
   Compass's secret store:
   - `Compass – customer sync`: `compass_contacts:read`, `compass_contacts:write`
   - `Compass – notifications`: `compass_notifications:send`
   - `Compass – submissions`: `submission_groups:read`, `submission_groups:write`, `webhooks:manage`
3. Check that every Compass agent, coordinator and team lead has a CRM
   login with the **same email** in QA Test (agent or team_leader role).
   Otherwise `POST` answers `422 unknown_user`.
4. Agree the bank codes (FAB, CBD, ADCB …) used in Compass with
   Settings → Cases → banks, plus each bank's stage list and required
   document keys.
5. Fix the base URL in `docs/compass.md` (`wacrm.` → `crm.`). This is a doc-only commit.

**Gate:** `GET /api/v1/me` returns 200 with each key, and the Whapi
channel's health shows connected.

### Phase 1 — Connect what already exists (Compass-side work only)

Compass wires its hooks to today's API:

- submit a case → `POST /submission-groups` (with bank, product and amount);
- a final status → `PATCH /submission-groups/{id}` `{status}`;
- a customer is created or edited → `POST /compass/contacts`;
- a customer-facing status change → `POST /compass/notifications`.

**Gate (end-to-end in QA Test):** a submission creates the WhatsApp group
and a case at **Submitted**. An agent's message in `/cases` arrives in the
group. An `APPROVED` PATCH moves the case to Approved and ends the group.
A notification sent twice with the same key arrives once.

### Phase 2 — CRM changes for full two-way sync (needs a migration, ~134)

Each item is a separate branch, review and deploy:

| # | Change | Notes |
|---|---|---|
| 2a | `PATCH /submission-groups/{id}` accepts `stage`, `changed_at`, `outcome_reason {code,text}`, `bank`, `product`, `amount`, `compass_url` | `stage` must be in the case's list (422 `unknown_stage`). It is applied through the existing stage-move path, so the SLA triggers fire. Stale `changed_at` → 200 `{applied:false, reason:"stale"}`. Bank, product and amount overwrite, and each change goes to the existing append-only log. Keep `status` for compatibility. |
| 2b | `PATCH` accepts `documents: [{key, status: "requested"\|"received"\|"rejected", received_at?, compass_url?}]` | Marks the case checklist; the `case_documents_sla` trigger restarts the document chase. Files stay in Compass and only a link is stored. Unknown keys go in `rejected[]`, so the batch doesn't fail. |
| 2c | `GET /api/v1/case-stages?bank=FAB` and `GET /api/v1/case-documents?bank=&product=` | Lets Compass validate its maps. New scope `submission_groups:read` is enough. |
| 2d | Account setting **"Submitted cases are managed in Compass"** (Settings → Cases) | When on, the CRM case page locks stage, outcome, bank, product, amount and documents for cases that have a submission. It shows "Managed in Compass" with the `compass_url` link. Leads stay editable. The SQL refuses a non-service-role move too (the TS mirror goes in `lib/cases/access.ts`). |
| 2e | New outbound webhook events: `submission_group.ready`, `submission_group.failed`, `submission_group.ended`, `case.lead_created`, `case.stage_changed` (with `source`), `contact.opted_out` | Use the existing signed delivery (`X-Taamul-Signature`). Add the events to `WEBHOOK_EVENTS`, `docs/public-api.md` and the webhooks settings UI. |
| 2f | Link `compass_contacts.contact_id` when a submission's customer phone matches a synced record | Fixes defect 9. |
| 2g | Docs: one **`docs/compass.md`** covering sync, notifications, submissions, stages, documents and webhooks; CHANGELOG with **Migration required** | This is the contract handed to Compass. |

**Gates per item:** unit tests for the parsers and mapping, `verify-*.sql`
for the SQL rule in 2d, typecheck, lint and the full vitest run before
deploy, deploy through `deploy-release.sh` with the migration rehearsed.

### Phase 3 — Hardening and go-live

- Run a reconciliation on both sides: Compass nightly re-sends `PATCH`
  for cases changed in the last 24 h. The CRM ignores stale ones, so this
  is safe.
- Admin screen: add a **Submissions** tab to Integrations → Compass,
  showing the last PATCH per case, rejected documents and webhook delivery
  failures.
- Load test the backfill: existing open Compass cases → `POST` with
  `changed_at` and the current stage.
- Repeat Phase 0 in the production workspace with new keys. **Never reuse
  the QA keys.**

## 4. Risks / open questions

- **Whapi group creation is not idempotent.** If a create's response is
  lost, a retry can leave an orphan WhatsApp group. Compass must retry
  `POST` with the same `submission_id` and never invent a new one.
- **Compass stage vocabulary:** if Compass's statuses are finer or coarser
  than the CRM's stages, the map must be many-to-one. Unmapped statuses go
  as `status` only, which changes nothing.
- **Documents:** do coordinators also want the CRM to *receive* documents
  the customer sends in the WhatsApp group and push them to Compass? This
  is not in this plan; it would be a Phase 4.
- **Deep links:** Compass should link each case to
  `https://crm.taamul.ae/cases/<case.id>`. The id comes back in the `POST` answer.
