> Moved verbatim from `CLAUDE.md` (2026-11-22). Read this file before changing this area.

### Case desk (`lib/desk/*`, migration 220)

Staff uploads to bank cases at `/desk`, with human case numbers. Port of
package 035a-c. `docs/case-desk.md` is the contract.

- **Numbers.** `desk_applications` (one per company, `desk_customers`
  keyed by normalised trade licence) are `TC-YY-NNNNN` from one gapless
  counter per account; a desk case is `TC-YY-NNNNN-BBB(2-9)` with BBB the
  bank's `desk_bank_codes` code. The caption code's check character
  (Luhn mod 36) lives twice, SQL `desk_check_char` and
  `lib/desk/case-number.ts`; `case-number.test.ts` and
  `verify-case-desk.sql` pin the same vectors: change both.
- **A desk case is a 130 lead** of a CRM contact (case files need the
  contact's folder), opened in the uploader's name through
  `case_open_lead`, lead source `desk`; one open lead per contact and
  bank still holds (`CASE_CONFLICT`).
- **Intake.** `intake_items` state changes only through
  `intake_set_state` (+ an append-only `intake_item_events` row). Files
  are stored at `intake/<item id>/<sha256>.<ext>` in `case-files` before
  `intake_submit` (a CHECK pins the path) and, when filed, recorded as
  the uploader's staff upload (180) and inserted into
  `case_document_files` directly (registered_by = uploader).
- **Sorting** reuses 133/161 bank holders (`case_holds_bank`), not the
  package's `bank_desks`: holders sort their bank's queue; owners,
  admins and team leaders every queue and the no-bank queue
  (`intake_scope_ok`, `intake_is_sorter`). 035d and 035e were not ported
  (duplicates). Tables are FORCE RLS with no grants; functions are
  service role only, called with the caller's ACTIVE account. Every SQL
  hint is in `DESK_REFUSALS` (`store.test.ts` reads the migration).
  `verify-case-desk.sql`.
- **Company contacts (229, design 035 D1).** `desk_customer_contacts`
  links a desk company to the CRM contacts acting for it (role owner |
  pro | accountant | other, `authorised`); many to many, a contact being
  one phone. A link is never a grant. A desk case's contact is linked by
  a trigger on `cases` (never fails the write). Read: a readable case of
  the company or team leader and up; change: a writable case or team
  leader and up, and only a contact `memory_can_read` shows the actor.
  `desk_customers_for_contact` is routing's question (more than one
  company = ambiguous). `DESK_CONTACT_ROLES` is pinned to the CHECK by
  `companies.test.ts`. `verify-desk-customer-contacts.sql`.
- **WhatsApp routing and the tray (230, design 035 section 4).** Off
  by default (`desk_settings.routing_enabled`). `inbound-pipeline.ts`
  offers each recorded 1:1 customer document (both the own-storage and
  the durable-copy path; `fileWithDurableCopy` returns the recorded
  document) to `routeDeskDocument` (`lib/desk/route-inbound.ts`, never
  throws). `desk_route_customer_document` decides: E1 quoted message of
  ours naming one open case, E2 caption code, E4 the single open case of
  a one-company sender; anything ambiguous, or a chosen case whose
  contact is not the sender (181 registers only the case customer's
  document), goes to `desk_tray` with candidates and none chosen; an
  unlinked sender only on a desk number. A staff phone (142's
  `coordinator_phones`, exactly one live staff) answers 'staff' and the
  TS uploads it through `desk_whatsapp_intake` (220's intake, channel
  whatsapp, item id = the document id, read by the message it arrived on:
  `customer_documents_record` answers the folder's ref). Tray filing: bank scope
  (`intake_scope_ok`), CONFIRM_COMPANY for a company the sender is not
  linked to, the sender's own document registered directly, another
  person's copied through the intake (item id = tray id) then
  `desk_tray_resolve`. Escalation: `runDeskTrayEscalation` (automations
  cron, 5 min) through `createSystemTask`, `source_ref desk_tray:<id>`.
  `TRAY_REASONS` is pinned to the CHECK by `tray.test.ts`.
  303: filing from the tray needs `case_can_write`, as `intake_file` does;
  a document that could not be copied leaves a `COPY_FAILED` row
  (`desk_tray_copy_failed`, through 230's own routing rule) instead of only
  a log line; the list is read through `desk_tray_page` (items + total).
  `verify-desk-whatsapp-routing.sql`.
- **Shared documents and reuse consent (231, design 035 D5/D11/D13).**
  `case_document_files_same_customer` (BEFORE INSERT, every writer):
  the document's contact is the case's, or for a desk case a contact
  linked to (229) or opening a case of the same company; else
  CROSS_CUSTOMER. `desk_doc_link` inserts the same `customer_document_id`
  into another open case of the same company (no copy; per-case status),
  needing `desk_doc_consents` live for the target's bank when it differs
  (CONSENT_MISSING). Consents are append-only (revoked once, with a
  reason). `desk_company_overview` lists, below team leader, only
  cases `case_can_read` allows (289; D11 listed all), and their files.
  `verify-desk-shared-documents.sql`.
- **Cover and queue alerts (232, design 035 revision A).**
  `desk_bank_roles` (primary | second, FK to the holder's
  `coordinator_banks` row, one role each) and `desk_leave` (Dubai days,
  no access change). `desk_bank_cover`: primary, else second, else
  `desk_lead_for` (230's duty owner, else the owner).
  `desk_queue_alerts_due`: a bank queue's oldest untagged upload ≥ 2 h →
  the second (else the cover), ≥ 4 h or the no-bank queue → the lead;
  `runDeskQueueAlerts` (same cron pass as tray escalation) dedupes on
  `source_ref desk_queue:<bank|none>:<level>:<Dubai day>`. `verify-desk-bank-cover.sql`.
- **Application view (233, design 035 section 5).**
  `desk_application_checklist`: the union of 181's required
  `case_file_spec_rows` over the company's open cases the actor can read
  (unreadable cases are not columns), max `min_valid_days`, a cell per
  case (`desk_case_doc_cell`). `desk_doc_tasks_due` (expiring ≤ 14 days,
  expired, replaced = superseded at a sibling) on open, unsubmitted
  (`group_id` NULL) desk cases; `runDeskDocTasks` hourly in the
  automations cron, `source_ref desk_doc:<file>:<kind>`; never writes a
  case or file. `verify-desk-application-view.sql`.
- **Reminder digest (234, design 035 D9).** Off by default
  (`desk_digest_settings`, an approved utility template with `{{1}}`
  app number and `{{2}}` summary). `desk_digest_enqueue`: one per
  company per Dubai day (UNIQUE), send hour to 21:00, open unsubmitted
  cases with a required document missing/failed (233's cells), gap days
  since the last digest and since the company's last customer document.
  `desk_digest_claim` re-checks switch, template, day, quiet hours,
  opt-out/DNC and the cap of 3 per person across `hr_automsg_outbox`
  sent + digests; stale claims → 'unconfirmed', never resent.
  `runDeskDigests` + `sendDeskDigest` (template on Meta, rendered text on
  Whapi/OpenWA, the chat's own number, never personal) from the
  automations cron every 5 min, 5 per pass (`DIGEST_CLAIM_LIMIT`); re-checks
  opt-out/DNC and 204's number limit (`number_daily_limit`) before the
  gateway. `processMessage` calls `noteDigestStop`
  for a STOP word (`isStopWord`); `desk_digest_stop` opts out only after
  a digest in 30 days. HR's own claim does not count digests (one-way
  cap). `verify-desk-reminder-digest.sql`.
- **Worklist and suggestion (235, design 035 D8/D12).** `desk_worklist`
  counts (tray the actor may sort, queues in `intake_scope_ok`, own
  untagged uploads, open `desk_tray:/desk_queue:/desk_doc:` tasks) for
  the Case desk card on `/worklist`. `desk_tray_suggest_input` (sorters,
  open items only) carries no company or person names; the `desk_case`
  selection caller (`qs-desk-case-v1`, ordinal `c1…cN` + `unsure`) is
  asked on demand by `suggestTrayCase`; `readJudgment` suggests only at
  p ≥ 0.6 and a 0.1 margin. Advice only: never files, never pre-selects.
  `verify-desk-worklist-suggest.sql`.
- **Group intake (324, CC group wall slice A).** `desk_group_links`
  (group -> bank, intake / replies, replies only with intake; owner,
  admin or team leader who sees the group; never a 299 mirror) and
  `desk_group_intake` (one row per group message, first write wins
  except that a `no_copy` gives way to a record with an intake item;
  outcome + reason code + intake item; reply claim off -> pending once,
  only for filed, new_case, queued, duplicate or refused). A WhatsApp
  group links through one number only (`GROUP_ALREADY_LINKED`).
  `desk_group_can_see` restates 299's
  `whatsapp_group_visible_ids` with an explicit actor, staff only: change
  one, change both (the verify file compares them).
  `desk_group_staff_for_phone` is 230's exactly-one-live-staff rule keyed
  by digits. The inbound hook reads a link with no actor through
  `desk_group_link_for_group` (nothing for an unlinked group or a
  mirror); never impersonate a staff member to call an actor function. `GROUP_INTAKE_OUTCOMES` / `GROUP_REPLY_STATES` are pinned to
  the CHECKs by `group-intake-store.test.ts`. `desk_group_intake` is
  NOT_PERSONAL (ids and codes; the item is 220's).
- **Group files (324 slice B, `lib/desk/group-intake.ts`).**
  `runGroupMessage` chains `processGroupFile` after
  `copyGroupMessageMedia` (in `later`, inline for the drain); never
  throws, logs codes only. Inbound files only, of a link with intake on
  (read through `desk_group_link_for_group` with the service role: the
  tables have no grants); text is never recorded. Bytes only from our own
  chat-media (`no_copy` otherwise), pdf/jpeg/png before the download
  (`file_type`). Item id and idem key derive from account + WhatsApp
  message id (`groupItemKeys`), so a redelivery or a second number
  replays. A reply needs a won `claimReply`, then the 20/min group budget
  (same `group-send:` key as the send route); a replayed item or a lost
  record race is not answered. Reply words: `group-intake-text.ts`.
  `verify-desk-group-intake.sql`.
- **`privacy_extensions` (229).** 221's export and 222's erase call
  every registered `export_fn(account, contact) -> jsonb` /
  `erase_fn(account, contact) -> {counts, objects}` (the erase ones run
  before 222's own deletes, so a child row is removed and counted before
  its chat, message or document cascades it), so a new personal
  table joins PDPL by registering, never by restating those bodies (the
  hooks sit behind a `to_regclass` guard; 229 refuses unless the
  installed 221/222 have them). `data-map.test.ts` reads the registered
  function bodies as well as 221/222. Name a plpgsql record variable in
  221 anything but `r`: its body aliases tables as `r`.
- **289.** `intake_route` (the uploader's own filing) queues an upload as
  `COMPANY_RESTRICTED` when the licence is a company the uploader fails
  `desk_customer_can_read` on, or the open case found is of a contact
  `memory_can_read` hides. A sorter's filing is unchanged (it passes the
  uploader to `desk_case_open`, so the check cannot live there).
  `desk_customer_contacts_list` masks such a contact: first word of the
  name, no phone. `verify-access-points.sql`.
- **263.** `case_open` gives a desk lead (`desk_customer_id`) a submission
  only when the names match (`desk_normalise_name`), or, with no customer
  name, when the contact is linked to that one company; else a separate
  case. `case_document_files_same_customer` never matches NULL to NULL.
  `desk_digest_stop` also covers `sending` digests and CSAT requests; the
  digest template is checked in its language
  (`desk_digest_template_ok/3`); `desk_doc_tasks_due` skips tasked files.
- **316 (the rest of the desk audit).** `desk_settings_set` /
  `desk_digest_settings_set` with `p_expected` refuse `SETTINGS_CHANGED`
  when the stored `updated_at` is another (NULL expected = nothing was
  stored when the card loaded); the routes take it as `expectedUpdatedAt`,
  and a body without the key is a 409 too (a tab from before 316). Pass the
  string PostgREST gave: a JS Date drops the microseconds and every save
  would be stale. A duty change moves `desk_settings.updated_at`, so it also
  makes an open routing card stale. `desk_digest_settings_read` exists only
  to return `updated_at` (234's `_get` cannot gain a column). The cards keep
  what was typed until Reload and disable Save meanwhile
  (`desk-cards.test.tsx`). `customer_documents_stats()` is read only by
  `/api/metrics`. In the bundle, `drawFormValues`
  (`form-appearances.ts`) gives a form's value an appearance before
  `copyPages` (which keeps the widgets and what they store, but not the form)
  where one is missing or `NeedAppearances` says stale, and refuses the build
  (`FORM_NOT_FLATTENED`, with the document's name) rather than send a blank.
  Never flatten: pdf-lib's flatten loses ticks and misplaces appearances.
  Hidden fields stay undrawn. `exif.ts` gives the rotation pdf-lib ignores.
