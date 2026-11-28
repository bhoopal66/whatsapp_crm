# Customer ratings (CSAT) for cases

Migration 246. A customer is asked to rate our service from 1 to 5 twice
per case: when the case is **submitted** to the bank and when it is
**approved**. The reply is stored against the case and shown on the case
page and, as averages per agent and per bank, on the Cases screen.

**Off by default.** Nothing is queued, sent or captured until an owner or
admin switches it on (Settings, the "Customer ratings (CSAT)" card;
`GET`/`PUT /api/cases/csat-settings`).

## When a request is queued

A trigger on case stage history (`case_stage_history_csat`, beside 124's
SLA trigger) decides:

- **submitted**: the stage write takes the case out of the
  pre-submission stages (Interested, Data collection, Review) to a stage
  that is not final. With the default stage list that is `Submitted`; a
  bank with its own list uses its first stage after the pre-submission
  ones. A case opened straight from a submission counts too.
- **approved**: the stage write goes to `Approved`, or carries outcome
  `Approved`.

Each case is asked **at most once per moment** (`UNIQUE (case_id,
trigger)`): a case moved back and forward is not asked again. Only while
CSAT is on and that moment is switched on; switching off later does not
reach back. A lead never reaches either moment (it has no submission).

The trigger never fails the stage write: any error becomes a database
WARNING and the case moves as usual.

The request goes to the **case's contact**, in their newest **company
chat** (never a personal-number chat). When there is no contact, no
company chat, or the contact has opted out or is marked do-not-contact,
the request is recorded as `skipped` with that reason and never sent.

## Sending

The automations cron (`GET /api/automations/cron`, every 5 minutes per
process) claims what may go now and sends each request once. The claim
re-checks everything:

- CSAT and the moment still switched on (else `cancelled` /
  `switched_off`);
- the moment still holds (281): an approved request whose case is no
  longer approved, and a submitted one whose case is back before
  submission or closed as anything but approved, is `cancelled` /
  `case_changed`, also when it was `held`. Nobody was asked, but the
  moment is used up: the case is not asked about it again;
- the workspace's **send hours**, Dubai time (default 09:00 to 20:00;
  never before 08:00 or from 21:00). Outside them the request waits;
- opt-out and do-not-contact (else `cancelled` / `opted_out`), and the
  chat still a company chat of the contact (else `no_chat`);
- **at most one rating request per person per 24 hours** (a second case
  of the same person waits a day). An advisory lock per person keeps two
  cron processes from both sending;
- a request not sent within **3 days** of its moment is `cancelled` /
  `expired`.

The row is stamped (`handed_to_gateway_at`, 281) as the last thing before
the gateway. A claim that gets no result within 10 minutes goes **back to
the queue** when it was never stamped, and is marked `unconfirmed` when it
was: it may have reached WhatsApp and is **never resent**. A send that
times out or breaks off after the stamp is `unconfirmed` too, with its
message in the chat (shown as still sending), and a reply to it counts.
Only a send the gateway certainly refused is `failed`.

The message goes from the chat's **own number** (its pinned number, else
the number the chat is on), never a personal number:

| Number        | Inside the customer's 24-hour window | Outside it                            |
| ------------- | ------------------------------------ | ------------------------------------- |
| Whapi, OpenWA | the wording below as plain text      | the same                              |
| Meta          | the wording below as plain text      | the approved template for that moment |

On Meta outside the window the request needs an **approved utility**
template in the workspace's message templates whose body has `{{1}}`
(the customer's first name) and `{{2}}` (bank and product). Without it the
request is **held** (`awaiting_template`): nothing is sent, it is not a
failure, and it is retried hourly until it expires after 3 days.

Template names default to `case_csat_submitted` and
`case_csat_approved` and can be changed in the settings card.

The default wording (English; Arabic when the language setting is
Arabic):

- Submitted: "Hi {{1}}, your {{2}} application has been submitted to the
  bank. How happy are you with our service so far? Reply with a number
  from 1 (not happy) to 5 (very happy)."
- Approved: "Hi {{1}}, good news: your {{2}} account has been approved!
  How would you rate our service? Reply with a number from 1 (not happy)
  to 5 (very happy)."

`{{1}}` is the first word of the contact's name when it is a name, else
"there". `{{2}}` is the bank's name and the product in lower case
("Emirates NBD business account"); for the approved wording a product
ending in "account" drops that word, because the template itself
already says "account" after `{{2}}`. When you submit
`case_csat_approved` to Meta, give `{{2}}` the sample "Emirates NBD
business" (not "... business account"), so the sample sentence does not
repeat the word either.

At most **5 requests go out per 5-minute pass**, and on a Whapi or
OpenWA number the number's **daily limit of new chats** applies (Team
activity's limit for automatic senders): over it the request is **held**
(`number_daily_limit`) and retried hourly until it expires. Team
activity's other send checks are not applied. Opt-out and do-not-contact
are checked again right before each send (`failed` / `opted_out`).

The sent request is recorded in the chat as a bot message. CSAT requests do not count toward, and are not counted by, the
daily cap shared by HR automated messages and desk digests.

## Capturing the reply

Every inbound message on a company number is checked, after the message
is stored and after Flows:

- A rating is one of:
  - the **whole message** is one digit 1 to 5 (Arabic-Indic digits
    accepted), optionally with `/5`, `out of 5`, `of 5`, `من 5`,
    `stars`, `نجوم` or star emoji, and nothing after it but punctuation
    or emoji;
  - that, then a **separator** (comma, colon, semicolon, exclamation
    mark, new line, or a dash with a space before it) and a comment that
    neither starts with a digit nor goes on as a numbered list:
    `2 - too slow`;
  - `5/5`, `5 out of 5` or `5 stars`, a space and a comment;
  - 1 to 5 star emoji, alone or with a comment after a space.

  The comment keeps up to 1000 characters. A digit followed by only a
  space, a full stop or a closing bracket and then words is **not** a
  rating: `5 great`, `2 years in business`, `1. Passport`, `1- Passport`,
  `2-year visa`, `3 pm call me`, `2-3 years`.

- Text that is not a rating costs nothing. A rating costs one database
  call, which stores it only when CSAT is on and the person has a request
  **sent in this chat within the reply window** (default 7 days) and not
  yet answered, and either **nothing else was said to the customer there
  since** (no staff or bot message) or the reply **quotes the request**. A
  reply quoting another message is never a rating (281). The newest such
  request takes it. Each request is answered **at most once**.
- A rating **with a comment** ("1, please call me") is stored and is not
  consumed: journeys, automations and the AI still get the message.
- **A Flow wins.** When a running Flow consumed the message (its menus
  take typed numbers too), nothing is captured. A captured bare score is
  treated like a Flow's message: no journey bot, no content automations
  (`new_message_received`, `keyword_match`, `intent_match`) and no AI
  reply. Relationship triggers and the `message.received` webhook still
  fire. A sender over the webhook rate limit is not captured.
- No thank-you message is sent.

## Showing it

- **Case page**, Overview tab: one line per request with the stars and
  "N out of 5", the comment, or what the request is waiting on. Shown to
  anyone who can read the case (`case_can_read`; `GET
/api/cases/[id]/csat`, which checks the case belongs to the active
  workspace first). Nothing is shown while CSAT is off.
- **Cases screen**: "Customer ratings" with the 90-day average and, when
  opened, the average and count per agent and per bank. Only ratings of
  cases the viewer can read count (`GET /api/cases/csat?days=90`).

The agent and bank of a rating are those of the case when it was asked.

## The Compass lock

`case_managed_externally` (134) is not consulted: it stops people
changing a case Compass manages. CSAT changes nothing on the case, so a
case Compass moves to Submitted or Approved is asked like any other.

## Privacy

`case_csat_requests` and `case_csat_responses` are personal data: the
privacy export includes them (`case_csat`, registered in
`privacy_extensions`) and the erase deletes them. `case_csat_settings`
is configuration.

## Database

Tables force row-level security with no policy and no grants; every
access is a SECURITY DEFINER function granted to the service role only.
Apply 246 as a superuser or BYPASSRLS role, after 234. It is re-runnable.
`supabase/ci/verify-case-csat.sql` asserts the behaviour. Then 281 (after
263; asserted by `verify-csat-fixes.sql`): re-applying 246 or 263 brings
their claim back, so re-apply 281 after them. The app works without 281,
by 246's rules. Switch CSAT on only with 281 and its build.

Statuses: `queued`, `held`, `sending`, `sent`, `failed`, `cancelled`,
`unconfirmed`, `skipped`.
