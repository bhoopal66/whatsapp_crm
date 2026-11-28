# Runbook: WhatsApp number or account restricted by Meta

For the operations lead and whoever is on call for this deployment. Use it
when any of these arrives:

- a `meta_health_events` row for an account restriction;
- a number quality event that flags or downgrades the number;
- a template event that pauses or disables a template;
- a Meta email or notification.

The send guard behind this runbook is described in
[meta-cloud-api.md](meta-cloud-api.md#number-health-record-and-send-guard-migrations-188-and-334).

Meta's enforcement stages are on
https://developers.facebook.com/documentation/business-messaging/whatsapp/policy-enforcement.
Re-read that page before relying on the durations below. Meta changes them.

## 1. What each Meta stage means

Meta escalates on user blocks and reports, spam signals and template
misclassification. Mildest first:

| Stage | What Meta does | What it means for us |
|---|---|---|
| Warning | Notice in Business Support Home / WhatsApp Manager. No sending limit yet. | Last cheap moment to fix. Treat as P1: pause marketing (section 2). |
| Template block, 1 or 3 days | Business-started **template** sends blocked for 1 day, then 3 days on repeat. | No marketing or utility templates go out. Replies inside an open 24 h customer window still work. |
| Send block, 5 / 7 / 30 days | All business-started messaging blocked for the period. | Only replies inside a customer-opened 24 h window. Files that need an outbound follow-up stall: tell field ops. |
| Indefinite lock | Account locked until Meta decides an appeal. | Nothing goes out. Appeal is the only route. |
| Permanent disablement | WABA or number disabled. | Number lost. Use the backup-number procedure (section 4) and expect a new WABA review. |

- **Appeal** is filed in **Meta Business Support Home** (business.facebook.com,
  then Business Support Home, the restricted asset, Request review). Meta
  states a decision time of 24 to 48 hours.
- **Not every violation can be appealed.** Some spam violations are final. The
  review button is then missing. Do not open a second account or number to
  keep sending the same traffic. Meta treats that as circumvention.

## 2. First hour checklist

Owner: operations lead. Second: whoever is on call. Write the time against
each step in the incident note.

1. **Switch Enforce on, then pause marketing.** Go to **Settings, WhatsApp,
   Number protection** (owner only). While Enforce is off the guard holds
   nothing and only logs what it would have done. With it on, a number whose
   state is marketing-paused or all-paused stops marketing sends by itself.
   Also stop every broadcast and automation step that sends a template, by
   hand, in case the number state has not updated yet. Do not pause session
   replies unless the account is fully locked. Answering customers who wrote
   to us is not what got us restricted.
2. **Read Business Support Home** for the affected WABA and number: the exact
   violation, the stage, the expiry date and whether "Request review" is
   offered. Screenshot it into the incident note.
3. **Gather evidence** for the appeal (read-only, service-role connection):
   - `send_protection_decisions`: every send the guard allowed, denied or
     deferred (`at`, `config_id`, `template`, `contact_id`, `kind`,
     `decision`, `reason`, `enforced`) for the last 30 days. It shows that
     we suppress opted-out, silent and failing recipients and cap volume.
     The last 50 rows are also on the Number protection card. Rows with
     `enforced = false` are watch-only: say so, do not present them as
     refusals.
   - `meta_health_events`: the timeline of quality, template and account
     events (`kind`, `payload`, `received_at`) leading up to this one.
   - `meta_number_state` (quality, messaging tier, account status, assessed
     state) and `meta_template_health` (paused templates) for the current
     picture.
   - **Consent records**: for the contacts behind the reported or blocked
     traffic, the opt-in source, time and wording, and the opt-out time with
     proof it was honoured (`contacts.opted_out_at`).
   - The templates involved: name, category, text, approval date.
4. **File the review** in Business Support Home, if offered. Keep it
   factual: what the messages were (service and file updates for customers
   who applied through us), the opt-in source, and what changed since
   (marketing paused, guard on, suppression rules, template fixes). Attach
   nothing with customer personal data beyond what the form asks for.
5. **Set expectations.** Decision in 24 to 48 h. Tell field operations which
   files need a phone call instead of WhatsApp until then. Re-check Business
   Support Home every 12 h.
6. **Find the root cause before resuming**: which template, segment or day
   drove the blocks or reports. Use the decision log and the template
   pause reasons in `meta_template_health`. Fix that first. Resume
   marketing at the new daily ramp, not at the old volume. You can also set
   a daily marketing count cap and spend cap on the Number protection card
   (owner or admin) to hold it lower for a while. The lower of the cap and
   the ramp wins.

## 3. What is and is not reported to Meta automatically

Nothing. **There is no Meta API to "send our safeguards".** The guard's
decisions, suppression rules and consent records stay in our database. Meta
sees our safeguards only through:

- the evidence we supply **on appeal** (section 2, step 3) or when Meta
  asks for it;
- the **verified business profile** (legal name, website, description,
  contact details). Keep it accurate;
- our **templates** (correct category, clear Stop wording). Meta reviews
  them on every submission;
- the **opt-in declaration** made when the number was registered. It must
  stay true.

The guard reduces blocks and reports before Meta counts them. It does not
change Meta's view of the account after the fact.

The guard also has limits of its own:

- It covers broadcasts, automation template sends, HR automated messages
  (WhatsApp), desk digests, CSAT requests and call service details. It does
  **not** cover replies an agent types in the inbox.
- Missing health data never pauses a number. If Meta has told us nothing, we
  send.
- Whapi and OpenWA numbers get only the opt-out, recipient suppression and
  spend cap rules. Meta signals do not exist for them.

## 4. Backup-number procedure

Purpose: keep **service** running (answers to customers who write to us,
file status updates they asked for) while the primary number is restricted.
It is **not** a way to keep marketing going. Moving the same traffic to
another number is circumvention and risks the whole business portfolio.

1. Keep one backup number registered in advance (separate SIM and number,
   display name approved, verified business profile complete). Send a low,
   steady volume of utility traffic from it so it has its own quality
   history. A WABA-level restriction can cover every number on that WABA. So
   the backup helps only for number-level restrictions, or if it sits on a
   separate WABA under the same verified business.
2. When the primary is restricted, switch **utility and session** sending
   for affected open files to the backup number (Settings, WhatsApp,
   Routing). Marketing stays paused on both numbers.
3. In the first message from the backup number, say who we are and why the
   number changed. Honour any Stop reply on either number. Opt-out is per
   contact, not per number.
4. When the primary is restored, move traffic back gradually under the
   ramp. Leave the backup on its low utility volume.

## 5. Template pre-submission checklist

Templates are reviewed by Meta. For financial content they can attract
complaints fast. Before submitting any template:

- [ ] **Category is accurate.** UTILITY only for a specific customer's own
      file or transaction (document request, application received, status
      change, appointment). Anything that promotes a product, rate or offer
      is MARKETING, even when sent to an existing customer.
- [ ] **No marketing inside a utility template**: no cross-sell, "also
      check our...", offers or promotional links.
- [ ] **Clear Stop wording** on every marketing template (for example
      "Reply STOP to stop these messages", or Meta's marketing opt-out
      button), and the opt-out is wired to `contacts.opted_out_at`.
- [ ] **No promises about credit**: never "guaranteed approval",
      "pre-approved", "instant loan", "no documents needed", or rates and
      amounts the bank has not confirmed for that customer. We do not
      decide credit. The partner bank does.
- [ ] **Keep to service and file updates**: what we need from the customer,
      where their file is, who to contact. No loan promotion campaigns over
      WhatsApp.
- [ ] Names the company. No impersonation of a partner bank's brand beyond
      naming the bank on the file.
- [ ] Variables cannot be filled to produce any of the above (for example a
      `{{1}}` that could carry "approved").
- [ ] Reviewed by the operations lead before submission. Template name,
      category and text logged.
