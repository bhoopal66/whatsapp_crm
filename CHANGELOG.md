# Changelog

User-visible changes in Taamul Connect (previously `wacrm`).
Self-hosters: when pulling an update, check this file for any
**migration required** notes and apply the matching SQL files from
`supabase/migrations/` against your Supabase project before restarting
the app.

Versions follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Pre-1.0, `MINOR` bumps cover new modules; `PATCH` bumps cover bug fixes
and polish.

## [Unreleased]

### Automations that wait, and stay where they were

**Migration required:** `269_automation_runs.sql`, before the build.
- A wait inside a condition branch holds the steps after it and the steps
  after the condition; they used to run at once. A step that fails in a
  branch ends the run as failed.
- Saving an automation keeps its steps, so a customer who is waiting
  continues at the right place and gets no step twice. If the wait itself
  was removed, the run ends with the reason "automation changed while
  waiting".
- When two admins edit the same automation, the second to save is told
  that it changed.
- A failed database read no longer ends a waiting run: it is tried again,
  at most five times. A run cut off by a restart ends as "interrupted"
  after 30 minutes and is never run again.

### Push notifications that stay with the right person

No migration.
- A few minutes without a connection to the push services no longer
  removes every staff device for good.
- On a shared computer, the next person to sign in no longer sees the
  previous person's notifications, also when that session simply ended.
- A device the server lost is registered again on the next page load, so
  the switch says "on" only for a device that is.
- Notification settings that could not be loaded show an error with
  Retry; they used to open as "everything on, no quiet hours" and the
  next change saved that.
- A change made just before leaving the settings is saved, and quick
  changes save in order.
- "Send test" answers for your own notification, and says so when quiet
  hours hold it.
- Meeting, calendar and task alarms are not delivered more than 30
  minutes late.
- The pipeline chart shows its error when the stages could not be loaded.
### Conversation flows that stop, and never repeat a step

No migration.
- A flow whose menu cannot be sent ends instead of swallowing the
  customer's next messages.
- Switching a flow off stops the runs in progress at the customer's next
  message.
- Two quick messages no longer send the next step, or a repeated menu,
  twice. While one message's steps are still going out, another message
  in the same flow is not answered by the flow.
- A message to another of your numbers is no longer taken as an answer to
  the menu a flow sent from this one (a tap on that menu still is).
- A hand-off keeps the person already on the chat, skips someone who has
  left, and rings the admins when the chat could not be updated.
- The timeout sweep reads every run, and keeps the run of a customer who
  answers during it.
- A flow sends nothing to a customer who opted out or is marked
  do-not-contact: its run ends and no new one starts.
### Reminders that were missed, and figures without personal chats

**Migration required:** apply
`supabase/migrations/268_reminders_and_numbers.sql` before the build.
Additive for the previous build; nothing already late rings on applying it.
- A reminder the server missed (a restart, a database stall) still rings:
  a task up to 12 hours late ("Overdue"), an event or meeting up to 30
  minutes late and never after its end. Never twice.
- A phone reminder held through quiet hours is dropped when the task has
  been finished or handed to someone else by the morning.
- Team activity and the home dashboard no longer count personal (HR)
  WhatsApp numbers and chats, and the dashboard's response time counts
  only replies by a person, not a bot's or an automation's.
### Submission groups: later statuses, questions after the end, delivered sends

**Migration required: 267** (apply before the build).
- A status Compass sends after a submission's group has ended (a
  correction, "disbursed" after "approved") is stored on the group and
  shown on the case timeline. It never reopens or re-decides the case.
- A customer who writes into a group that has ended but is still open on
  WhatsApp rings the agent and coordinators who were in it (else the
  case's agent, else the admins), at most once per 30 minutes, and counts
  as unread until that notification is read.
- A message or attachment shown as failed because WhatsApp's answer was
  lost turns into sent when WhatsApp reports that it went out.

### Forwarding and reactions that match WhatsApp

No migration.
- Forwarding to several chats reports each one: a chat that failed no
  longer hides the ones already sent, and a copy whose outcome nobody
  knows says so instead of "failed".
- A reaction replaces a colleague's on the same number, as WhatsApp does,
  and is refused when the number that carried the message is gone.
### Hand over the work of a person who leaves

**Migration required: 266.** Apply `supabase/migrations/266_member_handover.sql`
before the build. Additive for the previous build.
- An owner or admin can move a person's company chats, open tasks, open deals
  and customers to a colleague in one go, and see what each deactivated member
  still holds (API only for now; the screens follow).
- The colleague gets one notification with the counts, not one per item, and
  the audit log records the handover. Personal WhatsApp chats never move.

### Guards on roles, ownership, erased files and late messages

**Migration required:** apply `supabase/migrations/265_guards.sql` before
the build. Additive for the previous build.
- What a workspace granted a person (review all calls, a personal
  WhatsApp number, the department) no longer comes back when they are
  removed and invited again.
- A role change and a transfer of ownership at the same moment can no
  longer leave a workspace without an owner.
- For 7 days after an admin's role is lowered by someone else, only the
  owner can set their password or change their login email.
- Erasing a customer deletes the files they sent in WhatsApp groups.
- A customer message processed late no longer replaces a newer message
  as the chat's preview.
### HR automated messages are not sent again after a timeout

No migration. A WhatsApp send that timed out, lost its connection or got a
gateway error (5xx) may have been delivered, yet was sent up to 3 times. It
is now marked "not confirmed" and never resent; only a failure after which
nothing can have been sent (a rate limit, a number not ready, a refused
connection) is retried. Check "not confirmed" messages in HR → Automated
messages after a gateway outage.

### AI answers that were cut off are never sent

No migration. When the AI provider stops before finishing an answer (the
length cap, a refusal, a content filter), the half answer is no longer sent
as if it were complete: the bot hands the chat to a person (after one retry
on the workspace's model when a smaller or larger one failed), and a draft,
a translation or an HR draft shows an error instead. OpenAI reasoning models
now have room for their hidden reasoning besides the reply, so a reply may
use more tokens on the workspace's key.
### Contact import and pipeline fixes

No migration.
- Contact CSV files keep quotes and apostrophes in names, and a line break
  or comma inside a quoted cell no longer breaks the row. `;` and tab
  separated files are read too. A row that cannot be read is listed with
  its line number.
- The contact import checks the file's own numbers (it stopped at the
  first 1,000 contacts), says before importing how many are new and how
  many are already there, lists every row it could not import with the
  reason, and asks before closing while it runs.
- The pipelines board shows every deal (it stopped at 1,000). When the
  deals cannot be loaded it says so with a Try again button.
- Editing a deal saves only the fields you changed, so it no longer undoes
  a colleague's change, and a board refresh no longer clears what you typed.
### A person who leaves takes their personal WhatsApp number with them

No migration.
- Deactivating or removing a member disconnects their personal WhatsApp
  number in that workspace. If the OpenWA server does not answer, the
  person is still deactivated and the admin is told to finish there.
- Nothing from a personal number is recorded once its owner is
  deactivated or no longer a member: messages, receipts, what they type
  on the phone and the history import. Company numbers are not affected,
  and reactivating someone reconnects nothing.

### A failing chat-history import no longer holds up the others

No migration.
- A personal number's import stopped by an error waits five minutes
  before its next try, so other people's imports run meanwhile.
- A chat the database refuses three times is left out and the import
  finishes; characters the database cannot store are removed.

### Limits on what reaches a customer's group, and on uploads

No migration.
- Deal rooms: only staff can send a template to the customer's group (a
  bank guest's composer closes with the reply window), and sends are
  limited to 30 a minute per person and 60 per room.
- Submission groups: a message nobody answered for is looked up before
  the words are given back, so it is not sent twice.
- WhatsApp groups: at most 60 people an hour added per person and 120 per
  number, and every group action refuses a department kept out of the
  sales areas (some only checked on the screen).
- Case desk: an upload is refused to anyone below agent before the file
  is stored, is limited to 60 a minute, and leaves no file behind when it
  is refused.
- Web form: with no known client address the limit is per form, so one
  caller cannot close every form.
### Files sent in WhatsApp groups can be opened

No migration. A photo, sticker, video, voice note or document somebody sends
in a WhatsApp group is now copied into the workspace's own storage, as in
one-to-one chats. On an OpenWA number such a file could never be opened; on a
Whapi number it stopped opening after about 30 days. Files received before
this update are not copied, and submission groups still keep Whapi's link.
The download button saves a document under its own name.
### The AI agent respects opt-outs and does not go quiet unnoticed

No migration.
- The AI agent never messages a contact marked do not contact or opted
  out, not even with a hand-off message: the chat goes to a person.
- A reply that failed to send no longer counts as an answer when the AI
  reads the thread.
- When the AI agent fails, or is over its reply limit, the chat is pinned
  as Important and the bell rings once, instead of nothing happening.
- Two quick questions inside a flow get one AI reply, not two.

### Group chats that stay current and never send twice

No migration.
- A WhatsApp group message that timed out is shown as "may have been
  sent" with Copy and Discard, not put back into the composer: sending it
  again could put it in the group twice.
- Your own attachment in a group on a linked number no longer reads
  "unavailable" when WhatsApp's echo arrives first.
- An open group or submission group chat catches up after sleep or a
  dropped connection, is marked read only while it is on screen, and a
  failed load has a Retry.
- A deactivated manager no longer blocks every change to a group's
  managers.
- A team chat channel (or the channel list) that could not be read says
  so with a Retry, instead of looking empty.
- The team chat badge no longer re-reads whenever anyone reads anything.
### The AI no longer sees ID, card or account numbers

No migration. Every message the AI reads (the customer's and ours, in
bot replies, drafts and the knowledge search) is now sent to the AI
provider with Emirates IDs, cards, IBANs, account and passport numbers,
one-time codes, phone numbers and e-mails masked. Salaries and other
amounts are kept, and so is a phone number an agent typed for a draft.
A bot reply that repeats a mask goes to a person instead. A labelled
passport number now counts as sensitive data for the warning reply.

### Webhooks during an outage, and an office behind one address

No migration.
- The Whapi webhook answers 503 (so Whapi sends again) when the database
  cannot be read; it answered 401, as for a wrong secret.
- A message holding characters Postgres refuses is stored on the first
  try.
- The sign-in lock for one address counts 60 failures (was 20): a whole
  office shares one. The limit per person is unchanged (5).

### A lost hang-up no longer holds the call screen

No migration.
- A call whose hang-up never arrived gives way to the next one: a ring
  quiet for 3 minutes leaves the card, and an answered call quiet for 10
  lets a newer call have the window (at 30 it can be closed by hand). A
  call the browser softphone holds is never treated so, and a hidden tab
  stops polling for calls.
### Video meetings recover when the video service drops someone

No migration.
- A person whose connection was slow to start could sit in a meeting
  hearing nobody, with the microphone button failing on every click. The
  call now rejoins by itself, with the microphone and camera as they were.
- Someone only listening keeps the call when the last person they receive
  leaves.
- When the video service could not be reached, the room says so instead of
  blaming the microphone or camera, and offers **Rejoin**.
- The server log names Cloudflare's reason for a refused call.
### Campaigns check opt-outs and quiet hours, finish, and never send twice

No migration.
- **A scheduled campaign continues by itself**, for 7 days after its
  appointment: past 1,000 recipients, after a restart, after quiet hours,
  when its number is connected again, and when the number's daily limit
  has room. The reason it waits is on the campaign page. One older than
  that, or sent straight from the wizard, still needs Resume. **On
  updating, a scheduled campaign of the last 7 days that is still
  "sending" goes on within minutes.**
- A send whose outcome is unknown (a timeout, a restart half way) is
  marked "May have been sent" and is never repeated, by Resume, Retry
  failed or the schedule.
- A campaign with more than 1,000 people is counted and sent to the end;
  it could be closed early, with people left out.
- Only one delivery runs per campaign, however long it takes. A Resume
  pressed while a `POST /api/v1/broadcasts` campaign goes out is refused.
- A database that does not answer no longer marks a scheduled campaign
  failed; it stays due.
- A customer who opts out while a campaign is going out is skipped, and the
  row says why. If the opt-out cannot be checked, the campaign stops with
  the rest still pending.
- A campaign that reaches its quiet hours stops there, with the rest
  pending. **Resume, Retry failed and Send now are refused
  inside the campaign's quiet hours.**

### Screen readers and keyboard: names for every control

No migration.
- Icon-only buttons (contact row menu, paging, remove, show/hide key,
  send, add note and others), the retention selects and both side
  navigations say what they are; buttons whose spoken name differed from
  their visible text now contain it, so voice control finds them.
- A pipeline card is one button. **Enter opens the deal; Space picks the
  card up**, arrows move it, Space or Enter drops it, Escape cancels.
### Text colours are easier to read

No migration.
- Accent-coloured and red text now has enough contrast (WCAG AA, 4.5:1) on
  the page, on cards and on its own soft tint, in light and dark mode and
  every accent. Buttons and other accent fills keep their colour; a solid
  red fill in dark mode is slightly deeper so white text on it reads.
- Inbox: the light-mode green, teal and message time are a little darker,
  the dark-mode time and teal a little lighter, and the AI badge and the
  name on a quoted message read inside a green bubble.
- Notification times, unselected tabs, days outside the month and today's
  weekday in the calendar are no longer too faint.

### Failed reads and missed events are shown

No migration.
- My worklist says which part could not be loaded (HR conversations,
  agent drafts, cases) and offers a retry, instead of "Nothing needs
  action right now". A part that loaded before keeps its rows.
- The customer page says when the open tasks, this month's calls or the
  deals could not be loaded, with a retry, instead of "No open tasks",
  "No deals" or a bar that never ends.
- The HR chat list and team chat (channels, unread counts, the open
  channel) read again after the laptop slept or the connection dropped.
### Fixed: phone events are stored before they are acknowledged

- The Yeastar webhook now answers only once every event of the push is
  stored (one short second try), and with 503 when one could not be, so a
  database hiccup no longer loses a call event the PBX was told had
  arrived. Processing still happens after the answer. No migration.

### Inbound WhatsApp messages survive a failure

**Migration required**: apply 264 (as a superuser or BYPASSRLS role)
**before** the build. Without it the build runs as before and logs
`NOT DURABLE` once.
- A customer's message is stored before the gateway is told it arrived. If
  saving it then fails (database error, restart), it is retried for several
  hours instead of being lost.
- If it cannot be stored at all, the gateway is answered 503 and delivers
  it again.
- One message that fails no longer holds back the others of its delivery.
- A message given up on rings the bell of owners and admins.
- Operators: the retries run in `GET /api/automations/cron`, so that cron
  must be scheduled. `/api/metrics` has `wacrm_inbound_queue_*`
  (`docs/monitoring.md`).
### Submission groups: nothing lost between Compass and the CRM

No migration.
- A status Compass reports that the case could not take now answers an error,
  so Compass sends it again; before, a final status could be lost for good.
- A submission whose case could not be opened gets it with Compass's next
  update, or within minutes by itself; before, it stayed without a case.
- One broken WhatsApp number no longer holds up the groups of the others, and
  closing a group waits while its number is disconnected.

### Submission groups: no second WhatsApp group

No migration.
- When WhatsApp does not confirm that a submission group was made, the next
  try first looks for it on the number and adopts it, and makes a new one only
  when the whole list holds none. After 5 unconfirmed tries it stops, with the
  reason shown, until an admin presses Retry.
- A phone event whose processing was interrupted (a restart) is retried.
  An old one never rings, opens a task or changes a current status: past
  an hour it only completes the call's record.

### Reminders and meeting invites after sleep

No migration.
- A reminder missed while the laptop slept or the connection was down
  (up to 2 hours) rings once when it is back, with the time it was for.
  One already shown or dismissed does not come back.
- A missed meeting invite rings only if someone is in the meeting now.
### Inbox on a bad connection

No migration.
- A reply that was not sent stays in its chat, also after leaving the
  Inbox: "Not sent" with Retry, Copy and Discard when it certainly did
  not go out (offline included), "May have been sent" with Copy and
  Discard when it may have. One that turns out to have arrived goes by
  itself. Leaving the Inbox during a send that then fails puts the words
  back as that chat's draft.
- A chat whose messages could not be read says so with Retry, instead of
  "No messages yet" and the new-chat notices; a failed "load older" has
  a Retry too.

### Editing and deleting customers and deals

No migration.
- **Agents and team leaders no longer see Delete on the contacts list**
  (row menu, right-click, bulk bar), like on the customer page. Admins
  and owners still do.
- Custom fields on the customer page: saving writes only the fields you
  changed, so a failed load or save no longer wipes the others and two
  people can edit different fields. If they cannot be loaded, the card
  says so and offers Retry.
- Editing a contact saves only what you changed, so it no longer undoes a
  colleague's change to another field.
- A save, move or delete that changed nothing (you lost access, or it was
  removed) now says so instead of showing success, a dragged deal goes
  back to its stage, and a bulk delete counts what was really deleted.
### Server log with times

No migration.
- Every line of the server log starts with the time and level
  (`LOG_TIMESTAMPS=off` to leave them bare), and a request that fails
  with an unhandled error logs which route it was, without the query.
### Automations: stopping, opt-outs, Dubai time and failed steps

No migration. What changes for automations already running:
- **Switching an automation off now stops the people waiting in it.**
  When a Wait comes due and the automation is off or deleted, nothing
  runs and the log says "stopped: the automation was switched off".
  Switching it back on before the wait ends lets them continue.
- **Opted-out customers** get no automation message (text, template,
  buttons, list) unless it directly answers the message they just wrote.
  After a Wait, a tag, or a trigger posted to the API the message is
  skipped, the log says why, and the other steps run. If the opt-out
  cannot be read, nothing is sent.
- **"The time is within a window"** now means Dubai time. It used the
  server's clock (UTC in production), so 09:00-18:00 really ran 13:00 to
  22:00 in Dubai. If you shifted your hours to make up for that, set them
  back.
- **Steps whose save failed** (create deal, update contact, assign to a
  person, close conversation, wait) are now logged as failed and stop
  the run, instead of showing success.
### Inbound messages keep the contact's name and find the right contact

No migration.
- An inbound message no longer overwrites a contact's name with the
  sender's WhatsApp name or number. It only fills an empty name or
  replaces the contact's own bare number, and never with a number.
- Two international numbers that share their last 8 digits
  (+971 50 123 4567 and +966 50 123 4567) are two contacts, for messages,
  calls and the API. Only a contact saved without its country code is
  still matched by those digits, and only when it is the one match. The
  API's `to` without a country code matches only a contact saved that way.
- A failed contact lookup is reported as a failure. It used to be read as
  "no such contact" and could create a second contact and chat.
### Sign-in hardening

No migration.
- "Forgot password" tells people to ask an administrator, who sets a new
  password in Settings → Members. It used to promise an email that could
  not arrive.
- Your email in Settings → Profile is read-only; an administrator changes
  it in Settings → Members.
- Changing your own password goes through the server: the sign-in lockout
  counts wrong guesses, and your other devices are signed out.
- A short outage of the auth service no longer sends signed-in people to
  the login page. API calls answer 503 until it is back.
- Automations, flows and quick replies no longer show raw database
  messages when a request fails.
### The open chat keeps its place

No migration.
- The open chat no longer jumps to the bottom on every status change in
  any chat. It scrolls only when opened, on your own send, or when you
  are already at the newest messages; otherwise a button counts what
  arrived below.
- A message still being sent stays on screen when another one arrives,
  and a resync no longer shows it twice.
- A chat left open in a hidden tab stays unread until you look at it,
  and a failed "mark as read" is tried again.
### Screens that catch up after sleep or a dropped connection

No migration.
- **Unread badges, team notes, the bell and the team chat badge** read
  again when the connection returns or the tab comes back after being
  hidden for a while, and retry a failed read. A chat moved out of your
  sight no longer stays counted.
- **Inbox list.** A list that could not be loaded says so and offers
  Retry instead of "No conversations found"; so does a further page.
- **Typing with an input method** (Korean, Chinese, Japanese): the Enter
  that finishes a word no longer sends the message, caption or note.

### Dependencies and repository settings

No migration. Run `npm ci` after pulling.
- Every package with a known vulnerability is updated (`npm audit`: 18 to
  0; the MCP server 9 to 0). The `shadcn` CLI package and its
  dependencies left the install: only its stylesheet was used, and that
  is vendored in `src/app/shadcn-tailwind.css`.
- Scripts read `.env.local` with Node's own loader (they relied on a
  package that was never declared). Node 22 or newer, as before.
- CI checks production packages for high vulnerabilities and builds the
  MCP server; its token is read-only. Dependabot is batched and no
  longer proposes ESLint 10, which crashes the React lint rules.
- Test fixtures hold no real company, person or phone number.

### Case desk: WhatsApp documents reach the desk

No migration.
- A customer's WhatsApp document was offered to the case desk under its
  folder's reference (`TC-000123`) instead of its own id, so every offer
  failed (`[desk] route failed` in the log, nothing else affected) and
  routing could not work once switched on. The desk now finds the
  document by the message it arrived on.

### Two phone dialogs and the Privacy screen

No migration.
- **Phone.** Team chat's New channel and Create workspace opened with
  their right half off the screen.
- **Privacy.** A preview, hold or erase answer is shown only for the
  customer it was asked for, and changing a hold clears the preview.
  Releasing a hold asks first, and a hold that could not be read is said
  so instead of showing "not on hold".

### Contacts, saved views and desk fixes

No migration.
- **Add to campaign** now shows only to owners and admins, on Contacts
  and Recycle; below that it led to a page they cannot open.
- **Contacts list** pages no longer repeat or skip a customer created in
  the same instant.
- **Shared views** no longer carry the search text, and applying one no
  longer changes your own column choice. A view whose chat tag was
  deleted warns you, and is not applied when none of its tags is left,
  instead of showing everyone.
- **Phone numbers** that are really ids (`...@lid`, `erased-...`) show
  as stored, and UAE 800 / 600 numbers no longer get a `+`.
- **Desk.** "Suggest a case" needs the workspace's AI safety switch on
  and is limited to 20 a minute; an impossible date or a NUL character
  in a field is a clear 400, not an error; the document types list is for
  agents and up.
### Cases: search, next step and tray fixes

No migration.
- **Cases search.** Text typed quickly is no longer lost when an earlier
  search arrives, and choosing a bank or other filter keeps the search (and
  the other way round). The box is always visible on phones, a replaced
  search is cancelled, and "Load more" is offered when nothing has matched
  yet but more cases are left to search.
- **Case overview.** "Next step" waits for the documents, says so when they
  cannot be loaded, and never advises a stage move on a case Compass manages
  or to someone who cannot change it.
- **My team** (Cases and My worklist) says when the team could not be loaded,
  with Retry, instead of showing only your own cases.
- **Case desk tray.** File and Dismiss stay disabled until the list has been
  read again.
- **Case reviewer.** One pass starts no new case after 40 seconds.

### Menu, HR and worklist fixes

No migration.
- **HR.** Owners and admins always get every HR tab; if the HR roles
  cannot be read, `/hr` says so and offers Retry instead of staying on
  "Opening…".
- **Menu badges.** A folded group shows the total of its badges, and
  people with the Team inbox see its unread count on the Inbox row again.
- **My worklist.** A failed refresh keeps the customers on screen instead
  of saying nobody is waiting, and a hidden tab no longer polls.
- **Ctrl+K** lists a report the owner granted you, and letters typed in
  an open menu no longer jump to another screen.
- **Phone.** The call window, the meeting "Rejoin" card and the reminder
  card sit above the new bottom bar.

### Inbox: notes, "/" replies and the 24-hour block

No migration.
- **Every chat opens on Reply.** A chat left on Note reopened on Note, so
  an answer for the customer could be saved as a note nobody sent. Note
  now lasts only while the chat stays open.
- **Half-written notes are kept.** Switching chats no longer loses a note:
  its text and the people mentioned come back when the chat and Note are
  opened again, until it is saved or someone else signs in.
- **"/" never goes to the customer by accident.** Enter does nothing while
  the quick replies are loading or none match; Escape closes the list and
  Enter then sends. If the list cannot load, it closes by itself.
- **24-hour block only when certain.** Free text is blocked only where the
  reply surely goes out on the Meta number, judged as the server does: by
  the number the customer last wrote to. The countdown follows the same
  rule. Buttons, lists and library voice notes are refused too once the
  window closes.
- **Smaller fixes.** A double tap on Send no longer starts a recording, and
  the phone's chat actions strip closes by itself.
### Release fixes in the database

**Migration required:** apply `263_release_fixes.sql` after 262, as a
superuser or BYPASSRLS role.

- Taking turns with nobody ticked leaves out people in a department with
  its own inbox or restricted access, so a sales chat no longer lands in HR.
- A submission joins a case desk case only when it is the same company's;
  otherwise it opens its own case and the desk case stays open.
- A document of an unknown customer is no longer filed on a case of an
  unknown customer.
- STOP counts while a reminder is being sent and after a feedback request,
  and cancels the waiting ones.
- Switching response times on no longer rings for customers who were
  already waiting.
- Document reminders past the first 500 files get their task.
- Customers approved since they were declined are left out of recycling.
- Privacy export and erasure find a campaign draft row by the last nine
  digits of the phone.
- An SMS backlog no longer holds back WhatsApp automated messages.
- The reminder template must be approved in the chosen language.
### Privacy: erase and retention fixes

**Migration required:** apply `262_privacy_fixes.sql` after 261, as a
superuser or BYPASSRLS role, before the build. It restates functions of
222, 223 and 225: apply in order, once.
- Erasing a customer no longer deletes a file something else still uses
  (a library voice note, a forwarded file, a template or broadcast
  header, a case document, another customer's message), and never one of
  another workspace.
- The list of files to delete is stored with the request, and the daily
  job finishes a deletion that failed or was interrupted.
- The retention sweep honours a legal hold fully: calls matched by
  number, deal rooms, and WhatsApp groups with the held customer in them.
- A contact whose legal hold was released can be deleted again; one under
  an active hold is refused with a clear message.
- A retention policy without `days` or `action` is refused.
- Erase works for a customer the AI safety checks have read and for one
  in a WhatsApp group: the tables behind both refused what 222 did to
  them, so the whole erase failed.
- A case review that kills its run stops after 5 attempts.
- Docs: an opt-out does not follow an erased customer's number.
### Safer automatic customer messages

No migration. All of these stay off until an admin switches them on.
- **Slower sending.** Case rating requests and desk reminders go out at
  most 5 at a time every 5 minutes, and never past a linked number's
  daily limit of new chats. A rating request over the limit waits; a
  reminder over it is not sent, and the next waits for the usual gap.
- **Opt-outs.** Both check again, right before each message, that the
  customer has not opted out or been marked do-not-contact.
- **Rating replies.** Ordinary messages that start with a digit ("2 years
  in business", "1. Passport", "3 pm call me") are no longer stored as a
  rating. "5 great" is not one either; "5", "5/5 great" and "5, great"
  are.
- **Sorting queue alerts.** At most one task per bank, level and day,
  instead of a new one each time the next upload becomes the oldest.
- **SMS STOP.** When a STOP text could not be recorded the SMS webhook
  now answers 503, so the gateway can send it again.

### Before going live: menu speed, sign-in links, AI check

No migration.
- **Menu speed.** Since the language became per person no screen is built
  ahead of time any more, so Inbox, Contacts, Dashboard, Team chat,
  Settings and My worklist would each have waited for the server on every
  click. The menu, the phone's bottom bar, the HR tabs and the Mine / Team
  switch load their screens ahead again.
- **Sign-in links.** A crafted `/login?next=` address could send someone
  to another website after signing in. It is refused now.
- **AI privacy check.** The check in front of every AI request gives up
  after 1.5 seconds and lets the request through, so a slow database
  cannot hold up a reply.
- **Web form.** Junk posts no longer use up a form's hourly allowance.
### A broadcast draft can only be sent once

No migration. Sending a reopened draft now takes the draft first, so two
people (or two tabs) with the same draft open can no longer both send it.
The second one is told it was already sent or deleted.
- If the send fails before a campaign exists, the draft is saved again.
  If the campaign exists, its own page opens so it can be continued there.
- Saving a draft that was sent or deleted elsewhere says so instead of
  reporting success.
- A draft whose template is no longer approved reopens on the template
  step, and one whose schedule has passed says the time was removed.

### Lead source on API broadcasts

No migration. A contact created by `POST /api/v1/broadcasts` gets
`lead_source` `broadcast`, as the wizard's CSV audience already did.
Contacts created by `POST /api/v1/contacts` without a `lead_source`, and
by `POST /api/v1/messages`, keep none, so a later ad referral can still
fill it.

### Reports count true arrivals

**Migration required:** apply `261_report_counting.sql` after 260, as a
superuser or BYPASSRLS role. No build needed. It restates `funnel_report`
(254) and `chat_tag_report` (255, 256): apply in order, once.
- Chat tag report: moving a chat only between sub-tags (Interested ·
  ADCB to Interested · HSBC) no longer counts as a second arrival at
  Interested, and a chat seen under two sub-tags counts once.
- Sales funnel: it reads the Interested tag's log once instead of once
  per chat, and an unlabelled Meta number shows as unnamed rather than
  by its account id.

### Note mentions reach everyone who can open the chat

**Migration required:** apply `260_note_mentions_match_chat.sql` after
256. No build needed.
- 256 had narrowed who a note can @mention on a company chat, leaving
  out the owner of a personal number (and their team leader) on older
  company chats that sit on that number. Those people can still open
  the chat, so they were silently left out of the mention list and
  never rung. 260 restores the original rule (241): a note can mention,
  and rings, exactly the people who can open the chat. 256 now carries
  the same rule, so re-running 241, 256 or 260 in any order changes
  nothing. `docs/chat-notes.md`.

- Docs: CLAUDE.md split into a short index plus docs/agents/*

### Small follow-ups (checked on the local demo)

- **Fixed:** in Arabic, Groups and Team chat told people to pick from the
  list "on the left"; the list is on the right there. They now say "from
  the list".
- **Fixed:** names and phone numbers in the pipeline contact picker and on
  Recycle keep their order in Arabic.
- **Tests:** Compass marking a contact it created as a `compass` lead (and
  not one it only found) now has a test. Case CSAT was run end to end
  against a stand-in WhatsApp gateway: queued on submission, sent once as
  plain text from the chat's number, the customer's "5" captured, a
  second reply not counted.
- **Tooling:** the "Apply migrations" workflow's check lists 257 and 259;
  `@formatjs/icu-messageformat-parser` (used by the Arabic catalogue
  test) is a declared dev dependency at the version next-intl already
  installs.

### Web form: browsers can submit it

- **Fixed:** the hosted web form (`/f/<link>`) refused every submission
  from a real browser with 403. Its pages told the browser to send no
  referrer, so the browser posted with `Origin: null`, which the form
  rightly refuses; only scripts that set an Origin got through. The pages
  now use `Referrer-Policy: same-origin` (the link still never reaches
  another site).
- **Fixed:** inside an iframe on an allowed website, the "thank you"
  redirect after sending was blocked by the app-wide `X-Frame-Options`.
  The post route now gets the form's own frame headers, as the page does.
  Tried end to end in Chromium: an allowed https site embeds and submits,
  an unlisted site and an emptied list are refused.

### Your own language, including Arabic

**Migration required:** apply `259_preferred_language.sql` (adds
`profiles.preferred_language`, `set_my_language()` and two profiles
triggers). Without it the app still runs: nobody can save a language, and
everyone sees the workspace default.

- **Added:** each person picks English, Arabic or Korean in Settings →
  Appearance → Language. The choice is saved on their profile, so it follows
  them to every device; people who have not picked one see the workspace
  default (`NEXT_PUBLIC_APP_LOCALE`, still build time). Arabic is shown right
  to left, with Noto Sans Arabic for its letters. The Arabic text is
  machine-translated and still needs a native reader (`docs/languages.md`).
- **Fixed (Arabic screens, checked on screen):** the phone menu no longer
  sticks out over the left edge when closed; side panels open from the right;
  switches move the right way; expand arrows point the reading way; English
  message previews and bubbles keep their punctuation and are cut at their
  own end; phone numbers in Contacts and numbers shown as a name keep their
  order; the Appearance mode and colour names, Contacts' Created date, deal
  dates and the Case desk ages ("10 س 32 د") follow the person's language.
- **Changed:** the layout uses logical (start/end) Tailwind classes, so every
  screen mirrors in Arabic. Direction icons flip; charts, phone numbers and
  email fields stay left to right. `scripts/rtl-sweep.mjs` converts physical
  classes and is safe to run again. The funnel CSV export and the global
  error page follow the person's language instead of the build-time one.

### Contacts sort, lead sources, embeddable web form

**Migration required:** apply `257_contact_sort.sql` (adds
`contacts_sorted_page`, SECURITY INVOKER) before deploying; re-runnable.
Without it the three new sort headers are disabled and the list stays newest
first.

- **Added:** Contacts and Team contacts sort by Owner, Assigned to and a new
  Last activity column (company chats only), kept in the URL
  (`?sort=owner|assignee|activity&dir=`) and in saved views.
- **Added:** `lead_source` is filled for contacts created from a broadcast
  CSV (`broadcast`) and contacts Compass creates on a first message
  (`compass`, only if empty). `POST /api/v1/contacts` and the MCP
  `create_contact` tool accept an optional `lead_source`.
- **Added:** the hosted web form `/f/<token>` can be embedded in an iframe by
  the websites on that form's allowed list (Settings → Web form shows the
  snippet). An empty list, an unknown or disabled token, or a failed lookup
  still means no framing. Every other route is unchanged.
- **Changed:** the "Assigned to" column reads company chats only (it used to
  take the assignee of any chat, personal ones included), so it matches its
  sort.

### Tooling: apply a range of migrations

`scripts/apply-migrations.sh FROM TO` applies `supabase/migrations` files in
order with `DATABASE_URL`, one psql call each, stopping at the first error.
It checks the role first (superuser or BYPASSRLS), takes a `pg_dump` backup
into `backups/` unless `SKIP_BACKUP=1`, and tells PostgREST to reload.

### Review fixes

**Migration required:** apply `256_review_fixes.sql` (as a superuser or
BYPASSRLS role) after 255 and before the build. It restates
`conversation_note_user_can_see` (241), `recycle_excluded_among` (251),
`web_form_submit` (249), `assignment_compass_assign` (236),
`chat_tag_report` (255) and `response_escalation_sweep` (237): apply in
order, once (re-running one of those files afterwards undoes its fix).

- **Broadcast drafts are owners and admins only.** A saved draft's
  wizard state, which can include an uploaded CSV audience (phones and
  names), moved from `broadcasts.draft_state` (readable by every member,
  viewers included) to the new admin-only `broadcast_drafts` table.
  Existing drafts are copied across. The state is in PDPL export and
  erase.
- **Note @mentions:** this change was wrong and is undone by 260 (see
  "Note mentions reach everyone who can open the chat").
- **Declined recycling:** the exclusion check answers team leaders and
  up only, and ignores personal-number chats. `docs/recycle.md`.
- **Web form:** never renames an existing contact or fills their email;
  the submitted name and email go in the "New web lead" task. The
  preflight is rate-limited per IP, and a new per-IP-per-form limit (5
  an hour) stops a few addresses using up a form's hourly allowance.
  `docs/web-form.md`.
- **Compass assignment** leaves a chat someone is working
  (`human_engaged_at`), reason `engaged`.
- **Chat tag report:** a grant is deleted when the person is
  deactivated or leaves the workspace, so it does not come back on
  re-add; an unlabelled number shows "Unnamed number ending NN", never
  its phone number. `docs/chat-tag-report.md`.
- **Response-time escalations:** chats already rung at their level, or
  still under target in business hours, no longer crowd out newer waits.
- 237's helper functions are no longer executable by anonymous callers.
- The broadcast recipient CSV download goes through the shared CSV
  builder (formula starts neutralised).

### Reports: sales funnel, chat tag report and CSV downloads

**Migration required:** apply `254_funnel_report.sql`, then
`255_chat_tag_report.sql` (as a superuser or BYPASSRLS role), after 253
and before the build.
- **Sales funnel** (`/reports/funnel`, owners and admins): new chats →
  Interested → case opened → submitted → approved, with declined and
  withdrawn beside, for a chosen period, as counts and conversion between
  stages. Filters: lead source, agent, bank, WhatsApp number. Days follow
  the account's time zone. CSV download. `docs/funnel-report.md`.
- **Chat tag report** (`/reports/tags`): chats per main tag and sub-tag
  (e.g. Interested · ADCB), split by agent, number and lead source, and
  the chats that arrived at each tag in the period. Counts only, never
  chat contents, names or phone numbers. The owner always sees it and
  ticks who else may; a grantee sees workspace-wide counts and gets the
  menu link. Movement counts from the day 255 is applied.
  `docs/chat-tag-report.md`.
- **Reports** (`/reports`) lists the reports the person may open.
- **Owner-only CSV downloads** on Team activity (per person and per
  number for the chosen range) and on the dashboard's figures. Every CSV
  quotes each field and neutralises cells starting with `=`, `+`, `-` or
  `@`.

### Page shell, menu, command bar and phone layout

No migration.
- One title per page: the top bar's title is the only heading; screens
  keep their description as an intro line.
- No text below 12px anywhere.
- Shared loading, empty and error states on the main list screens. The
  Flows builder shows step names ("Send message 2") instead of node keys,
  and both Flows and Automations explain "Flow or Automation?".
- Menu: groups fold (remembered per person on this device), HR is one item
  with tabs, Team inbox / Team contacts became a Mine / Team switch on the
  screens, My activity sits under My worklist, a Reports group, and a
  workspace switcher for people with several workspaces.
- **Ctrl/Cmd+K** command bar: jump to a screen, find a customer or chat,
  run common actions; shortcuts `g i`, `g w`, `g c`, `g k`, and `?` for the
  list.
- Phone: a bottom bar (Inbox, Worklist, Contacts, Team chat, More), a menu
  drawer with proper focus handling, one "Chat actions" menu in the chat
  header, and the timeline first on the customer page.

### Merge follow-ups: phone-push links and lead source privacy

**Migration required:** apply `253_merge_followups.sql` as a superuser or
BYPASSRLS role, after 252. It restates 205's `push_bell_url`: apply in
order, once.
- A phone push for a notes @mention or a response-time bell opens the
  chat, as the in-app bell already did.
- PDPL export includes a contact's lead source; erase empties its
  details (the ad referral) and keeps the category.

### Lead source, public web form, contacts table, saved views, audiences and Recycle

**Migration required**, each as a superuser or BYPASSRLS role:
`249_lead_source_web_form.sql` **before deploying the build** (the contact
form and CSV import now write `lead_source`; without the column those
inserts fail), then `250_saved_views.sql`, `251_recycle_declined.sql` and
`252_broadcast_drafts.sql`.
- **Lead source.** Contacts record where they came from (ad, web form,
  broadcast, manual, import, Compass, other). A Meta click-to-WhatsApp
  ad's referral is captured on the contact's first inbound message; Add
  contact records `manual`, Import `import`. Automatic writers only fill
  an empty source. The public API's contacts carry a read-only
  `lead_source`.
- **Public web form** (Settings → Integrations → Web form, owners and
  admins, off by default): a hosted page `/f/<token>` and an HTML snippet
  post to `POST /api/public/web-form/<token>`, which creates or completes
  the contact and opens an unassigned "New web lead" task (one per number
  per 10 minutes). Allowed websites, rate limits, honeypot, 8 KB cap.
  Never sends WhatsApp, never touches consent. `docs/web-form.md`.
- **Contacts table.** Sortable Name and Created, sticky header, phones as
  `+971 50 123 4401` with Copy, bulk "Set chat tag" and "Add to
  campaign", hide empty columns, a Source column and filter.
- **Saved views** on WhatsApp inbox and Contacts: personal ones for
  everyone, shared ones saved by team leaders and up.
- **Campaign audiences.** Match any / match all for chat tags; narrow by
  bank (from the case, or the chat's sub-tag) and by lead source; Save
  draft saves the whole wizard and reopens from the Broadcasts list.
- **New broadcast with no templates** shows a "Create template" button
  that leads back to the wizard.
- **Recycle** (`/recycle`, team leaders and up): customers declined,
  withdrawn or tagged not interested at least 90 days ago (settable),
  never opted-out, do-not-contact, open-case or returning ones; start a
  campaign or file follow-up tasks. Nothing is sent automatically.
  `docs/recycle.md`.

### Cases and Case desk

**Migration required**, each as a superuser or BYPASSRLS role:
`246_case_csat.sql` (after 234) and `248_intake_file_preview.sql` (after
220 and 230). 248 adds the Supabase origin to the CSP `frame-src`:
rebuild so `NEXT_PUBLIC_SUPABASE_URL` is inlined.
- **Customer ratings (CSAT)**, off by default. When a case is submitted
  and when it is approved, the customer is asked to rate the service 1–5
  from their chat's own number: plain text on Whapi/OpenWA and inside
  Meta's 24-hour window, an approved utility template on Meta outside it
  (else the request waits). A reply within 7 days is stored once and
  shown on the case page; Cases shows the 90-day average per agent and
  per bank. Respects opt-out, do-not-contact, send hours (09:00–20:00
  Dubai) and one request per person a day. `docs/case-csat.md`.
  **Meta templates to submit** before switching CSAT on with a Meta
  number (utility, names changeable in the settings card):
  - `case_csat_submitted`: "Hi {{1}}, your {{2}} application has been
    submitted to the bank. How happy are you with our service so far?
    Reply with a number from 1 (not happy) to 5 (very happy)."
  - `case_csat_approved`: "Hi {{1}}, good news: your {{2}} account has been
    approved! How would you rate our service? Reply with a number from 1
    (not happy) to 5 (very happy)."
- **Case page.** Overview opens on the document checklist, the next step
  and the customer's last message; empty history boxes are hidden. The
  header shows the case number and caption code with Copy buttons.
- **Cases list.** A search box finds by case number, caption code or
  customer name (kept in the link). The main filters fit one row; the
  toggles sit behind "More filters" with a count.
- **Case desk.** See the PDF or image beside the sort panel and in the
  Tray (5-minute signed links, every preview audited). The open tab is
  in the link (`?tab=`), Sorting queue and Tray show counts, and the My
  worklist card opens the right tab. Desk codes, WhatsApp routing, the
  reminder digest and coordinator cover moved to **Settings → Case
  desk**. Forms use a labelled document-type list, the app's own
  controls, look the case up as its number is typed, say why a button is
  disabled, and the Tray has "Find case". Card spacing fixed.
- Customer page: the "WhatsApp" button is now "Open chat".

### Chat assignment, response times, My worklist and Live view

**Migration required:** apply `236_assignment_rotation.sql` (as a
superuser or BYPASSRLS role), `237_response_targets.sql` and
`238_live_view.sql`, in order, after 235.
- **A real rotation.** One engine picks the next person from a chosen
  list in turn, skipping anyone offline, deactivated, a guest or viewer,
  or at their chat limit; nobody free means nobody assigned. The
  automation **round robin** step now rotates (before, it gave every chat
  to the first member, usually the owner), with an on/off switch and a
  people list.
- **Settings → Chat assignment** (owners and admins), all off by
  default: first replies to a broadcast go through the rotation; a chat
  Compass writes to goes to the case's agent and is shared with the
  coordinator; chat limits (30 open chats by default, per-person
  overrides), with each person's load in the Assign menu.
- **Response times** (Settings → Inbox & CRM), off by default: business
  hours (Mon–Sat 09:00–18:00 Asia/Dubai), a 15-minute target, and bells
  for the assignee at the target, their team leader (or admins) at twice
  it, and admins for unassigned waiting chats. Personal chats never
  count.
- **My worklist** opens with customers waiting for a reply, oldest
  first, unassigned flagged. After sign-in agents and team leaders land
  on My worklist; owners, admins and viewers on the dashboard.
- **Live view** (`/live`, team leaders and up): who is online, open
  chats, customers waiting and the oldest wait, replies today.
- **My team** on My worklist and Cases for team leaders; "Overdue by
  2 h" instead of a raw score.
- Automations: "Start from template" always in the Create menu, the
  condition step as a sentence, time pickers and preset schedules.
  Team activity's Replied card reads "100% (8 of 8)".

### Inbox and message box

**Migration required:** apply `241_conversation_notes.sql` (after 229)
and `242_voice_note_library.sql`, in order, before the build.
- **Inbox list rows.** The preview has its own line; tags sit on the
  agent line with a short bank sub-tag; an unassigned chat reads
  "Unassigned" with an Assign menu; the contact panel is hidden until a
  chat is open.
- **Browser tab and alerts.** "(3) Inbox — Taamul Connect"; an optional
  new-message sound (off by default, per person); a one-time prompt to
  turn on notifications when push is set up.
- **Share with bank**: a labelled button, the bank pre-selected from the
  chat's sub-tag.
- **WhatsApp-like composer.** Attach and AI inside the box, a mic that
  turns into Send; templates, quick replies, interactive messages,
  translate and voice notes in one **More** menu. Type `/` for quick
  replies; the picker has search.
- **Meta 24-hour window.** On Meta chats a closed window shows a banner
  with **Send template** and refuses free text by every path; the header
  counts down the last 2 hours. Whapi, OpenWA and personal chats are
  unchanged.
- **In-chat notes and @mentions.** Switch Reply to Note; only the team
  sees notes, and they never reach the customer, AI, unread counts,
  webhooks or the public API. An @mention rings a bell that opens the
  chat. `docs/chat-notes.md`.
- **Voice-note library.** Voice notes per subject and language (English,
  Hindi, Arabic, Urdu), recorded in the browser or spoken by AI from a
  fixed or personalised script (the workspace's OpenAI key). Shared with
  the whole workspace at once. `docs/voice-library.md`.

### Case desk: My worklist and suggested cases

**Migration required:** apply `235_desk_worklist_suggest.sql` (as a
superuser) after 234.
- My worklist shows a Case desk card: tray documents to sort, uploads
  in your sorting queues, your untagged uploads and your desk
  follow-ups.
- Tray → **Suggest a case**: Jev names the most likely case and how sure
  it is. Advice only: it never files and never picks the case for you.
- See `docs/case-desk.md`.

### Case desk: daily reminder to customers

**Migration required:** apply `234_desk_reminder_digest.sql` (as a
superuser) after 233.
- Off until an owner or admin switches it on with an approved utility
  template (`{{1}}` = application number, `{{2}}` = what is missing).
- At most one WhatsApp reminder per company per day, listing each
  missing document once across all its banks; not again for 2 days, nor
  after the customer sent a document.
- Never in quiet hours (21:00–08:00 Dubai), never to someone opted out,
  at most 3 automated messages per person per day; replying STOP opts
  the person out.
- See `docs/case-desk.md`.

### Case desk: one checklist per application, and expiry tasks

**Migration required:** apply `233_desk_application_view.sql` (as a
superuser) after 232.
- Companies → Banks and documents now shows one merged checklist: each
  document once, against the strictest validity, with every bank's own
  status for it.
- A document about to expire (14 days), expired, or replaced at another
  bank raises a follow-up task on each case not yet submitted.
- See `docs/case-desk.md`.

### Case desk: coordinators, leave and queue alerts

**Migration required:** apply `232_desk_bank_cover.sql` (as a superuser)
after 231.
- Case desk → Overview → **Coordinators and cover**: name each bank's
  primary and second coordinator, record leave, and see who covers today
  (primary, else second, else the desk duty owner).
- Uploads waiting in a bank's sorting queue for over 2 hours now give
  the second coordinator a follow-up task; over 4 hours, the lead.
- See `docs/case-desk.md`.

### Case desk: one document for several banks

**Migration required:** apply `231_desk_shared_documents.sql` (as a
superuser) after 230.
- Companies → **Banks and documents**: a company's cases at every bank
  with their stage, the consent to reuse documents per bank, and the
  files of the cases you can open.
- Link a stored document into another bank's case of the same company,
  without copying it; each bank keeps its own status for it.
- Reuse at another bank needs the company's consent for that bank,
  recorded with its evidence and revocable with a reason.
- The database now refuses a case file that belongs to another
  customer.
- See `docs/case-desk.md`.

### Case desk: WhatsApp documents and the tray

**Migration required:** apply `230_desk_whatsapp_routing.sql` (as a
superuser) after 229.
- Off until an owner or admin switches it on (Case desk → Desk codes →
  WhatsApp routing).
- A customer's 1:1 WhatsApp document is filed to their desk case only
  when it is certain: a reply to our message naming the case, a case
  code in the caption, or the single open case of a one-company sender.
  Never by phone number alone.
- Everything else goes to the new **Tray** tab with the candidate cases
  and none pre-selected; a document from someone other than the case's
  customer (a PRO) is always filed by a person. Filing to a company the
  sender does not act for needs its name typed.
- Staff can send documents from their saved WhatsApp number with a
  caption such as `4271RAKD ejari`; they become desk uploads in their
  name.
- A duty owner for the tray; a document left waiting past the delay
  (default 2 hours) becomes a follow-up task.
- See `docs/case-desk.md`.

### Case desk: who acts for a company

**Migration required:** re-apply `221_privacy_export.sql` and
`222_privacy_erase.sql` (they now call the new privacy registry), then
apply `229_desk_customer_contacts.sql` (as a superuser). 229 refuses to
apply until 221 and 222 are re-applied.
- New **Companies** tab on the case desk: find a company by trade
  licence or name and see who acts for it (owner, PRO, accountant,
  other), marked authorised or not. One phone may act for several
  companies.
- Each desk case's contact is linked to its company automatically;
  existing desk cases are linked when 229 is applied.
- A link gives nobody access to anything. Writers of a company's case
  and team leaders and up change the people; anyone who can read a case
  of the company sees them.
- The links are part of a customer's PDPL export and are kept on
  erasure (KYC), the contact itself being anonymised as before.
- See `docs/case-desk.md`.

### Health checks and metrics

**Migration required:** apply `228_hr_automsg_outbox_stats.sql` (as a
superuser) after 227.
- `GET /api/healthz` (the app is up) and `GET /api/readyz` (the database
  answers within 2 seconds), no sign-in needed. Docker's health check now
  uses `/api/healthz`.
- `GET /api/metrics` for Prometheus: memory, uptime, event-loop delay,
  refused requests, the HR automated-message queue (queued, held,
  failed, by channel) and which optional integrations are on. Off until
  `METRICS_TOKEN` (32+ characters) is set; send it as a Bearer token.
- At start the server logs which optional integrations are on, and
  warns when an untested one (RCS, SMS) is in use.
- See `docs/monitoring.md`.

### Push helpers closed to the service role

**Migration required:** apply `227_push_helper_grants.sql` (as a
superuser) after 226. On a classic Supabase project the service role
could still call `push_eligible` and `can_view_conversation_for_user`
over the API (109 and 190 revoked them from every other role); nothing
in the app does, and now it cannot.

### Migrations check in CI

The "Apply to a clean database" job had never passed: the CLI's own
runner is off (`supabase/config.toml`, because 044 must run in
autocommit), and the CLI's current image no longer grants the API roles
access to new tables. CI now replays every migration through `psql` in
autocommit after restoring the classic default grants
(`supabase/ci/classic-grants.sql`, CI only), and all 117 verify steps
run. Two verify files got fixture emails of their own, because older
ones commit their test users.

### Node 22

**Rebuild required:** the app now needs Node 22 (`engines`, the
Dockerfile and CI). `@supabase/supabase-js` 2.108 creates its Realtime
client inside `createClient` and throws on Node 20, which has no global
WebSocket ("Node.js 20 detected without native WebSocket support"), so
on Node 20 every server-side Supabase client failed. Rebuild the Docker
image, or run the app on Node 22 or later.

### SMS for HR automated messages

**Migration required:** apply `226_hr_automsg_sms.sql` (as a superuser)
after 225, before deploying this build. Then re-run
`supabase/ci/verify-hr-automsg-rcs.sql` if you keep a copy: it no longer
uses `sms` as its example of an unknown channel.
- A third channel beside WhatsApp and RCS in HR → Automated messages:
  plain SMS through a Dinstar GSM gateway. Off until the gateway is set
  up (`DINSTAR_*`); until then messages on SMS are held "SMS not
  connected" and never sent, and never moved to another channel.
- SMS templates have their own tab with a character and segment counter;
  none is created for you. Consent is recorded per channel.
- Delivery reports and STOP replies arrive at `POST /api/sms/webhook`
  (shared token). See "SMS channel" in `docs/hr-workflows.md`, including
  the open legal points (UAE TDRA rules on SMS) before going live.

### Case file reviewer

**Migration required:** apply `225_case_review.sql` (as a superuser)
after 224, before deploying this build.
- Off by default. Settings → Cases → Case file reviewer.
- When a case document passes its file checks, a reviewer's note appears
  on the case's Documents tab, listing which required documents are in,
  missing, failed or expired, and where the checklist and the files
  disagree.
- Optionally, an AI-written summary of the documents' text, with identity
  numbers removed, sent with the workspace's AI key and logged in
  Settings → Privacy. Scans cannot be read (no OCR) and are marked for a
  person.
- The note is advice only: Agree or Disagree records your view and
  changes nothing on the case. See "Case file reviewer" in
  `docs/cases.md`.

### Privacy (UAE PDPL): export, erase, legal hold, retention, AI transfer basis

**Migration required:** apply `221_privacy_export.sql`,
`222_privacy_erase.sql`, `223_privacy_retention.sql` and
`224_ai_transfer_register.sql` in order (as a superuser), after 220,
before deploying this build.
- New **Settings → Privacy** (owners and admins).
- **A customer's request:** export everything held about a customer as
  one file; place or release a legal hold; erase a customer. Erase is
  always previewed first with exact counts, and needs a typed
  confirmation. Bank cases and everything filed to them, the case's
  WhatsApp group, consent and audit records are kept (KYC/AML) and listed
  as kept, with the reason.
- **Retention:** remove or blank old deal-room and WhatsApp-group
  messages, HR automated-message texts, decided HR AI drafts and call
  records after a number of days. Swept daily; a preview until you switch
  Apply on; customers under a legal hold are skipped.
- **AI providers abroad:** record the legal basis for sending customer
  text to OpenAI, Anthropic and Jev. Every such call is logged (size
  only). Nothing changes until you switch "Require a recorded basis" on;
  then AI features stop until the basis is complete.
- See `docs/privacy.md`, including what erase cannot reach (backups, the
  NAS copies, providers).

### Case desk: case numbers and a sorting queue for staff uploads

**Migration required:** apply `220_case_desk.sql` (as a superuser)
after 219, before deploying this build.
- New screen **Case desk** (sidebar, Bank submissions; agents and up).
  Staff upload a document or a piece of information for a case and say
  what it is: a pending document or information for an existing case
  (by its case number or caption code), or a new case for a company
  (bank, company name, trade licence, product and the customer contact).
- A case the desk opens gets a human number, `TC-26-00001-RAK`, and a
  short caption code with a check character, `1RAK1`, that staff write
  on later uploads. A mistyped code is refused, never filed to the
  wrong case.
- Complete uploads file at once; anything else waits in the bank's
  **Sorting queue** with the reason. Coordinators sort the banks they
  hold (Settings → Coordinators); owners, admins and team leaders sort
  every queue, and the uploads with no bank. The same file sent twice
  to a case is marked a duplicate.
- **My uploads** shows each upload's fate (filed to which case, waiting
  and why, rejected and why) and lets the uploader fix the details of
  one still waiting. Team leaders get an **Overview** of every queue
  with an alert after 2 and 4 hours; admins set each bank's three-letter
  **Desk code**.
- See `docs/case-desk.md`.

### Staff numbers follow group access

**Migration required:** apply `219_group_staff_numbers.sql` (as a
superuser) after 218, before deploying this build.
- Making someone a manager of a WhatsApp group adds their saved
  WhatsApp number (Settings → Members) to the group; removing them as a
  manager removes it. Submission groups do the same through their
  access list.
- The other way round: when a staff member's saved number is added to a
  WhatsApp group or a submission group's WhatsApp group, from the app or
  from a phone, they become a manager (or get Coordinator access) and
  can send from the app.
- Someone with no saved number keeps sending from the app through the
  group's number, as before. If WhatsApp will not add a number, the
  screen says so and the invite link can be shared instead.

### Faster screens for team leaders and agents, and fewer errors

**Migration required:** apply `216_team_activity_perf.sql`, then
`217_conversations_perf.sql`, then `218_group_managers_number_access.sql`,
before deploying this build. Apply in order, once: re-running 206 after
216, or 191 after 217, puts the slow versions back (same results, slow
again); re-running 114 after 218 restores the old group-manager rule.
- A group's managers can now chat in and run their group even when its
  WhatsApp number is allocated to other people; allocation still decides
  who chats one-to-one from the number and who creates groups on it.
- The home dashboard's charts, the Team activity report and its
  drill-down, the team chat's WhatsApp counts and opening a chat no
  longer time out for team leaders and agents. They took 4 to 10
  seconds and often failed with an error; now they answer in well under
  a second. Who sees which chats, messages and figures is unchanged.
- Sending from a chat that has no number yet no longer tries to record
  a number the sender may not use (it was refused and logged each
  time). A chat is still never moved to another number by a send.
- Contact photos: ids WhatsApp cannot look up (groups, hidden numbers,
  too short) are skipped instead of failing on every refresh, numbers
  saved as 00971… are looked up, and a phone that is logged out is
  skipped quietly.
- OpenWA numbers: the connect window stops checking while its browser
  tab is hidden, and open tabs share one status check for a few
  seconds, so they no longer trip OpenWA's rate limit (seen as errors).
  Closing the window right after scanning can no longer log the phone
  out on an out-of-date answer.
- People in a department kept out of the sales areas (such as HR) no
  longer send a refused request for the Cases count every two minutes,
  or for the AI settings on every chat they open.
- Next.js 16.4.6 (security fixes).

### RCS for HR automated messages (prepared, not connected)

**Migration required:** apply `215_hr_automsg_rcs.sql` as a superuser or
BYPASSRLS role before deploying this build. Apply in order, once:
re-running 203 or 212 afterwards undoes part of it.
- HR → Automated messages can send each message type over WhatsApp or
  RCS (rich messages on Android phones). Pick the channel per trigger;
  RCS templates have their own tab (the provider's template id, the text
  and the approval); the history shows each message's channel; consent is
  recorded per channel in the chat's HR panel.
- No RCS provider is connected yet, so nothing is sent over RCS: a
  message set to RCS is held as "RCS not connected", never sent, and
  never moved to WhatsApp or SMS. WhatsApp works exactly as before, and
  every existing setting stays on WhatsApp.
- An opt-out stops every channel, and the daily limit of automated
  messages per person counts both channels.

### My worklist

- A new **My worklist** page (sidebar, under Dashboard) ranks what needs
  your action next: HR chats waiting on a reply (scored like Hire fast),
  cases with an overdue or due-soon SLA, missing documents or an overdue
  task, and AI reply drafts waiting for approval. Each row opens its usual
  screen. Agents and viewers see their own items; team leaders, admins and
  owners see everyone's, with an "Assigned to" filter. Rows show a short
  reference, never a name or message text.

### Case rules for entering a stage and completing the documents

**Migration required:** apply `214_case_rules_stage_automation.sql` as a
superuser or BYPASSRLS role before deploying this build, after 212 and
213. Apply in order, once: re-running 187 or 189 afterwards undoes part
of it.
- Case automation rules have two new triggers. **A case enters a stage**
  (the rule names the stage) can create a task from the bank's task
  templates for the case's agent or coordinator, or start an SLA timer.
  **The last required document arrives** moves the case one stage
  forward.
- A stage rule runs once per case and stage: leaving and re-entering the
  stage adds no second task. Moving forward never skips a stage, never
  moves into Approved, Declined, Withdrawn or Closed, never moves a closed
  case or one not yet submitted past the pre-submission stages, and
  happens at most once per change. Rules still never message anyone, and
  none exists until an admin saves one.

### HR automated messages stop retrying sends that cannot work

**Migration required:** apply `212_hr_automsg_delivery.sql` as a
superuser or BYPASSRLS role before deploying this build. Apply in order,
once: re-running 203 afterwards undoes part of it.
- A send that can never succeed (an invalid number, a template missing,
  paused or not approved, Meta's 24-hour window closed, a number that is
  not connected to the account) is marked failed at once with the reason,
  instead of being retried three times. Passing problems are still
  retried.
- WhatsApp's delivered, read and failed receipts are recorded on each
  automated message. A message WhatsApp could not deliver is marked
  failed with WhatsApp's error code.

### HR lines

**Migration required:** apply `213_hr_lines.sql` as a superuser or
BYPASSRLS role before deploying this build, after 212.
- HR → Rules has a new **HR lines** section for owners and admins: tick
  the WhatsApp numbers HR uses and switch on "Open a Recruitment chat when
  someone new writes to an HR line". Someone with no HR chat, who has
  never written to your other numbers, then starts in Recruitment at CV
  review when they write to one of those numbers (and the CV-received
  automated message, if switched on, follows its usual guards). An
  existing customer who writes to the HR number stays where they are.
  Off by default.

### Add people to groups

**Migration required:** apply `211_submission_group_add_number.sql`
as a superuser or BYPASSRLS role before deploying this build.
- Submission groups have an **Add number** button in their details:
  anyone who can open the group can add another phone number to its
  WhatsApp group (at most 10 tries a day per group). If WhatsApp won't add
  the person, the group's invite link is shown to share with them.
- In WhatsApp groups, anyone at agent level or above who can open a
  group can now add people, not only its managers. Removing people,
  admins, settings and invites stay with managers.
- A shared contact card in a chat now shows its number (WhatsApp's
  `item1.TEL` lines were being dropped) and opens the customer, or
  offers Save then opens it. Group chats show shared contacts as cards.

### Attachments, voice notes and quick replies in group chats

- WhatsApp group chats can send photos, videos, documents and voice
  notes, and use quick replies, from the same kind of message box as the
  inbox.

### Attachments and voice notes in Submission group chats

**Migration required:** apply `210_submission_group_media_sends.sql`
as a superuser or BYPASSRLS role before deploying this build.
- Staff can send photos, videos, documents and voice notes into a
  Submission group's WhatsApp chat, with the usual `Name (Label)` prefix
  as the caption, and use quick replies there too.

### Groups pages no longer scroll away

- Scrolling the list on WhatsApp groups or Submission groups moved the
  whole page up, top bar included, once the list was long. Only the
  list scrolls now.

### Customers' zip files and other archives can be opened

**Migration required:** apply `209_chat_media_archives.sql` before
deploying this build. Apply in order: re-applying 023 or 039 afterwards
narrows the list again, so re-apply 209 after either.
- WhatsApp attachments in zip, rar, 7z or gz format, CSV, RTF, JSON,
  HEIC and OpenDocument files are now stored, so they open and download.
  Before, a customer's zip was refused by storage and the message showed
  the file name with nothing behind it.
- Any other unusual type is stored as a plain download instead of being
  lost. Nothing a browser would run as a page is ever stored as one.
- `scripts/remirror-openwa-media.ts <message id>… [--apply]` fetches a
  lost OpenWA attachment again from the gateway.

### Compass updates go from the Meta number

No migration.
- Compass status notifications are now sent on the Meta Cloud API number,
  never on a Whapi or OpenWA number. With no Meta number connected they
  fail with `meta_not_connected`; nothing falls back.
- If the customer wrote to the Meta number in the last 24 hours the update
  goes as a normal message. Otherwise it goes as the Meta-approved template
  worded like it: `compass_case_submitted` or `compass_case_approved`,
  with the company and bank read out of Compass's text. A message neither
  template matches word for word is not sent then
  (`no_template_for_message`), nor is a template Meta has not approved yet
  (`meta_template_unusable`). Images and documents go only inside the 24
  hours (`outside_service_window`).
- **Taamul Compass → WhatsApp templates** shows both templates and Meta's
  review of each.
- Updates into a customer's submission group are unchanged.

### Groups on company OpenWA numbers

**Migration required:** apply `208_groups_on_openwa.sql` (as a superuser
or BYPASSRLS role, like 114) before deploying this build. Apply in order,
once: re-applying 114 afterwards puts back the Whapi-only rule, so re-apply
208 after it.
- The Groups screen works on company OpenWA numbers as well as Whapi:
  chat, add and remove people, admins, settings, invite links, join
  requests, Sync. Personal numbers and the Meta number are not offered.
- Creating a group on an OpenWA number needs the gateway's Baileys
  engine; on whatsapp-web.js the app says to create it on a Whapi number.
- Attachments received in an OpenWA group show as caption and type only.

### Groups: owners and admins can add people who opted out

- Under the left-out list (after creating a group, and in Add members) an
  owner or admin gets **Add anyway**, which adds people who opted out or
  are do-not-contact. Everyone else is still refused.

### Inbox: reminder to use the marketing number for new chats

**Migration required:** apply `207_new_chat_notice.sql` before deploying
this build (without it the reminder shows its default wording and the
settings can't be saved).
- Whenever the next message would open a new chat in a company chat, a
  reminder stays above the composer: open chats with new clients who are
  just being sent details from the marketing number. It also shows in the
  New chat dialog. It can't be dismissed; it goes away once the chat sends
  from the marketing number.
- Admins pick the marketing number and may reword the reminder in Team
  activity → Limits → New chat reminder (on by default). With a number
  picked, the reminder names it and offers **Switch to marketing number**
  to anyone allowed to send from it (the chat's per-chat sending number).
- Personal-number chats never show it. Settings live in their own table
  (`team_activity_new_chat_notice`), not in the Team activity limits row.

### Team activity: hard restrictions, unlock requests and My activity

**Migration required:** apply `204_team_activity_enforcement.sql`,
`205_team_activity_unlocks.sql` and `206_team_activity_self_view.sql`, in
that order, **before** deploying this build. The new build calls the
three-argument `team_activity_start_check`; before 204 every human send
would be allowed.
- The limits are now enforced, on by default (admins can switch any rule
  or the whole thing off). Everyone except the owner is bound, on company
  Whapi and OpenWA numbers only; personal numbers and Meta are never
  restricted.
- A new chat is refused when it breaks a rule: too many unanswered
  messages in a row, quiet hours, the person's or the number's daily
  limit (cut down for someone with a low reply rate), a burst, a link in
  the first message, the same opening text too often, or Jev judging it a
  cold pitch. The send answers `429` with code `restricted` (replacing
  `new_chat_limit`); the composer explains why and keeps the text.
- A blocked person can ask to unlock with a reason. A team leader, admin
  or owner approves or denies it from the bell or the new **Unlock
  requests** tab; an approval covers the next send in that chat within 2
  hours.
- Broadcasts, the public API, flows and automations stop at a number's
  daily limit (API: `429` `number_daily_limit`). A stopped broadcast
  stays "sending" until someone presses Resume after the day turns. The
  AI auto-reply, Compass notifications, HR automated messages and the
  journey bot are not checked.
- Agents get a **My activity** page; team leaders and admins get a
  **Blocked sends** tab. Settings → limits has a Restrictions section.
- Every check lets the message through if it fails unexpectedly. Blocks
  are kept 90 days.

### Light mode: neutral, professional colours

No migration. Light mode drops the blue tint it put on every surface
(the page, cards, grey text, borders and fields) for neutral greys: a
light grey page, near-white cards, ink text and hairline borders, so
the brand blue is the one colour that stands out (buttons, links, the
selected item). The sidebar keeps the deep brand navy, and its selected
item and counters now use the same blue as in dark mode. The inbox's
chat wallpaper is a neutral grey instead of WhatsApp's beige, which
clashed with the panels around it; the green and white bubbles are
unchanged. Dark mode is unchanged.

### HR: its own sidebar group, screens laid out like the HR package

No migration. The HR screens move out of the single "HR inbox" page into
a sidebar group **HR**, as the HR package designs them:

- **Recruiter HR** (`/hr/recruiter`), **HR department**
  (`/hr/department`) and **Not sorted** (`/hr/unsorted`, HR chats nobody
  has tracked as a candidate or an employee yet), each with its open
  count; then **Tasks** (`/hr/tasks`), **Rules** (`/hr/rules`, formerly
  Setup), **Hire fast** and **Automated messages**.
- The list column has the package's header (title, search, quick
  filters All / Unread / Mine / Urgent with counts, stage or topic and
  reply-state dropdowns, removable filter chips, Closed) and two-line
  rows (stage bars or topic, reply state, Urgent, Unread, owner).
- The chat's right pane is the package's **Conversation** pane: stage
  buttons, topic, flags, an **Owner** select (admins and leads hand the
  chat to someone on that inbox's HR team they may assign to; a member
  claims or releases), reply state, Close with Hired / Not selected /
  Withdrawn (confirmed), Reopen; then HR tasks, **Agent drafts**
  (Approve / reason / Reject in place) and consent.
- Automated messages and Hire fast are laid out like the package.
- Old `/hr-inbox` links keep working: they open the same chat in its
  new screen.

### HR: more topics, AI reply drafts, Hire fast and automated messages

**Migration required: `201_hr_topics.sql`, `202_hr_agents.sql`,
`203_hr_automsg.sql`** (apply in order, before the build; 203 refuses
to apply except as a superuser or BYPASSRLS role). Everything new is
off until an admin switches it on.

- **Eleven HR department topics.** Offer letter, Training, Warning
  letter, Message and Termination join the six. The HR department list
  gets quick chips (All, Letters, Training, Leave, Messages, Exits), the
  topic picker is grouped (Staff admin, Conduct, Other), and a
  department chat's panel is headed "Staff conversation".
- **AI reply drafts for candidates.** In a Recruitment chat the HR panel
  can suggest a reply, written with the workspace's own AI key
  (Settings → AI): on each new candidate message, or on "Draft a reply".
  A person approves or rejects every draft and sends it from the chat
  themselves; nothing is ever sent automatically. Salary, offer, visa
  and contract questions go to a person, an upset candidate is marked
  Urgent, and a candidate who writes STOP is opted out. Admins and
  recruiter leads switch it on in HR inbox → Setup. Works on personal
  chats too.
- **Hire fast.** HR inbox → Hire fast ranks the open candidates by who
  needs action next (reply due, urgent, upset, how long they waited,
  stage, an overdue task, gone quiet). Read only.
- **Automated messages to candidates.** HR inbox → Automated messages
  sends fixed, admin-approved templates from each chat's own WhatsApp
  number when a chat is tracked as a candidate, moves to an interview
  stage, or the candidate stops answering. The master switch starts ON
  (blocking everything) and every trigger OFF. Quiet hours (21:00–08:00
  Dubai), at most 3 per candidate a day, consent required by default
  (recorded in the chat's HR panel), opt-outs honoured, Utility
  templates only and promotional wording refused; on a Meta number the
  template must also exist, approved, in Templates. Never from a
  personal number. A history lists every message sent, held or
  cancelled. Check with legal (UAE PDPL) before switching it on.

See `docs/hr-workflows.md`.

### HR workflows: Recruitment and HR department

**Migration required: `200_hr_workflows.sql`** (apply before the build).
The HR inbox now sorts HR chats in two: **Recruitment** (candidates,
moved through CV review → AI interview → HR interview → Manager
interview, closed as Hired / Not selected / Withdrawn) and **HR
department** (employees, tagged Onboarding, Visa & documents, Leave &
attendance, Payroll, Complaint or Other). Each chat shows a reply state
(New / Reply due / Waiting on them) and Urgent / Upset flags, tracked
from an HR panel in the chat. Eleven workflow rules create tasks (never
messages): "Review CV" when a candidate arrives, "Respond to complaint"
in 4 hours and Urgent for a complaint, "Reply to customer" after 4
hours without a reply, and more. Owners and admins pick the HR team
(Lead / Member per inbox) in HR inbox → Setup; HR team members can then
open the HR inbox, but see no chats they could not see before. See
`docs/hr-workflows.md`.

### A logged-out number no longer holds up other people's chat import

**No migration.** The one-time chat history import for personal numbers
runs one person at a time, oldest first. A person whose phone was logged
out kept the front of the line, so everyone who linked after them stayed
at "Preparing to import your chats…" until that phone came back. A
paused import now steps aside for 5 minutes at a time.

### Scan again for a logged-out OpenWA number

**No migration.** When an OpenWA phone is logged out, Settings → Numbers
now says so and offers **Scan again**, which shows the number's QR so
the phone can be linked again without disconnecting it; its chats and
access list stay. Settings → My WhatsApp offers the same, and its badge
now shows the live state: it said "Not connected" even for a linked
number.

### Phone extensions get their own settings page

**No migration.** Settings → Phone extensions replaces the extensions
table in Settings → Phone system, which now shows a count and a link.
The page reads the PBX's names for each extension, suggests links where
a name matches one person, searches by number, name or person, filters
linked and unlinked, and has a By person view listing who has no
extension. Picking someone who already holds an extension moves them.

### Deactivating a member takes them off their team and phone extension

**Migration required:** `199_deactivation_cleanup.sql`.

- Deactivating someone in Settings → Members now also removes them from
  their team (as a member, or as its leader: the team stays, without a
  leader) and unlinks their Yeastar extension, so its calls, status and
  missed-call tasks no longer go to them. Their past calls keep their
  name. Reactivating restores neither; add them to a team and map an
  extension again.
- Applying the migration does the same once for everyone already
  deactivated.
- Numbers allocated to the person directly are left as they are.

### Quieter WhatsApp push notifications

- Messages to a staff member's personal number no longer push from the
  CRM: their phone already rings for them.
- A backlog of messages delivered when a number reconnects no longer
  rings once per message (anything over 5 minutes old is not pushed).
- A busy chat buzzes at most once a minute; its notification still
  updates with the latest message.

### HR team leaders see their team's chats

No migration.

**Changed**

- A team leader in a restricted department (HR by default) can open the
  **Team inbox** again. It shows only what a team leader always sees:
  their own and their team members' chats.
- Below admin, chats of your own department (for example HR) stay in
  your Inbox and Team inbox instead of only in the admin-only HR inbox,
  so an HR team leader sees her HR team's chats and unread counts.
  Owners and admins still read them in the HR inbox.

### Call reviewers

**Migration required:** apply `supabase/migrations/198_call_reviewers.sql`
after 192 and BEFORE deploying this build.

**Added**

- An owner or admin can let any staff member below admin review every
  call (**Settings → Members**, _Allow reviewing all calls_; off by
  default). A reviewer sees every call on the Calls screen, every
  person's recordings on **Team recordings** (play and download), and
  the **Call report** for everyone with customer names, as an admin
  does. Nothing else changes for them: no call access log, no unrouted
  calls, and chats and contacts stay as their role allows. Plays and
  downloads are logged as before. See `docs/yeastar.md`.

### Submission groups show their bank

**Added**

- Every row of **Submission groups** is tagged with the bank of its
  case, and an opened group shows the bank beside its name. The tag is
  the bank's name in the workspace's bank list (Settings → Cases), else
  its code. A group whose case has no bank yet shows none. No migration.
- Bank tags are filled with each bank's brand colour (Emirates NBD navy,
  ADCB red, Mashreq orange, …). NBF and Ruya, whose brand colours could
  not be confirmed, and any bank outside the built-in list get a fixed
  colour of their own.
- A **bank filter** beside the Submission groups search lists only one
  bank's groups, on the Active and Ended tabs alike.

### Reminders: suggestions in chats and a ringing alarm

**Migration required:** apply `supabase/migrations/197_reminder_suggestions.sql`
as a superuser or BYPASSRLS role BEFORE deploying this build. The Smart
insights settings read selects the new column, so on an older database
every insight feature would read as off.

**Added**

- Reminder suggestions (off by default; **Settings → Smart insights →
  Reminder suggestions in chats**). When a chat message names a later
  time, an **Add reminder · Tomorrow 15:00** chip appears under it. It
  opens the **Remind me** dialog prefilled; saving files the usual
  follow-up task. See `docs/jev-insights.md`.
- The reminder alarm: task, meeting and event reminders show a ringing
  card at the top right of every dashboard page, with a chime. Tasks can
  be snoozed (10 minutes, 1 hour, tomorrow 9:00) or marked done. Unread
  reminders from the last 2 hours show as "Missed" when you open the CRM.

**Changed**

- Task reminders now ring when they fall due as well as 15 minutes
  before. Moving the due time rings again at the new time.
- Reminder pushes (tasks, meetings, events) stay on screen until
  dismissed and vibrate. The due-now push replaces the 15-minute one on
  the device.
- **Remind me** accepts a time 2 minutes ahead (was 15 minutes).

### Second brain (off by default)

**Migration required:** apply `supabase/migrations/194_second_brain.sql`,
`195_brain_pages.sql` and `196_brain_digest.sql`, in that order, before
deploying this build.

- A searchable store of case notes, case replies, customer text in case
  groups, stage changes and bank workspace pins and posts, redacted
  before it is stored. Off until an owner or admin turns it on in
  **Settings → Cases → Second brain**; nothing is stored while it is off.
- **Second brain** page: search what you are allowed to see on the case
  screens, and **Remember this** to store a short note.
- **Daily digest** page: your stale cases, promises made to customers that
  nobody followed up, related closed cases and today's case tasks. A list
  only; nothing is sent. Owners and admins can view a teammate's.
- **Brain** tab on every case: an AI-generated summary with its sources,
  rebuilt when an owner or admin presses Rebuild summaries.
- Opted-out and do-not-contact customers are never stored; deleting a
  contact erases what was stored about them. See `docs/second-brain.md`.

### HR can start WhatsApp chats again

- People in a restricted department (HR by default) get their own
  **Contacts** page back. It lists only the contacts they own or chat
  with, as for any agent, and is where they add a number and message it.
  Team contacts (everyone's contacts) stays closed to them.
- Every inbox (Inbox, Team inbox, HR inbox) has a **New chat** button
  beside the search box, for agents and up: type a number (and
  optionally a name) and it opens your chat with it, or lets you send the
  first message (from a company number, your own WhatsApp, or an approved
  template). A number held by a colleague's contact you can't see is
  refused, as on the Contacts page.

### Smarter contact and chat search

**Migration required:** apply `supabase/migrations/193_fuzzy_contact_search.sql`
before deploying this build (it adds the `search_contacts` function and
search indexes; without it the app falls back to the old search).

- Numbers are found whatever the spacing or prefix: `588336503`,
  `0588336503` and `+971 58 833 6503` all find a contact stored as
  `+971 58 833 6503`. Partial and short numbers (`971`, `050`) work too,
  and the Contacts search still matches email addresses.
- The Contacts page, the contact picker and the WhatsApp, Team and HR
  inboxes now list exact matches first, then close matches (a typo in a
  name or company, swapped words, a wrong or swapped digit), marked
  "Similar" under a "Close matches" divider.
- The inbox search now asks the server, so it finds chats that are not
  loaded on screen yet. It still only returns chats you may see.

### Departments

**Migration required:** apply `supabase/migrations/192_departments.sql`
before deploying this build.

- Each member now belongs to a department (Sales, HR, IT or Accounts),
  set by an owner or admin in Settings -> Members. Sales is the default.
- Settings -> Departments has two switches per department: **Own inbox**
  (chats owned by or assigned to its people go to a separate inbox that
  only owners and admins see) and **Restricted from sales areas**. HR has
  both on until changed. Owners and admins are never restricted.
- See `docs/departments.md`.

### Separate personal chats, chat history import, phone messages

**Migration required:** apply `supabase/migrations/191_personal_chats.sql`
before deploying this build. It refuses if any company chat already sits
on a personal number.

- A person's own WhatsApp now has its own chats per contact, separate
  from the company chat with the same contact. Visible to the owner,
  their team leader and admins; bots and the public API never see them.
- Contact page: "Message from my WhatsApp" (for a connected personal
  number) starts or continues that personal chat, and the personal chats
  you may see are linked as "Personal chat · name".
- On first link, one-to-one chats are imported once (text only, as far
  back as the phone allows), and messages typed on the phone appear in
  the chat. See `docs/openwa.md`.

### Personal WhatsApp numbers

**Migration required:** apply `supabase/migrations/190_personal_whatsapp_numbers.sql`
before deploying this build (the app selects the new columns).

- Settings → Members: an admin can allow a member to connect their own
  WhatsApp through OpenWA ("Allow own WhatsApp"). The row shows an "Own
  WhatsApp" badge with the number once connected; withdrawing the
  permission is refused until the number is disconnected. See
  `docs/openwa.md`.

### Follow-ups

**Migration required:** apply `189_followups.sql` (as a superuser or
BYPASSRLS role, like 187 and 188).

- Meta spend per won case: the spend that went to anyone else now reads
  "No rate on file" when a message's rate is unknown, instead of
  counting it as $0.
- Case automation rules: an amount condition above 9,999,999,999,999,999.99
  or a minimum above the maximum is refused, and a malformed `days` or
  amount is refused cleanly rather than failing the cast.

### Meta number health and spend (watch-only)

- **Migration required:** apply `188_meta_number_health.sql` as a
  superuser or BYPASSRLS role. `supabase/ci/verify-meta-number-health.sql`
  is wired into the migrations workflow.
- The database records what Meta reports about the Cloud API number and
  its templates (quality, messaging tier, account status, template
  quality and status), keeps the number's current health with an assessed
  sending state, counts marketing templates sent per number per day, and
  works out Meta spend per Approved case from the message-cost ledger.
- The Meta webhook records these events (subscribe the app to
  `account_update` and `phone_number_quality_update` as well; see
  `docs/meta-cloud-api.md`). The webhook's answers do not change.
- Settings → WhatsApp shows owners and admins a read-only Meta number
  health card: state and reasons, templates, marketing sent today (UTC)
  and spend per won case over 30 days.
- A new bell, **Meta number alert**, rings owners and admins when the
  number's assessed state gets worse.
- **Nothing changes for sending.** This only records and assesses. A new
  owner-only "enforce" setting is off by default, and nothing reads it
  yet.

### Cases: case files, saved views and snooze, macros, automation rules

- **Migration required:** apply, in this order and each as a superuser or
  BYPASSRLS role: `179_case_system_notes.sql`,
  `180_customer_documents_internal.sql`, `181_case_files.sql`,
  `182_case_file_builds.sql`, `183_case_intake_prompts.sql`,
  `184_case_files_compass.sql`, `185_case_views_snooze_mentions.sql`,
  `186_case_macros.sql`, `187_case_rules.sql`. Each has a
  `supabase/ci/verify-*.sql` file wired into the migrations workflow.
- **Case files.** Owners and admins set, per bank and product, which
  documents a file needs (type, size, minimum valid days, file name, merged
  or index-only). A customer's WhatsApp document or a staff upload is
  attached to a required document, versioned and checked automatically; a
  case is File ready when every required document has passed. Coordinators
  can assemble the case file into one PDF; every download is audited and
  the link lasts 10 minutes. Staff uploads and assembled files also reach
  the customer's NAS folder. Three Settings -> Cases switches (mark the
  checklist received, move the case when File ready, intake prompts) are
  off by default and never act on a case Compass manages.
- **Automatic notes.** A case note can come from the system and shows as
  "Automatic".
- **Saved views, snooze, mentions.** Save inbox filters as private views
  (owners and admins can share them), snooze a case out of the inbox for up
  to 30 days (the SLA keeps running), filter by "mentions me" and open a
  Mentions list. Automatic notes no longer count as a case's last touch.
- **Macros.** Save a list of case actions (add a task, add a note, move the
  stage, preview the missing-documents request) and apply it from the case
  page in one click. It uses the applier's own permissions and every run is
  logged.
- **Automation rules.** Owners and admins define rules that fire when a case
  opens, changes stage, goes SLA overdue, sits idle for N days or gets its
  submission, and assign an agent or coordinator, add a note or set the
  priority. Rules never send messages and never change a Compass-managed
  case. See `docs/cases.md`.

### Case document intake prompts: database half, off by default

- **Migration required:** apply `supabase/migrations/183_case_intake_prompts.sql`
  (after 181) as a superuser or BYPASSRLS role.
- Stores the wording of the WhatsApp "which document did you just send?"
  messages and the prompts a sender has sent. Nothing sends yet. A prompt
  can be recorded only while Settings' `files_intake_prompts` switch is on
  **and** an owner has approved the `document_classify` wording; an edit
  to the wording withdraws its approval, and nobody approves their own edit.

### Public API: Compass can read a case's assembled case file

- **Migration required:** `supabase/migrations/184_case_files_compass.sql`
  (and 181–182 before it).
- `GET /api/v1/submission-groups/{submission_id}/case-file` answers the
  case's document checklist and current build;
  `GET …/case-file/download` answers a 600-second signed link to the
  build, recorded against the API key. Both need
  `submission_groups:read` and are read-only. A new webhook event,
  `case.file_ready`, fires when every required document has passed.
  Nothing changes for Compass until it calls them (`docs/public-api.md`,
  `docs/compass.md`).

### Customer documents: every file a customer sends is filed under their reference

- **Migration required:** apply `supabase/migrations/178_customer_documents.sql`
  as a superuser or BYPASSRLS role (it refuses to run as anyone else).
- **One-time worker install** (the copier is its own service, not part of
  the app): copy `scripts/systemd/wacrm-customer-docs.service` to
  `/etc/systemd/system/`, adjust its paths, then `systemctl daemon-reload`
  and `systemctl enable --now wacrm-customer-docs`. Details and settings
  are in `docs/customer-documents.md`. Without it, files queue and none
  reach the NAS.
- Every document and photo a customer sends in a 1:1 WhatsApp chat (any
  number: Whapi, Meta or OpenWA) or in their case's WhatsApp group is
  given to that customer's own
  reference number, such as `TC-000123`, and copied into a folder of that
  name on the company NAS. Stickers, voice notes, audio and video are not
  filed, and nothing that arrived before the migration is.
- The customer page has a new **Documents** card (reference with copy
  button, NAS folder path, each file's status, an Open link, and **Try
  again** for owners and admins on a file that failed), and the inbox
  contact panel a **Documents** row. Whoever can see a customer sees
  their documents.
- Nothing is sent to the customer and no flow, automation or reply
  changes. If the NAS is down, files wait and are copied when it returns.

### Team recordings show the customer's number

- The Team recordings page (`/calls/recordings`) now shows each call's
  full phone number, after the customer's name when the number belongs
  to a contact. It used to show a contact's name only, and a masked
  number (`+971 •••• 4567`) otherwise.

### Contacts list no longer fails to load for agents and team leaders

- **Migration required:** apply `supabase/migrations/177_contacts_select_set_based.sql`.
- The Contacts screen often said "Failed to load contacts" for anyone
  below admin, more often the bigger the workspace's contact list: the
  database checked who may see each contact one at a time and ran out of
  time. It now works that out once per request. Who sees which contact
  has not changed.

### Video meetings: invites pop up and ring

- When you're invited to a meeting that's happening now, a pop-up with a
  ringtone appears on whatever CRM page you have open, with **Join** and
  **Not now**. **Join** takes you to the meeting's lobby. It rings for up
  to a minute, and if you miss it the invite stays in the bell. An invite
  to a meeting later on only goes to the bell, as before.
- The pop-up needs the CRM open in a browser tab, and browsers only play
  the sound in a tab you've clicked in since it loaded. It stays silent
  while you're already in a meeting or on a call.

### A colour for each sender in group chats

- In WhatsApp groups and submission groups, a case's Conversation tab
  included, every staff member and every phone number now has a colour of
  their own, on the name and on a stripe down the bubble's outer edge, so
  you can follow who is talking without reading each name. Nobody on
  screen shares a colour until a chat has more than ten senders, the same
  people keep the same colours, and a person usually has one colour from
  chat to chat. Automatic messages stay grey. This replaces the
  coordinator's blue edge; the Coordinator label beside the name stays.
- On an open case, the Conversation tab now shows the sender's phone
  number on customer and coordinator messages. It used to say "Someone".
- Opening an ended submission group's archive no longer crashes the page.

### Video meetings: a proper meeting room

- The room is now a page, and the call lives in the dashboard, so it
  carries on while you move between pages. On any other page a floating
  window shows it: drag it, resize it, minimise it to a pill, double-click
  to return. It highlights whoever is speaking. Reloading or closing the
  tab still leaves the call; the browser asks first, and a Rejoin card
  offers the way back for two hours. Only one meeting at a time per tab.
- Pop out (Chrome and Edge) puts the call in an always-on-top window that
  follows you to other tabs and apps. Other browsers keep the plain video
  picture-in-picture.
- Speaker detection works for remote people. Before, nobody but you ever
  showed as speaking.
- New room: dark in both themes, with Gallery, Speaker and Focus layouts,
  Hide self view, keyboard shortcuts (`?` lists them; hold Space to talk),
  and a side panel with People, Chat and Notes.
- Host tools: Mute everyone, Lower all hands, Lock meeting, and Invite
  people (organiser only). Raised hands are a numbered queue. A locked
  meeting lets in only managers and people who dropped out within 5
  minutes, and someone waiting in the lobby gets in when it unlocks, with
  no reload.
- Background effects: blur, colour backdrops or your own image, in the
  lobby and in the room. If an effect cannot run, the camera turns off
  rather than send the raw picture. An uploaded image stays in that
  browser.
- Recording: a host records to their own computer. Nothing is uploaded.
  Everyone gets a notice and a REC chip, and the lobby warns before
  joining. The file is WebM; a crash, or closing the tab while recording,
  can lose it, so stop recording first. If a recorder's browser crashes,
  another host can record 90 seconds later.
- Shared notes per meeting that two people can edit without losing text.
  Hosts can finish them after the meeting.
- Meetings page: Start now in one click, Happening now, Coming up, a Next
  up countdown, a Past tab, and join by link. After a meeting: duration,
  an attendance report with CSV, notes, chat and who did not join.
- Instant meetings close themselves after 10 minutes with nobody in them.
- Operators: new routes `POST /api/meetings/[id]/lock`, `/recording`,
  `/invite`, `GET .../attendance`, `GET`/`PUT .../notes`; `moderate` takes
  `mute_all` and `lower_all_hands`; `join` answers 423 `meeting_locked`.
  The build now copies MediaPipe's wasm to `public/meeting-effects/wasm`
  (`prebuild`/`predev`). Details in `docs/meetings.md`.
- **Migration required:**
  `supabase/migrations/176_meeting_host_tools.sql` (superuser or BYPASSRLS
  role). Without it the room works; lock, recording and notes are
  unavailable and say so.

### Play a call recording at 2x

Call recordings have a 1x / 2x button next to the time, on Team
recordings, the Calls list and the customer page. The speed holds for
the whole recording, including after a pause.

### Only owners and admins add people

- Adding people to a workspace, by login, by email or by invite link, is
  now for owners and admins only. Team leaders lose what migration 099
  gave them: they can no longer invite agents and viewers, add anyone by
  email, or revoke links. Settings → Members is gone for a team leader,
  and the invite links a team leader already sent stop working. Agents,
  viewers and bank guests could not add people before, and role changes,
  deactivation and removal were already admin-only. Team chat and deal
  rooms still add people who are already in the workspace.
- **Migration required:** `supabase/migrations/175_admin_only_invites.sql`.

### Submission group invites on every retry

- When WhatsApp refuses to add a customer, they now get the group's invite
  link however the group was created. A group created by the automatic
  retry or an admin's retry used to invite nobody and record nothing. No
  migration.
- A group's details now have a Resend invite button for owners, admins and
  anyone on the group. A customer who opted out or is marked do-not-contact
  gets nothing, and a resend within 10 minutes of the last invite is
  refused, because repeated sends risk the number being flagged.

### Added

- **Submission groups show when the customer isn't in the group.** The
  Submission groups and Groups lists mark a live group "Customer not in
  group", and the group's details card has a Customer row. We learn this
  when the group is created, when WhatsApp reports someone added or
  removed, when the customer writes, and from a check every six hours.
  A hidden number never counts as "not in the group".
  **Migration required:**
  `supabase/migrations/174_submission_group_customer_membership.sql`.
  Apply it before restarting on this version: the group screens read its
  new columns and fail without them.

### No WhatsApp group for a case an admin filed

- A submission whose agent is an owner or admin now opens in the CRM with
  no WhatsApp group, as one a coordinator filed does. Groups are for
  regular staff. Groups already open are unchanged. No migration.

### Submission groups on the WhatsApp Groups page

- Active submission groups now show on the Groups page like any other
  group, with a small "Case" label and their unread count, and open
  beside the list. Only people who can already read a group see it.
- Ended submission groups, and cases with no WhatsApp group, stay on
  the Submission groups page. These rows cannot be deleted.
- Copies of submission groups left by older Syncs no longer show in the
  list.

### Delete any WhatsApp group from the Groups page

- Owners and admins can now delete any group, not only ones the number
  has left. If the number is still in the group it leaves on WhatsApp
  first, and members see that; if the leave fails, nothing is deleted.
  A deleted group is gone for good: Sync and webhooks do not bring it
  back, even if someone adds the number again.
- Submission groups cannot be deleted or left here, and Sync no longer copies
  them onto the Groups page.
- **Migration required:** apply `173` (`whatsapp_group_tombstones`)
  before this build; until then group saves and Sync fail.

### Unread counts and a bell for submission groups

- The sidebar and the group list show how many messages you have not read
  in each submission group. A customer's message rings the bell and sends
  a push to the case's agent and coordinators, once per group until they
  open it, and opening the group clears your count and your bell (a group
  open in a hidden tab waits until you look at it again). The team
  leader of a case's agent can now read and send in its active group
  without being named on it. Reassigning a case now moves group access
  to the new agent or coordinator. **Migration required:** apply
  `supabase/migrations/173_submission_group_reads.sql` as a superuser or
  BYPASSRLS role before restarting.

### Staff with no WhatsApp number still get their case

- A submission from a staff member with no WhatsApp number they may use
  was refused with `422 channel_not_allowed`, so the case never reached
  the CRM and Compass retried it every hour. It now opens with no
  WhatsApp group and nothing sent to the customer, and the server log
  names the agent so an admin can allocate a number. No migration.

### No WhatsApp group for a case a coordinator filed

- A submission gets a WhatsApp group only when a regular staff member of
  this app filed it. A case filed by a coordinator now opens in the CRM
  with no group; these used to be refused with `422 duplicate_user`
  when Compass named the same person as agent and coordinator, so they
  never appeared at all. A case filed by someone with no login here
  stays refused. Groups already open are unchanged. No migration.

### Invite links reach customers WhatsApp would not add

- When WhatsApp refuses to add someone to a group, they are sent the
  group's invite link. That send failed for any group with no picture,
  which is every new submission group, leaving the customer with neither
  the group nor the link. The link now goes as plain text in that case.

### A direct message is with one person

- Team chat's _New message_ picker now takes one person. A conversation
  among several people is a private channel. Group messages already open
  keep working, and the _Start group messages_ row is gone from Settings
  → Team chat → Role permissions, because nothing starts one any more.

### Added

- **Delete a team chat channel permanently.** An owner or
  admin can delete any team or private channel showing in their app; a team
  leader or coordinator the ones they created. Agents, viewers and bank
  guests cannot, and DMs and deal rooms are never deleted this way. The
  channel name must be typed to confirm. Messages, files, reactions, pins
  and notifications go with it; the audit log keeps one row with the name
  and counts, and its earlier rows. **Migration required: 172**
  (`supabase/migrations/172_chat_delete_channel.sql`, as a superuser or
  BYPASSRLS role).

### Team chat quick reactions suit a workplace

- The one-tap reactions on a team chat message are now 👍 ✅ 👀 ⏳ 🙏 👏.
  ❤️ and 😂 are gone from the quick row; the full emoji picker is
  unchanged, and reactions already on messages stay.

### Team chat no longer shows colleagues as "Unknown"

- Team chat read its list of names once per page load and, if that read
  failed, waited a full minute to try again, so every name on the screen
  showed "Unknown" in the meantime. A failed read is now retried within a
  second, the last good list stays in memory, and a name stays blank
  rather than "Unknown" while the list is still loading. No migration.

### Unassigned chats go to whoever called the customer

- **Migration required: 171** (`171_calls_outbound_number_index.sql`, an
  index only; the feature works without it, more slowly).
- An inbound WhatsApp message on a chat no person has touched now looks
  for the sender's number in the workspace's whole call history. If
  someone called that number from an extension, the chat is assigned to
  the most recent caller who is still active staff, whether or not the
  call was answered, instead of staying with the admin who connected the
  number. They get the usual assignment bell, and the contact moves to
  them. A chat a person has replied in or released is left alone, and so
  is a contact another agent owns. Because the chat now has a person, the
  AI bot leaves it alone, as on any assigned chat. Flows and journeys
  still run.
- An automation's _round robin_ assign step now only takes a chat with no
  assignee. An assign step that names a person still reassigns. See
  `docs/yeastar.md`.

### Mapping an extension claims its earlier calls

- Calls made on an extension before an admin mapped it to a person were
  stored with no person, so that person's Call report talk time came out
  below the PBX's (for example 1h 07m against 01:12:55). Mapping an
  extension (Settings → Phone system → Extensions) now gives the person
  every earlier call on it that has no person; calls that already
  belong to someone stay theirs. No migration.

### Tracker updates go into the submission group

- **Migration required: 170** (`170_submission_group_system_messages.sql`
  adds `compass_notifications.submission_group_id` and `group_message_id`).
- A Compass status update (`POST /api/v1/compass/notifications`, type
  `text`) for a customer whose submission has a live WhatsApp group is
  posted only into that group (matched by `reference` = submission id,
  else the customer's newest live group), during the 2-day hold after a
  final status too. Otherwise it is sent 1:1 as before; images and
  documents are always 1:1. Notifications now carry `delivered_to` and
  `submission_group_id`; new errors `customer_opted_out` (422) and
  `group_send_failed` (502) and `group_lookup_failed` (503). See `docs/compass.md` §5.

### Assigning a chat moves its contact too

- **Migration required:** apply `169_contact_follows_assignment.sql`.
- When a chat is assigned or reassigned to someone (from the chat
  header, Take over, an automation, a flow or the API), its contact
  now becomes theirs as well, so it shows under their contacts.
  Unassigning a chat leaves the contact with whoever had it.
- Every contact now keeps a permanent record of who created it
  (`contacts.created_by`: the person who added it, or for contacts made
  by incoming messages, the API or background jobs, the owner they were
  created for). It is not shown anywhere and nothing
  changes it; existing contacts take their current owner.
- The Contacts screens' "Created by" column is now "Owner", since
  that column shows whose contact it is and that now moves.
- The assign confirmation says the contact moves with the chat.

### Inbox: confirm before assigning a chat

- Picking a person in a chat's assignee menu (or Unassign) now asks
  first: "Assign this chat?", "Reassign this chat?" (naming who it
  moves from and to) or "Unassign this chat?". Nothing changes until
  you confirm; picking the person who already has the chat does
  nothing. No migration.

### Team chat: only leaders, admins and coordinators create channels; clearer channel types

- **Migration required:** apply `168_chat_channel_creators.sql`.
- Creating a team or private channel is now for owners, admins, team
  leaders and coordinators. Other agents and viewers no longer see the
  New channel button and the database refuses them; they still start
  direct messages as before. Settings → Team chat → Role permissions
  shows the rule (viewers: a dash; agents: "Coordinators only").
- The New channel dialog now names each kind and says who sees it:
  **Team channel — open to all staff**, **Private channel — invite
  only**, **Deal room — WhatsApp group with the customer**, with an
  example use for each and matching name and topic hints.

### Calls: Team call recordings page for team leaders and admins (no migration)

- A page to listen to your team's call recordings: choose a period,
  team, person, direction and minimum length, see per person how many
  calls were recorded and for how long, then play the recordings one by
  one. A team leader sees the teams they lead, an admin everyone. Plays
  are logged as before. No migration.

### Inbox: Draft a reply with AI reads the conversation and what you typed

- The draft is written from the last messages as a transcript (who said
  what and when, campaign templates and media included, and the campaign
  the customer is answering), so it answers what the customer actually
  wrote since your last message, or follows up when you spoke last,
  instead of a generic greeting.
- Type a rough reply or a note ("ask for salary cert + 3 months
  statement") and press the AI button: the draft says that, polished and
  fitted to the conversation, keeping your names and numbers. **Undo**
  puts your text back. If you keep typing while it writes, your text is
  kept. No migration.

### Members: admins edit a member's name and login email

**Migration required: 167** (`167_member_details_change.sql`). Apply
after 166 as `supabase_admin` (it refuses a role without superuser or
BYPASSRLS, like 140); re-runnable. An owner or admin can now change
another member's full name and login email from Settings → Members, on
the same terms as setting their password: only for someone below them
in this workspace and in every other workspace the person belongs to.
The new email is the login from then on, with no confirmation mail; an
address another login already uses is refused. Name and email are
shared by all of the person's workspaces, and each change is recorded
in their audit logs as `details_changed`.

### Calendar: every event type always shows

No migration. The Calendar's left rail no longer has the "Calendars"
checkboxes (My events, Invitations, Meetings, Workspace meetings,
Tasks) that hid a type of item. Everything is always shown, including
meetings open to the whole workspace. A choice saved in a browser
before this change is ignored.

### Broadcasts: templates with named variables

No migration. A template synced from Meta in its named format (`Hello
{{customer_name}},` rather than `{{1}}`) showed "Preview not available."
on the broadcast's Personalize step, with nothing to map. Its variables
now get the usual field picker and preview, a Meta send tags each value
with its `parameter_name` (Meta refuses positional values for such a
template), and Whapi/OpenWA render the names locally. Mappings left over
from a template chosen earlier in the wizard are no longer sent.

### Compass's withdrawn statuses close the case

**Migration required: 166** (`166_compass_finished_statuses.sql`). Apply
after 165 as `supabase_admin` (it refuses a role without superuser or
BYPASSRLS); re-runnable. Compass sends its own labels "Customer
Withdrawn" and "Agency Withdrawn", which only the exact word `WITHDRAWN`
used to close, so those cases stayed open at Submitted. They now count as
finished: the case closes as Withdrawn and its submission ends. The
migration also closes the open cases already holding either label; their
submissions end within about 5 minutes through the automations cron.
Both labels show as grey chips. Other Compass statuses are unchanged and
still shown word for word.

### Uploaded files can no longer run as a page (security)

**Migration required: 164** (`164_storage_safe_mime.sql`). Re-runnable;
apply it before or with this build, as `supabase_admin` or `postgres`.
**Server change required:** the nginx headers on `/supabase/storage/`
in `docs/security.md` ("Stored file types"); the migration alone does
not close the hole. Files posted in team chat, shared in a deal room
and call recordings are now stored only with a safe file type: an HTML,
SVG, XML or script file is kept as a plain download
(`application/octet-stream`) instead of opening as a page on the app's
own address, where it could have taken over the session of whoever
opened its link. The migration also makes the database refuse those
types for the three buckets on a direct upload, on a type list such as
`audio/x, text/html`, and on Storage's copy route when it sets a new
type. It cannot stop a copy that keeps the type stored on disk with the
source file, and the public buckets (avatars, chat-media, flow-media)
also accept a type list, so the nginx headers are what make every
stored file safe, old ones included. Deal-room transcripts now download
rather than open in the browser. Forwarding a team-chat file stored
before the update with a type that is no longer accepted (for example
Markdown or a macro-enabled Office file) now fails.

### Three permission gaps closed (team chat, Smart insights)

**Migration required:** apply `supabase/migrations/165_security_lows.sql`
(after 160, as a superuser or BYPASSRLS role like 156–160).
Forwarding a message with files now checks the copied files themselves
in storage (size and type must match the original), so a
person who may send voice notes but not upload files can no longer slip
an arbitrary file through as a "forward". In team and private channels
only a workspace owner or admin can change the role of a channel admin
(anyone may still step down themselves), and a bank guest can never be
made a channel admin. A channel admin who is not a workspace owner or
admin can no longer demote or remove a co-admin either, and the members
panel no longer offers it. Smart insights settings refuse an
interested-reply tag from another workspace with a clear message and
record who saved them.

### Security: small hardening (2026-10-31 audit)

No migration. The OpenDesk (Taamul sales) webhook now stops reading a
body past its 256 KB cap even when the sender omits Content-Length,
instead of buffering it before the signature check. The AI playground
clips each test turn to 4,000 characters, so one request can no longer
spend a multi-megabyte prompt on the account's provider key. Editing a
team with a `null` or non-object JSON body is treated as an empty edit
instead of a 500.

### Shared PC: no leftovers between logins

No migration. Team-chat unsent drafts and the Calls keypad's recent
dials are now kept per person (and workspace) in the browser and removed
on sign-out or when another user signs in, so the next login no longer
sees the last person's note or customer numbers. The broadcast wizard's
flow list cache is per workspace, and the shared reference-data cache is
emptied when another tab signs in as someone else.

### OpenWA numbers refuse internal media links

No migration. The OpenWA gateway runs on the same server as the app
and fetches a message's media link itself, so a link pointing at the
server or the private network (`https://127.0.0.1/…`, `10.x`, a name
that resolves inward, the cloud metadata address) could have been read
by the server and sent on WhatsApp. Media sends from an OpenWA number
— Inbox, broadcasts, automations, flows and template headers — now
need an https link to a public address, or one of the app's own
storage links; any other fails as an ordinary send failure. Whapi and
Meta numbers are unchanged: their clouds fetch the link.

### Remind me, from any WhatsApp chat

No migration. A bell button in the header of every Inbox and Team inbox
chat saves a reminder about that customer and chat: write what to do
("Ask for the renewed trade license"), pick Tomorrow, In 1 week, In 1
month, In 3 months (each at 09:00) or any date and time, and add a note
if you like. It is saved as a follow-up task for you (or for a
colleague you may assign the chat to), so it shows on the calendar, on
the customer page and in the home Tasks panel, and the bell rings 15
minutes before it is due. The confirmation offers Undo, and the same
window lists the customer's upcoming reminders with a Done button.
Agents and above; viewers don't see it.

### Faster switching between screens and chats

No migration. Screens you have already opened in this tab — the Inbox
and its chats, Team inbox, team chat channels, Contacts, the customer
page and Pipelines — now show their last view at once and refresh it in
the background, instead of starting from a blank screen every time.
Hovering a chat or channel starts loading it, the first load of a
screen asks for its data in fewer round trips, and admin pages are
prefetched with the rest of the menu.

- The copy is kept only in the open tab's memory, separately for each
  person and workspace. It is never written to disk, is wiped on
  sign-out or workspace switch, and every screen is refreshed the moment
  it is shown, so edits, deletions and lost access still show.
- An unsaved change on a page that asks before you leave (the flow
  editor, AI agents) holds a workspace switch: if you choose to stay,
  reload the page before carrying on.

### Bank coordinators work their banks' cases and submissions

**Migration required: 161, 162 and 163** (`161_bank_coordinator_access.sql`,
`162_bank_coordinator_case_lists.sql`, `163_bank_coordinator_submission_groups.sql`), applied in
order, as a superuser or BYPASSRLS role, **before** you deploy this build.
Re-runnable.

- **Cases.** A coordinator of a bank (Settings → Members) reads and works
  every case of that bank. They cannot reassign it. The case lists and the
  bank's space in Banks include these cases for them.
- **Submission groups.** The same people read and send in the bank's
  active submission groups as Coordinator, even when they are not on the
  group's list. Ended groups are unchanged.
- Taking the bank away removes the access at once.

### Team chat: voice notes, forwarding, permissions, moderation and export

**Migration required: 156, 157, 158, 159 and 160** (`156_chat_messaging_v2.sql`
onward), applied in order, as a superuser or BYPASSRLS role (157 to 160
refuse otherwise), **before** you deploy this build. Re-runnable. Nothing
changes for anyone until an owner or admin saves rules in Settings → Team
chat: every default keeps today's behaviour.

- **Voice notes.** Record in the composer (and in threads) with a live
  level meter, up to 15 minutes, and review before sending. A
  WhatsApp-style player (1×, 1.5×, 2×, waveform, download) plays voice
  notes and any audio file, and the author sees who played theirs.
- **Messaging.** Quote replies, forwarding to up to 5 channels or DMs
  (a forwarded message pings only the members of a DM), a formatting
  toolbar and shortcuts (bold, italic, strike, code, quotes, lists),
  an emoji picker and any emoji as a reaction, "Seen by" in DMs and
  channels of up to 20 people, and a "New messages" divider.
- **Files.** A Files panel per channel (All, Images, Voice, Video,
  Files, jumping to the message), a full-screen image viewer, inline
  video and file-type icons.
- **Access control.** Settings → Team chat → Permissions: a role matrix
  of twelve capabilities ("Use recommended", "Allow everything"), edit
  and delete windows, and per-channel posting rules (announcement
  channels, thread replies, @channel). Team channels can be limited to
  a minimum role and to teams. A sensitive-data guard (card number,
  Emirates ID, IBAN) can warn, or block in channels with bank guests or
  everywhere.
- **Moderation and compliance.** Removing someone else's message asks
  for a reason and reads "Removed by an admin"; channel admins can
  restrict a member from posting for 1 hour to 30 days; owners and
  admins can export a channel to CSV (up to 10,000 messages, reason
  required). Everything is in the audit log. Messages are still never
  deleted automatically, and voice notes are not transcribed.
- **Fixes after the first cut.** A posting timeout is now its own record,
  so leaving and rejoining a channel does not clear it and restricting
  someone in a team channel does not join them; the composer says
  "You can't post here until …" and the members panel shows "Restricted
  until". Managing a restricted team channel needs being inside its
  audience (owners and admins excepted), and a channel whose teams were
  all deleted stays closed to everyone but owners and admins until it is
  saved without teams. A forward may carry only exact copies of the
  source's files, and a stored file can belong to one message. The
  typing indicator ("Sara is typing…") now shows in channels and
  threads. Erasing a person also removes the bells and queued pushes of
  forwarded copies. The sensitive-data warning appears when a channel's
  guest status is unknown. A removal reason needs 5 non-blank
  characters, a refused removal keeps the dialog, CSV cells starting
  with `=`, `+`, `-`, `@`, tab or CR are neutralised, and the 30-day
  timeout ends 5 minutes short of 30 days. Re-running an older 157 to
  160 file no longer drops the audit-action CHECK (apply them in order,
  once). Quotes and the "Replying to" bar follow later edits, removals
  and erasures, and a quote that cannot be loaded shows as unavailable
  after a few retries.

### Fixes: drafts stay with their chat, OpenWA menu answers, unsent attachments

**Migration required: 155_chat_media_staged_sweep.sql**. Additive and
re-runnable. Without it the hourly clean-up of unsent attachments logs
an error and deletes nothing; everything else works.
- **Each chat keeps its own draft.** Switching chats no longer carries
  what you typed, an attached file or a reply quote into the next chat,
  where it could go to the wrong customer. The draft waits with its own
  chat and comes back when you return (while the tab stays open). A file
  still uploading, a voice note or an AI draft that finishes after you
  switch goes to the chat it was started in.
- **Unsent attachments are cleaned up.** A file attached in the inbox
  but never sent is deleted after 30 days. Sent attachments and template
  and broadcast headers are never touched. A draft attachment kept that
  long in an open tab is not sent: the inbox says so, and you attach it
  again.
- **OpenWA menus understand typed answers.** On an OpenWA number, where
  buttons and lists arrive as a numbered list, a customer who types the
  number (Arabic digits and "option 2" too) or the option's exact name
  moves the flow on, with or without Smart insights. Menus sent by
  automations or the journey bot are not matched yet.
- **A team leader's Inbox stays theirs.** A teammate's brand-new chat no
  longer pops into a team leader's personal Inbox; it is in the Team
  inbox, as before.

### Translate Arabic messages in the inbox

**Migration required: 154_message_translations.sql**, applied with 153,
before the new build goes live. Additive and re-runnable. Without it the
buttons still work, but translations are not saved and their token use
is not logged.
- **Translate** under an Arabic customer message shows it in English in
  the same bubble, with **Show original** to switch back. The
  translation is saved, so the next click, by anyone, is instant and
  free.
- **Translate to Arabic** in the composer, next to the attachment and
  template buttons, turns what you typed into Arabic in the input box,
  ready to edit and send, with **Undo**.
- Both use the workspace's own AI key (Settings → AI Agents); a new
  translation needs AI switched on there. Token use shows as
  **Translations** in AI usage. See `docs/ai-agent.md`.

### Customer insights 2.0: colour codes and chats pinned until someone acts

**Migration required: 153_insights_v2.sql**, applied **before the new build
goes live** (the inbox, the customer card and the writer read its columns).
Additive and re-runnable on top of 147–152. Everything stays inside the
existing Customer insights switch (Settings → Smart insights).
- **Pinned until someone acts.** A chat whose customer is under time
  pressure, asks for a person, is upset or asks for a call back is pinned to
  the top of the inbox with a coloured reason label, and stays there until a
  person replies, clicks **Handled**, or closes the chat. Bot and automation
  replies don't count; a new message that needs it pins the chat again.
  Admins choose which reasons pin, and the assigned person (else the chat's
  owner) gets a bell. Pins and un-pins show as notes in the chat timeline,
  with who handled it. A "Pinned chats" home tile and a Pinned filter open
  the list.
- **Colour codes.** One colour system for every insight: lead temperature
  (cold → ready), mood (very negative → very positive), each pin reason,
  each product, each objection. Inbox rows get a coloured edge and small
  coloured chips; a "What do the colours mean?" legend explains them; deal
  scores use the same colours.
- **Deeper understanding.** Jev now also judges the customer's mood on a
  five-step scale, what holds them back (rate or fees, documents, doubts
  about qualifying, trust, timing, comparing other offers), whether they
  expect a reply and whether they asked for a call. Every judgment is kept
  per chat, so the card shows whether they are warming up or cooling off and
  whether their mood is improving.
- **Customer card 2.0.** A pinned banner with **Mark handled**, colour-coded
  sections, the objections, up to two **next best actions** ("Call them
  back — they asked", "Acknowledge the problem first", "Send the documents
  checklist"…) and small trend lines for mood and lead temperature.

### Smart insights: Jev across the CRM

**Migration required: 147_smart_insights.sql, 148_campaign_reply_classes.sql,
149_compose_check_events.sql, 150_meaning_triggers.sql,
151_case_status_stage_map.sql, 152_kb_gap_topics.sql**, in order, **before
the new build goes live**: the inbox list and the customer page read the new
conversation columns whether or not a feature is switched on. Apply 151 as
a superuser or BYPASSRLS role, like 122–137. Every feature is **off** until
an admin switches it on in **Settings → Smart insights**, and needs
`TYPESAFE_API_KEY` plus the workspace in `TS_ACCOUNT_IDS`. Operator docs:
`docs/jev-insights.md`.
- **Customer insights.** Every customer message is judged once, after the
  opt-out watch and off the reply path: what they want, how close they are
  to applying, urgency, and whether they are upset or want a person. The
  inbox shows one badge per chat (Urgent, Upset, Wants a person, Hot lead /
  Ready to apply) with filters for each and an Urgent pin under the
  Important pins; the customer panel and page get an insights card; the
  home page gets "Hot leads waiting" and "Upset customers waiting". The
  figures reuse the safety watch's answers when it already judged the
  message, so most messages cost one Jev request.
- **Chat tag suggestions.** Jev suggests a main tag and sub-tag from your
  own tags (an optional **AI hint** per tag in Settings → Chat tags helps
  it). **Suggest** mode shows a chip in the chat header (Apply / Dismiss;
  a dismissed tag isn't suggested again for that chat), and **Suggest a
  tag** asks on demand. **Auto** mode also tags untagged chats on its own
  at or above a confidence you choose, never over a tag a person set,
  running the same automations and deal creation as a manual tag and
  leaving a "Tagged automatically" note in the chat.
- **Campaign reply sorting.** The first reply to a broadcast is sorted into
  interested, question, not now, not interested, wrong person, asked to
  stop or other, before the follow-up flow starts, so flows can branch on
  `campaign_reply_class`. Interested replies can be tagged with a chosen
  tag; the broadcast page shows the breakdown, filters recipients by it,
  and sorts past replies on request. Placeholders are sent blank, so no
  customer name reaches Jev.
- **Message check before sending.** Agents see a warning before sending a
  message that promises an approval, quotes an unconfirmed rate, names a
  bank you don't work with, claims Central Bank licensing, asks for card
  details or OTPs, sounds rude, or (when it starts a chat on a Whapi or
  OpenWA number) reads like a marketing blast. It never blocks: any error
  or a 2.5 s timeout sends at once. Switching chats mid-check keeps the
  message (and any attachment) waiting in its own chat. Admins see 7-day
  counts in Settings.
- **Flows and automations that understand meaning.** A new "Customer
  means…" trigger for flows and automations matches what the customer
  means, in any wording or language, with a Test-a-message box. Keyword
  triggers still win; at most one meaning automation runs per message;
  one Jev request per message serves both engines. Flows also understand
  typed answers to buttons and lists ("2", the option's label, "the
  second one").
- **Compass status → case stage.** Settings → Cases maps each Compass
  status name to a case stage, with Jev suggesting the stage. Final
  statuses can't be remapped, a suggestion is never applied without an
  admin, and "Move N open cases now" only ever moves a case forward.
- **Lead score.** Deal cards show a 0–100 score with reasons and an
  at-risk flag, and the board can sort by it.
- **Knowledge-gap topics.** Questions the bot couldn't answer are grouped
  into topics, with Jev labelling them and checking whether an approved
  answer already covers them (behind its own switch); "Write an approved
  answer" opens the editor on a draft, recomputed daily and on Refresh.

### Sidebar: counts instead of a dot

**Migration required: 146_whatsapp_group_reads.sql** (apply as a
superuser or BYPASSRLS role, like 114). It adds per-person read markers
for WhatsApp groups (`whatsapp_group_reads`), the
`whatsapp_group_mark_read(uuid)` and `whatsapp_group_unread_count()`
functions, and a partial index on inbound group messages.
- The Inbox item in the sidebar showed a pulsing dot when anything was
  unread. It now shows the number of unread chats (99+ above 99), like
  Team chat and Calls already did, and keeps showing it while you are
  in the Inbox.
- **Team inbox** shows its own unread count. For a team leader the two
  now differ: Inbox counts only your own chats (the ones the Inbox
  lists), Team inbox counts your team's too. Before, a leader's Inbox
  dot also lit for teammates' chats.
- **Cases** shows how many of your open cases are past their SLA (the
  home screen's "Overdue cases"), refreshed every 2 minutes.
- **Groups** shows how many WhatsApp groups have messages you have not
  read. Opening a group marks it read for you (only you). A group you
  have never opened counts only if it got a message in the last 7 days,
  so old groups don't all light up the day this ships.

### Dashboard: a home screen for today's work

No migration.
- The dashboard was still the WhatsApp-CRM page (open chats, new
  contacts, messages sent, quick actions, an activity feed). It is now a
  home screen that follows your role. At the top, **Needs your
  attention** counts what is waiting for you, each count opening the
  list it counts: unread chats, chats the AI handed to a person (and
  drafts to approve), overdue tasks, missed calls to return, and cases
  past their SLA.
- **Today** lists your open tasks (overdue, today, the next 7 days),
  which you can tick off here, your agenda (events and meetings, with
  Join when a meeting is about to start), and how many new chats you
  have started today against the limits that protect the WhatsApp
  numbers.
- **Your work** shows your cases (an agent's own, a team leader's
  team, everything for admins: SLA, customers waiting, documents
  missing, bank queries, the most urgent cases and, for leaders, cases
  by stage) and today's calls with their outcomes.
- Team leaders also get **Team activity today** (new chats, reply rate,
  customers waiting and the top warnings); admins also see the health
  of every WhatsApp number and the campaigns sending or scheduled.
- **Trends** keeps the message volume, pipeline value and response-time
  charts. The page refreshes itself every five minutes while open, and
  when you come back to it.

### Calls: a movable call window with the customer's history

No migration.
- The call panel no longer covers the right side of the screen. It is a
  floating window you drag anywhere by its dark top band, and it stays
  where you leave it, also after a reload (remembered per browser). The
  arrow keys move it too, and a double-click sends it back to the
  corner. **Minimise** turns it into a one-line bar with the customer,
  the timer, Mute and Hang up (or the wrap-up countdown once the call
  ends). On a phone it is a bottom sheet. The incoming-call card can be
  moved as well.
- The window now has tabs. **Notes** keeps the outcome, notes and call
  card, and adds a one-click call-back reminder (in 1 hour, 3 hours,
  tomorrow 10:00, in 2 days, or a time you pick) that creates a
  call-back task for you, with Undo. **Customer** shows the owner, open
  deal, last WhatsApp message and consent, the open tasks (tick one
  done) and cases, with links to the customer page and the WhatsApp
  chat. **History** lists your earlier calls with this customer, with
  their outcomes and notes. See section 11 of `docs/yeastar.md`.

### Sidebar: grouped by area of work

No migration.
- The long list at the top of the sidebar is now split under headings
  by area of work, with Dashboard on its own above them:
  **Collaboration** (Team chat, Meetings, Calendar), **Conversations**
  (WhatsApp inbox, Calls, WhatsApp groups), **Customers** (Contacts,
  Pipelines, Journeys) and **Bank submissions** (Cases, Submission
  groups, Banks). Team leaders also get **Team** (Team inbox, Team
  contacts, Team activity). Admins also get **Campaigns & automation**
  (Broadcasts, Automations, Flows), which replaces the one-row "Sales &
  marketing" and the "AI & automation" headings, and **Integrations**
  (Compass, OpenDesk). Settings stays at the foot. A heading shows only
  when there is something under it the person may open.
- Team inbox and Team contacts have icons of their own, no longer the
  same as Team chat's and WhatsApp groups'. Rows are a little more
  compact on desktop to make room for the headings: an agent's sidebar
  still fits a browser window 900 px tall without scrolling, and
  scrolls a little in a shorter one.

### Team activity: OpenWA numbers count as phone numbers

**Migration required:** apply `supabase/migrations/145_team_activity_openwa.sql`.
- An OpenWA number is paired to a phone like a Whapi number and carries
  the same ban risk, so Team activity now treats it the same way: its
  card shows "Phone number" with the warm-up and daily new-chat limits,
  its failures count as phone-number failures, a person's daily count
  includes chats started on it, the composer warns before a new chat on
  it, the bell alerts cover it, and the optional block refuses a new
  chat on it over the limit. The Safety Meter stays Whapi-only (it is
  Whapi's own API). See `docs/team-activity.md`.

### Phone system: calls stuck as live are settled

- A call whose end event never reached the CRM no longer stays
  "ringing" or "in progress" for ever. Two hours on, the phone-system
  cron reads the PBX's call records and settles it with its real
  outcome, talk time and recording; with no record after a day it is
  closed as answered (was in progress) or failed (was ringing) and
  marked `settled_without_cdr`. No tasks or bells. See section 10 of
  `docs/yeastar.md`. No migration.

### OpenWA: a third way to connect WhatsApp numbers

**Migration required:** apply `supabase/migrations/144_openwa_provider.sql`.
- A WhatsApp number can now be connected through OpenWA, a self-hosted
  linked-device gateway running beside the app, as well as Whapi and the
  Meta Cloud API. See `docs/openwa.md` for setting it up.
- A phone that links just after the connect dialog gives up is kept,
  not deleted when the dialog closes.
- A new number's first link no longer alerts owners that it is
  "connected again", and the Settings list no longer hides the
  "connected again" alert for a number that came back.
- Disconnecting while OpenWA is unreachable warns that the session may
  still be running on the gateway.
- Connects abandoned for 30 minutes are cleaned up on the gateway and
  removed.

### A new light theme

No migration. Visual only.
- Light mode is rebuilt around the brand: a cool blue-tinted page under
  soft-white cards, deep navy text and the brand blue for buttons, links
  and selection, instead of grey on grey. Still no pure-white surface.
- The side navigation is the brand navy in light mode (it was near
  black).
- Every form field now looks the same: soft white with a visible
  border. Grey-filled fields remain only where a value is read-only.
- More colour where it helps you scan: dashboard figures and shortcuts
  have their own colour, customers without a photo get a coloured
  initial in the inbox, and broadcast statuses are readable in light
  mode (scheduled, sending and failed used a pale text colour).
- Dialogs dim the page behind them in light mode, and the sign-in page
  has a soft brand-blue glow.
- Dark mode keeps its look. The few changes that show there too: the
  coloured dashboard tiles and initials, the blue timeline filter, the
  readable broadcast statuses, and primary buttons now change shade on
  hover (they gave no feedback before).

### Notifications move to a bell in the top bar

No migration.
- A bell next to the light/dark switch shows how many notifications
  are unread. Clicking it opens a dropdown with the latest
  notifications, "Mark all as read", and a "View all" link.
- The Notifications item is gone from the sidebar. The page still
  exists at `/notifications` (push notifications and "View all" open it).

### Team chat: choose who may message whom (migration 143)

**Migration required: 143** (`143_chat_dm_rules.sql`, apply as a
superuser or a BYPASSRLS role; apply it before
deploying, since the settings screen and the New message picker call
its functions).
- Settings → Team chat gains a Direct messages section: for each pair
  of roles (admin, team leader, coordinator, agent, viewer) an owner or
  admin picks *not allowed*, *same team only* or *everyone*. Owners can
  always message everyone.
- A pair that is not allowed cannot open a DM, and existing DMs between
  them are hidden from those people (not deleted; relaxing the rule
  shows them again). Admins can still open any DM through the audited
  read.
- Nothing changes until rules are saved. "Use recommended" fills in:
  agents and viewers may message their own team leader, admins and
  coordinators, not each other.

### Bank coordinators join their submission groups (migration 142)

**Migration required: 142** (`142_coordinator_whatsapp_numbers.sql`,
apply as a superuser or a BYPASSRLS role; the TS reads the new column
and passes the new `sg_open` parameter, so apply it before deploying).
- Settings → Members gains a WhatsApp number for each coordinator, the
  number they are added to their banks' submission groups with.
- When the submission tracker opens a WhatsApp group for a case with a
  bank, every coordinator of that bank who has a saved number is added
  to the group (up to 5 coordinator numbers, the request's
  `coordinator_phone` included), and each coordinator of the bank joins
  the group's access list as Coordinator. Their messages in the group
  are logged as the coordinator's. Submissions without a WhatsApp group
  are unchanged.
- A group's name defaults to `<company> x Taamul Credit`; a `subject`
  sent by Compass still wins.

### Calls screen shows people's calls by role

No migration.
- An agent's Calls screen lists only their own calls, a team leader's
  their own and their teams', an admin's everyone's. Team calls and the
  team's Missed calls no longer include other people's calls on
  customers the leader can see; those stay on the customer's page.
- A call between colleagues shows the other person (or "Ext 2122" when
  their extension is not mapped) instead of "Unknown caller"; a leader
  or admin looking at two others' call sees both sides.
- The Colleagues, Unrouted, and Groups & queues tabs are gone from the
  Calls screen; an old link to one opens My calls.

### Phone calls with several PBX records are combined

No migration.
- When the PBX sent several end-of-call records for one call (a ring
  group, a transfer, a no answer followed by voicemail or a failed
  record), the CRM kept only the last one, so a call could show the
  wrong status, talk time, start time and person. All records are now
  kept and combined: answered if any is answered, talk time of the
  longest answered one, the earliest start, and the answering person.
- A missed-call task opened by an early no-answer record is closed when
  an answered record follows.
- Calls stored earlier can be repaired with
  `npx tsx scripts/pbx-repair-call-legs.ts` (dry run), then `--apply`.
  It leaves tasks and recordings alone.
- The gateway's call-record backfill no longer drops every record of a
  call after the first (they all share one PBX id).
- Calls made before the PBX's live feed was connected can be imported
  from its call records with
  `npx tsx scripts/pbx-import-cdr.ts --from <ISO> --to <ISO>` (dry run,
  at most 24 hours), then `--apply`. It skips calls already in the CRM
  and never opens tasks, rings bells or settles call-backs; recordings
  are fetched by the cron as usual.

### WhatsApp groups and Submission groups redesigned as split views

- Both pages are now an Inbox-style split view: the list stays on the
  left, the selected group opens on the right (one pane at a time on a
  phone).
- WhatsApp groups: the chat sits in the middle and a "Group info" panel
  (members, invite link, join requests, settings, managers, leave)
  docks on the right on wide screens, or opens from the Info button.
  Old `?tab=` links open the matching section.
- Submission groups: rows and the header show the company the tracker
  sent instead of the raw submission id and the contact's WhatsApp
  name; the contact appears as "Contact: <name>" when it differs. The
  reference is shortened (copy for the full one), the tracker status is
  coloured, search matches the company, and a "My groups" filter was
  added. A submission without a WhatsApp group shows its details and
  people instead of an empty chat.
- The cases list and the case page show the linked contact's own name
  under the company ("Contact: <name>").

### Delete WhatsApp groups you left

- Owners and admins can delete a WhatsApp group your number has left
  from the CRM: "Delete from CRM" in the group's info panel or ⋮ menu,
  or "Delete all left groups" above the list under the Left filter.
  It removes the group and its saved messages from the CRM only;
  WhatsApp is not affected. Groups the number is still in can't be
  deleted. No migration.

### Cases show the company the submission tracker sent (migration 141)

**Migration required: 141** (`141_submission_customer_name.sql`, apply as
a superuser or a BYPASSRLS owner of `submission_groups`; the TS reads the
new column, so apply it before deploying).
- `POST /api/v1/submission-groups` now keeps the request's
  `customer.name` on the submission group. It used to be used only when
  the phone matched no contact, so most cases showed the contact's own
  name (often a person's WhatsApp name, or blank) instead of the
  company.
- The Cases inbox, the case page and the bank workspace case list show
  that name as the customer, falling back to the contact's name. CRM
  contacts are not renamed.
- Existing groups are backfilled from their subject: Compass titles a
  group `<company> - <ref>`, so the trailing ` - <ref>` (or our own
  ` · <submission id>`) is dropped; a subject that is only a phone
  number gives no name.

### Voice notes look and play like WhatsApp

No migration.
- A voice note in the inbox and team inbox is now a round play button,
  the clip's own waveform (click or drag it to jump), a running clock
  and a 1× / 1.5× / 2× speed pill, instead of the browser's audio bar.
  Starting one pauses any other that is playing; download stays.
- Browser-recorded notes now show their real length (Chrome used to
  show none) and can be seeked.
- Recording shows a live meter of your microphone, the clock (red in
  the last 30 seconds) and the 5:00 limit; the take can be played back
  before it is sent.

### Admins can set a member's password (migration 140)

**Migration required: 140** (`140_member_password_change.sql`, applied
as a superuser or BYPASSRLS role, like 092).
- Settings → Members has a key button on each row an owner or admin may
  change: it sets that person's password, shown in plain text and
  starting as a suggestion so it can be passed on, as in Add person.
- An admin can set the password of team leaders, agents, viewers and
  bank guests; the owner can set anyone's. Nobody sets their own here:
  that stays in Settings → Login & security.
- One login opens every workspace it belongs to, so the change is
  refused when the person also belongs to a workspace you do not
  administer above them.
- Each change is recorded as **Changed a password** in Settings →
  Privacy & compliance → Audit log, in every workspace the person
  belongs to.

### Settings: a side menu, search and a map of every section

No migration.
- Settings now has a menu down the left (on narrower screens, behind the
  bar at the top), grouping its sections as **My account**, **Workspace**,
  **WhatsApp**, **Inbox & CRM**, **AI & automation**, **Cases &
  collaboration**, **Privacy & compliance** and **Integrations**. It
  replaces the two rows of tabs.
- Moved: Members and Teams to Workspace; Cases, Deal rooms and Team chat
  to Cases & collaboration; Vault, Consent and retention and the Audit
  log to Privacy & compliance; Deals & currency to Inbox & CRM; the
  Journey bot beside AI Agents. The workspace's name and archiving are
  now **Workspace → General**.
- **Search settings** at the top of the menu finds a section by its name
  or what it is for (try "password", "currency" or "QR").
- The Overview lists every section you can open, each with a one-line
  explanation, or its live status: WhatsApp connection, members and
  pending invites, templates awaiting Meta, custom fields, the AI
  assistant.
- The account menu's **Settings** now opens the Overview rather than the
  WhatsApp connection.
- Links to a section (`/settings?tab=…`) are unchanged.

### Every chat message names its sender

No migration.
- In the Inbox, the Team inbox and the Campaign inbox, every message
  has a small line at the top of its bubble saying who sent it: the
  customer's name, the team member who replied (your own read
  "Name (you)"), **AI assistant**, **Bot** (flows, automations, the
  journey bot) or **Team** when no person was recorded (Compass
  notifications, the public API, and replies from before the CRM
  recorded who sent them). Hover the last three for what they mean.
- A quote of a message, the Forward preview and the photo viewer name
  the same sender. They used to say "You" for everything the business
  sent, whoever sent it.
- In a WhatsApp group's chat, outgoing messages are named too: the team
  member who sent it from the CRM, or **Your number** for one sent from
  the phone.

### OpenDesk: interested contacts from the Taamul sales app (migration 139)

**Migration required: 139** (`139_taamul_sales_interested.sql`).
- New endpoint `POST /api/taamul-sales/webhook` receives the sales app's
  signed "contact marked as interested" events.
- They are stored in a separate OpenDesk list, not in the CRM's
  contacts, and shown to admins under **Integrations → OpenDesk** next
  to Compass: customer, company, phones, trade licence, agent, call
  notes and lead, with search and a details view per contact.
- Set `TAAMUL_WEBHOOK_SECRET` and `TAAMUL_WEBHOOK_ACCOUNT_ID`; see
  `docs/taamul-sales.md`.

### Cases show the submission tracker's own status

No migration.
- The case page, the Cases inbox and a bank's Cases tab now show a
  submitted case's status exactly as the submission tracker (Compass)
  sent it, e.g. **UNDER_REVIEW**, instead of the CRM stage name. Leads,
  and cases the tracker has not reported on yet, still show their stage.
- The same goes for the customer page's Cases card, the case picker on a
  bank's page, and the Submissions table under Integrations → Compass
  (its column is now **Status**). Whatever name Compass sends is shown
  as sent; nothing is translated, re-cased or mapped.
- Each of Compass's status names has its own colour: To Submit sky,
  Inhouse Review indigo, Submitted blue, Bank Review violet, Awaiting
  Customer Response amber, Returned to RO orange, Awaiting Fulfillment
  teal, Approved green, Declined red. Any other status takes the colour
  of the stage it names, else of the case's stage. The Compass
  Submissions table shows the same coloured chip.
- The stage itself is unchanged underneath: SLA timers, closing a case,
  the stage filter, Move stage and the bank dashboard still use it.

### Deals follow the chat's tags (migration 138)

**Migration required: 138** (`138_tag_deals_follow_chat.sql`).
- A deal opened from a chat tag now carries the sub-tag in its title,
  e.g. **Jane Doe · ADCB**.
- Re-tagging a chat with another tag linked to a stage (Pipelines →
  Manage pipeline) moves the customer's open deal to that stage instead
  of leaving it; with no open deal, one is created as before. A tag
  linked to no stage moves nothing.
- Changing only the sub-tag updates the deal's title. A title someone
  edited by hand is kept.

### Case stages follow the submission's status (migration 137)

**Migration required: 137** (`137_submission_status_stage.sql`, apply as a superuser or BYPASSRLS role).
- A case now moves when Compass reports its submission's progress. Compass
  sends a status such as `UNDER_REVIEW` or `DOCUMENTS_REQUESTED` and no
  stage, so until now every open case stayed at **Submitted**. A status
  now moves the case to the stage of the same name (Under review,
  Documents requested, …); final statuses close the case as before. A
  stage Compass sends explicitly still wins.
- Applying the migration catches up once: every open case still at
  Submitted moves to the stage its submission last reported.

- Right-click menu: right-clicking anywhere in the app now opens Taamul Connect's own menu instead of the browser's: the actions of what you clicked (a chat in the Inbox list: open, open in new tab, customer page, copy phone or name; a message: reply, react, copy text, forward), then link, image and selected-text actions, then Back, Forward, Reload, Copy page link and a light/dark switch. Text fields keep the browser menu (spell check, paste), and holding **Shift** while right-clicking always gives the browser menu. A long-press on a message on a phone still pins its toolbar. No migration.
- Right-click menu in Team chat: a message offers reply in thread, react, copy text, copy link to message, pin or unpin, save or unsave, edit, edit history and delete (with its confirmation), each only where the message's own toolbar offers it; a channel or DM in the chat sidebar adds Mark as read (when it has unread messages) and Mute or Unmute to the usual link actions. A notification offers Open and, while unread, Mark as read; a calendar entry offers Open details plus what its popover offers (Join, Open meeting and Copy link for a meeting, Open contact for a task, and Edit and Delete for an event you organise, with the same "This event / All events" question); a meeting on the Meetings list offers Join (when the list shows it), Open details and Copy link. No migration.
- Workspaces: the workspace rail at the far left of the sidebar is gone. Switching workspace, and creating one (owners and admins), now happens in **Settings → My account → Workspaces**, which lists every workspace you belong to with your role, team-chat unread and mentions. A bank guest can open that one Settings section (from the account menu's **Workspaces** item) and nothing else of Settings. No migration.
- Cases: cases now come only from the submission tracker. The **New lead** button on the Cases page, **Open lead** on the customer page's Cases card and **New lead** in the customer page's menu are gone, and `POST /api/cases/leads` answers 405. Leads opened earlier stay and still attach to their submission. No migration.
- Spreadsheet and PDF limits: an `.xlsx` (broadcast audiences, approved-answers import) is refused when it places a cell past Excel's own grid (column XFD, row 1,048,576), places more than 2,000,000 cells, has more than 50 tabs, or unpacks to more than 50 MB per part or 100 MB in all. A knowledge-base PDF is refused past 500 pages, past 2,000,000 characters of text (split the file; it is not cut short), or when reading it takes over 20 seconds. No migration.

### Cases without WhatsApp groups (migration 136)

**Migration required: 136** (`136_submission_without_whatsapp.sql`, apply as a superuser or BYPASSRLS role).
Apply it **before** deploying this version: the app now reads
`submission_groups.wa_mode`, and without the column every submission-group
and case conversation read fails.
- A submission from Compass now always reaches the CRM as a case, even with
  no Whapi number connected. Whether it also gets a WhatsApp group is a new
  switch, **Settings → Cases → Open a WhatsApp group for each submission**,
  **off by default**; only owners and admins can change it.
- Off: a new submission opens the case only. Compass gets `201` (or `200`
  on a repeat), never `202`; it no longer needs a Whapi number, ignores a
  `channel_id`, and does not refuse an opted-out customer, because nothing
  is sent to them.
- On: each new submission also gets its WhatsApp group, exactly as before.
- A case keeps what it was opened with: turning the switch on or off only
  changes new submissions.
- The public API's submission group now carries `whatsapp.mode` (`"group"`
  or `"none"`). On a `"none"` submission a final status ends it and closes
  the case with nothing to close on WhatsApp.
- On a case without a WhatsApp group the Conversation tab says so instead
  of showing a composer, and a reply or documents request is refused with
  "This case has no WhatsApp group".

### Security hardening (migration 135)

**Migration required: 135** (`135_security_hardening.sql`). SQL only:
- Automations, automation steps, flows, flow nodes, broadcasts and broadcast
  recipients are now admin-only writes in the database too. Every screen and
  route already was, but an agent could write them straight through the API
  with their own sign-in (for example an active automation forwarding every
  customer message to an outside webhook, or a scheduled broadcast).
- Transferring ownership takes the per-person lock, so two concurrent
  transfers can no longer leave two owners.
- A team's new leader or members must be live staff: no bank guests, no
  deactivated people. Someone already on the team stays when it is saved.
- An invite link whose creator may no longer grant its role, or whose
  workspace is archived, now shows as expired on the join page instead of
  naming the workspace (redeeming it was already refused).
- Nobody can change their own `profiles.email` directly; email changes go
  through sign-in settings, as the app already does.

### Compass case sync (migration 134)

**Migration required: 134** (`134_compass_case_sync.sql`), as a superuser or
BYPASSRLS role. SQL only so far: `cases.external_url` / `external_changed_at`;
a per-account `managed_externally` switch (`case_settings_set`, owner/admin)
under which staff can no longer move the stage, edit bank/product/amount, set
the outcome reason or mark documents received/rejected on a submitted case
(`MANAGED_EXTERNALLY`; leads stay editable); `case_sync_from_submission`, the
API path that applies the submission app's stage, details, outcome reason and
documents (stale updates ignored); a webhook outbox fed by triggers
(`case.stage_changed`, `case.lead_created`, `submission_group.ready` /
`.failed` / `.ended`, `contact.opted_out`), queued only for subscribed
endpoints; and `compass_link_contact_by_phone`.

User-visible API and UI changes:

- `PATCH /api/v1/submission-groups/{submission_id}` also accepts
  `changed_at`, `stage`, `outcome_reason`, `bank`, `product`, `amount`,
  `compass_url` and `documents` (`status` optional then) and answers a
  `sync` block; stale updates are ignored, refusals are `422` with a code.
- New `GET /api/v1/case-stages` and `GET /api/v1/case-documents`
  (scope `submission_groups:read`).
- The webhook vocabulary gains `case.stage_changed`, `case.lead_created`,
  `submission_group.ready`, `.failed`, `.ended` and `contact.opted_out`,
  sent by the automations cron (at most once).
- Settings -> Cases: the switch **Submitted cases are managed in Compass**;
  a locked case answers `MANAGED_EXTERNALLY` and shows a banner with an
  Open in Compass link and the last sync time.
- `docs/compass.md` is now the full contract for the Compass team
  (base URL `https://<your-crm-host>/api/v1`, a third API key, sync,
  webhooks, go-live checklist); `public-api.md`, `cases.md` and
  `submission-groups.md` describe the sync and the lock.

### Coordinators (migration 133)

**Migration required: 133** (`133_coordinators.sql`), as a superuser or
BYPASSRLS role; asserted by `supabase/ci/verify-coordinators.sql`. An owner
or admin can give an agent or team leader one or more banks in Settings ->
Members, which makes them that bank's **coordinator**. An agent shares a
customer's chat with a bank's coordinator from the chat header; the
coordinator is notified, sees the chat in their inbox as "Shared · BANK",
can read it and reply from the chat's own number, and sees the contact read
only. A share lasts until it is revoked. See
[docs/coordinators.md](docs/coordinators.md).

### Banks: summary strip, case columns, new dashboard figures (migration 131)

**Migration required: 131** (`131_bank_dashboard_leads.sql`), as a
superuser or BYPASSRLS role, after 130. The bank page header shows open
cases, members now by role, open Action needed items and your role here.
The Cases tab adds the customer (linked), an SLA chip with the next due
date and a Lead chip, sorted most overdue first. The Dashboard adds
Pre-submission, With the bank, Account openings, Financing (count and
exact AED amount, replacing Amount in pipeline) and lead Conversion. Losing
access now explains that it returns with your next open case of the bank.
See `docs/cases.md`.

### Case leads (migration 130)

**Migration required: 130.** A case can now start as a lead: no
WhatsApp group, three pre-submission stages (Interested, Data collection,
Review) before Submitted. Agents open one with `POST /api/cases/leads`; a
later submission for the same contact and bank attaches to it. Staff open
a lead from the customer page (Cases card, **Open lead**); the case page
shows a lead banner and offers only the stage moves allowed, and the Cases
inbox marks leads with a Lead chip. A cold lead
ends as Withdrawn with the new outcome reason No response. Bank stage lists
must start with the three new stages (the settings screen checks this).
See `docs/cases.md`.

### Cases, CRM memory, the vault and assistant safety (migrations 120-129)

**Migration required: 120-129**, applied in number order, each as a
superuser or BYPASSRLS role. Their SQL is asserted by
`supabase/ci/verify-assistant-safety.sql`, `verify-vault.sql`,
`verify-cases.sql`, `verify-case-tools.sql`, `verify-case-sla.sql`,
`verify-case-inbox.sql`, `verify-bank-workspaces.sql`,
`verify-bank-dashboard.sql` and `verify-crm-memory.sql`.

### Cases

**Migration required: 122-128** (`122_cases.sql` to
`128_case_takeover.sql`). One case per submission group: the bank, product
and amount of a submitted application, its stages, tasks, required
documents, internal notes, bank contact log and SLA timers. Coordinators
work them from the inbox at `/cases` and the case page; every read of a
case's conversation by a coordinator, team leader, admin or owner is
audited. `/banks` gives each bank an internal space: threads, pinned
information, action items and a dashboard. Owners and admins configure
banks, stage lists, task templates, required documents and SLA timers in
Settings -> Cases. See [docs/cases.md](docs/cases.md).

### CRM memory

**Migration required: 129** (`129_crm_memory.sql`). A Memory panel on the
customer page and the case page keeps short staff notes of what was
agreed. Sensitive numbers are redacted (or vaulted) before a note is
stored, notes expire after 24 months, and owners and admins can forget a
customer's or a case's notes. See
[docs/memory-and-vault.md](docs/memory-and-vault.md).

### Vault

**Migration required: 121** (`121_vault.sql`). Emirates ID, IBAN,
passport, phone and account numbers in memory notes are encrypted by the
app and replaced by a token; vault admins reveal or erase a value with a
reason, every attempt audited, in Settings -> Vault. New environment
variables `VAULT_KEYS`, `VAULT_CURRENT_KEY` and `VAULT_BLIND_KEY`; they
are optional: without them memory still redacts those numbers,
irreversibly. See [docs/memory-and-vault.md](docs/memory-and-vault.md).

### Assistant safety

**Migration required: 120** (`120_assistant_safety.sql`). The idle
foundation for a future AI assistant: tool risk levels, human
confirmation of risky actions (`POST /api/assist/pending/[id]`), rate
limits, a loop guard and an append-only audit. No assistant exists yet,
so nothing calls it. See [docs/assistant-safety.md](docs/assistant-safety.md).

### Assistant middleware and prompt caching (019e, 019f)

**Migration required: 132** (`132_assist_agent_run.sql`), as a superuser or
BYPASSRLS role. Still idle (no assistant exists): the agent loop with
ordered hooks (`src/lib/assist/middleware.ts`), the built-in redaction,
context-budget and per-run audit middleware, and the three-tier prompt
cache layout (`promptcache.ts`). 132 adds the audit kind `agent_run`
(counts only) to `assist_audit`; asserted by
`supabase/ci/verify-assistant-safety.sql`. See
[docs/assistant-safety.md](docs/assistant-safety.md).

### Public API: submission groups carry their case

`POST /api/v1/submission-groups` takes optional `bank`, `product` and
`amount` and opens the group's case; `POST` and `PATCH` answers carry it as
`case`. A final status (`APPROVED`, `DECLINED`, `WITHDRAWN`, `CLOSED`)
moves a case not yet at a final stage. See
[docs/public-api.md](docs/public-api.md).

### Phone system: a simpler call report

`/calls/report` now opens on your own external calls today: one big
talk-time figure (with its change against yesterday or the previous
period), four small tiles (calls, answered, missed, average talk) and
today's call list. The charts, the remaining figures and, for everyone,
the by-person table sit behind "More details", which remembers being
left open. Periods are Today, Yesterday, This week, This month and
Custom (old links to last week or last month still open). Team leaders
and admins switch between Me, Everyone (`?user=all`) and one person; a
single "Export (CSV)" writes the figures and the call list together.

### Phone system: call report figures

**Migration required: 119** (`119_pbx_call_stats.sql`). It adds
`pbx_call_stats`, which returns everything the Call report page shows
for a period in one call: the headline figures and the previous
period's, calls per day and per weekday and hour in the workspace's time
zone, talk-length buckets, outcomes, a row per person, the most called
numbers and the longest calls. Owners and admins see the whole
workspace, team leaders their teams and themselves, everyone else their
own calls. `supabase/ci/verify-pbx-call-stats.sql` asserts it. The previous period
is like with like (the same length, and the page says which days it
covers), the answer rate's change reads in percentage points, and the
call list under the figures is exactly the calls they count: external
calls (inbound and outbound) by the person, the team's people or the
whole workspace, rather than every call the viewer can see.

### Calendar: a click on an event is no longer undone by a scroll

No migration. On the day and week grids, the event popover could open
and then vanish: the grid jumped back to an hour before now whenever the
page re-rendered or the workspace time zone arrived, carrying the
clicked event away. The grid now scrolls to now only when it first
shows a set of dates (opening, changing week or view), never in between.

### Submission groups: the 1:1 invite link is recorded

**Migration required: 118** (`118_submission_group_invite.sql`, apply as
a superuser or BYPASSRLS role, as 115). It adds
`submission_groups.invite_sent_at` and `invite_send_error` and the
service-role function `sg_note_invite`.

When WhatsApp refuses to add the customer and the invite link is sent to
them 1:1, the outcome is now kept on the group. The group page's header
shows "Invite link sent to the customer · <time>" or "Invite link could
not be sent", and the public API's group carries
`whatsapp.invite_sent_at`. The invite's text is still not stored.

### Submission groups: a sent message is recorded from Whapi's echo

When WhatsApp accepted a staff message but the CRM could not record it
(the sender saw "sent, but not recorded"), the stored copy stayed pending
and the cron marked it failed after 10 minutes although the customer had
it. Whapi's echo of the send now settles that copy as sent, matched on
its exact text within 15 minutes; a sender whose own record lost the race
to the echo is no longer told it was not recorded. No migration.

### Meetings: a removed person leaves the call at once

**Migration required: 116** (`116_meeting_removal_realtime.sql`, apply
as a superuser, as 106). It adds `meeting_removed_users` to the
realtime publication.

When the host removes someone, that person's room now switches to the
"removed" screen within about a second. Since 112 a removed person can
no longer see their own seat, so the room only found out at its next
heartbeat, up to 20 seconds later, and stayed in the call until then.
The room now listens for its own removal directly; the heartbeat check
remains as a fallback.

### Deletes that cascade no longer depend on trigger order

**Migration required: 117** (`117_deferred_cascade_fks.sql`). It
changes no data and no `ON DELETE` behaviour, and only rewrites catalog
rows of two meeting tables (each locked for a moment; it gives up after
5 s if a long transaction holds one — just run it again).

Deleting a meeting host's login reaches a removal or seat row by two
paths at once — a cascade through the meeting and a `SET NULL` on
`removed_by`. On a database restored from `pg_dump` the foreign-key
triggers fire in a different order than on one built from the
migrations, and a delete in the same transaction that created the row
then failed with `23503` (seen as `verify-calendar.sql` failing on a
restored copy; deletes in a later transaction were never affected). 117
makes `meeting_participants_meeting_fkey` and
`meeting_removed_users_meeting_fkey` `DEFERRABLE INITIALLY DEFERRED`, so
they are checked at commit, after the cascade.

### Submission groups (module 018a)

**Migration required: 115** (`115_submission_groups.sql`, apply as a
superuser or BYPASSRLS role, as 114). It adds the tables behind
submission groups: the groups, their access list, their own message log
and an append-only audit of archive views. Removing a Whapi number or
deleting a contact detaches its groups instead of blocking the delete.

The submission application opens one WhatsApp group per submitted case on
a Whapi number through the public API (`POST`/`GET`/`PATCH
/api/v1/submission-groups`, scopes `submission_groups:read` and
`submission_groups:write`). Staff are named by login email and work the
group from the CRM, every message prefixed `Name (Label): text`. A final
status ends the group; an ended group is read only through an audited
archive view (admins, and coordinators and team leads for 60 days). The
automations cron finishes pending creates, fails stale sends and retries
closes. See `docs/submission-groups.md`.

### WhatsApp groups on a Whapi number

**Migration required: 114** (`114_whatsapp_groups.sql`, apply as a
superuser or BYPASSRLS role). It adds the tables behind WhatsApp groups
on a Whapi number: the groups, their participants, the staff who
manage each one, the invite link (readable only by those managers) and
the group's own message log, which stays out of the inbox, flows,
automations and the AI. Owners and admins see every group; others see
the groups they created or manage, and team leaders their team's.

The Groups screen (`/groups`) creates a group from a Whapi number and
runs it: chat, members (adds paced at 5 per call, 3 s apart, 50 per
operation, with the invite link as the fallback; opted-out contacts are
skipped), settings and picture (JPEG/PNG up to 2 MB), the invite link,
join requests with a bell for managers, and a Managers tab. See
`docs/whatsapp-groups.md`.

Routes for a group's managers (`GET`/`PUT .../managers`), its picture
(`GET`/`PUT`/`DELETE .../icon`) and its own chat (`GET`/`POST
.../messages`, at most 20 sends a minute per group).

### Each person sees their own calls

A team leader no longer sees every call and incoming-call card of the
workspace: only their own, the people of the teams they lead, and the
customers they can see. Agents and viewers now also see a missed call
that rang their phone. Owners and admins still see every call.

A missed call's _Call back_ task and bell now go to a person the call
rang (the chat's agent or the contact's owner first, when they were
rung), else the chat's assigned agent, else nobody: the task waits
unassigned for an admin. It no longer goes to whoever created or
imported the contact, which had sent one owner every missed call. A
caller who rings again while their task is still open adds to that
task ("3 missed calls…") instead of opening another task and bell.

The Calls screen now opens on **My calls**: the calls you placed, took
or were the other party to, and the ones that rang your phone.
**Missed calls** shows your own missed calls and the missed-call tasks
assigned to you; team leaders can switch it to _Team_ and owners and
admins to _All_. The old Call log is now **Team calls** for team
leaders and **All calls** for owners and admins, and agents and viewers
no longer see it. The chat sidebar's call count is your own calls today.
`GET /api/pbx/calls` defaults to `scope=mine`, which now includes calls
that rang you, and takes `scope=my_missed`.

**Migration required:** `supabase/migrations/113_call_visibility.sql`.

### One customer page replaces the contact side sheet

Clicking a contact in Contacts or Team contacts (and "view contact" on a
saved contact card in the inbox) now opens the customer page at
`/contacts/<id>`; the side sheet is gone. The page carries the header
actions (send message, send template, edit), notes, details and custom
fields, deals and consent. Actions follow the role: delete is
admin-only. The full phone number is shown, a contact that does not
exist or that you cannot see answers "not found or no access", and the
top bar shows the right title on the page. Old `/contacts?c=<id>` links
redirect to the page.

### Only team leaders and admins create video meetings

Agents and viewers can no longer schedule or start a video meeting; they
join the meetings they are invited to and the ones open to the whole
workspace. The *New meeting* buttons (Meetings page, the calendar's
Create menu and "Video meeting instead" in the event dialog) are hidden
for them, and the API answers 403. Existing meetings keep their host.

**Migration required:** `supabase/migrations/111_meeting_creators.sql`.

### Meeting and push access fixes

- Someone removed from a video meeting no longer sees it at all until
  they are let back in: not the meeting, its people, its chat, its
  calendar entry or its reminders. Before, only rejoining and posting
  were blocked.
- Removing an admin from a meeting, and keeping admins in a meeting when
  invitees change, now go by the person's real workspace role. Before,
  the check read an old profile field that any user could set on
  themselves.
- A team-chat message that is deleted or edited before its push
  notification goes out is no longer pushed with its old text.

**Migration required:** `supabase/migrations/112_meeting_push_access.sql`.

### Calendar look

The day and week views show their hour labels again (an overlay had
been painting over them) and open an hour before the current time, with
a red marker showing the time now. Event chips show the title, the time
range, the location and the number of invitees; meetings and tasks carry
an icon. Month cells show each item's start time before its title, day
and week headers show the weekday above a large date, and the toolbar
shows the current time and the calendar's time-zone offset.

### Push notifications (database side)

The database now queues web push notifications: for every bell
notification (except the team-chat ones), for every team-chat message
in a channel you belong to (not your own; a muted channel only when you
are @mentioned), and for each inbound WhatsApp message (to the
assignee, else the people on that number, else owners and admins).
Each person's devices and preferences (on/off, per kind, quiet hours)
are stored per login, across workspaces.

**Migration required:** apply `supabase/migrations/109_push.sql` (as a
superuser or BYPASSRLS role: its triggers read the RLS-forced team-chat
tables). It adds `push_subscriptions`, `push_preferences` and
`push_outbox`, triggers on `notifications` and `internal_messages`, and
the service-role functions `push_enqueue`, `push_whatsapp_inbound`,
`push_claim`, `push_settle` and `push_purge`.

### Push notifications are delivered

The server now sends those queued pushes: a loop in each production
server process (every 3–10 s) plus a once-a-minute pass on the
automations cron, which also purges old outbox rows. Inbound WhatsApp
messages are queued as they arrive, rate-limited senders included. Set
`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` (server only) and
`VAPID_SUBJECT` to switch it on; see `docs/push.md`.

### Calendar (API and reminders)

Events can be read, changed and deleted by their organiser through
`/api/calendar/events/[id]`, either one occurrence of a repeating event
("this event") or the whole series ("all events"); a change that
collides with someone else's is refused rather than overwriting it. The
automations cron now rings calendar reminders once a minute (events,
meetings 10 minutes before and at the start, tasks 15 minutes before
due). See `docs/calendar.md`. Requires migration 108 (below).

### Calendar (database)

The database side of the staff calendar: events with attendees,
recurrence (an RRULE expanded in the app), per-person reminders, and
bell notifications for invitations, changes, cancellations and
responses, plus reminders for events, scheduled meetings and tasks due
in 15 minutes (`task_due`, reserved since 085, is now sent). Only an
event's creator may edit or delete it, admins included. Bank guests
never see the calendar.

**Migration required:** apply `108_calendar.sql` (as a superuser or
BYPASSRLS role). Reminders are rung by `calendar_reminder_sweep()` on
the service role; nothing calls it until the app's cron does.

### Video meetings

Staff can hold video meetings in the CRM at `/meetings`: schedule one
with invitees (each gets a bell notification) or press **Start now**,
then talk in an in-call grid with microphone, camera and screen share.
The host or an admin can end a meeting for everyone. Bank guests never
see meetings. Media runs through Cloudflare Realtime SFU; a 6-person
video meeting is roughly 15-20 GB of Cloudflare egress per hour (an
estimate), and the first 1,000 GB a month are free.

**Migration required:** apply `106_meetings.sql` (as a superuser or
BYPASSRLS role). Set `CLOUDFLARE_CALLS_APP_ID` and
`CLOUDFLARE_CALLS_APP_SECRET` (Cloudflare dashboard, Realtime, SFU)
in the server environment, never `NEXT_PUBLIC_*`, and restart. Without
them meetings can be scheduled but joining answers 503
`meetings_not_configured`. See docs/meetings.md.

### Video meetings: a removal sticks

Someone the host (or an owner or admin) removes from a meeting now stays
out for the rest of it: rejoining and the room's chat are refused until
the host lets them back in from **People → Removed → Let back in**.

**Migration required:** apply `110_meeting_removal.sql` (as a superuser
or BYPASSRLS role). See docs/meetings.md.

### Calling from the CRM is switched off by default

The CRM no longer places calls unless it is built with
`NEXT_PUBLIC_PBX_OUTBOUND_CALLS=on`. While off, every Call / Call back
button and the Calls screen's Keypad are hidden, `POST
/api/pbx/calls/dial` answers 403 `outbound_calls_off`, and the call-back
dialler marks due requests `skipped`, leaving their CALLBACK tasks to a
person. Incoming calls, call logs, recordings, voicemail and in-call
controls are unchanged. Set the variable and rebuild to turn calling
back on (docs/yeastar.md §11).

### Phone: Linkus features in the CRM

Agents can do from the Calls screen what they did in Yeastar's Linkus
app. No migration.

- **Dialling.** Every agent and above may dial any extension or outside
  number. Before, a typed number needed a team leader. Do-not-contact
  customers stay blocked; viewers and bank guests cannot dial. A blind
  transfer is unchanged: any extension, but an outside number below team
  leader only if it belongs to a customer you can see.
- **Keypad.** A dial pad on the Calls screen, with your recent numbers
  kept in your own browser.
- **Colleagues.** A directory of the phone system's extensions with each
  phone's state and a Call button.
- **Call from team chat.** A 1:1 direct message with someone who has an
  extension has a Call button.
- **My status.** A selector in the Calls header sets your extension's
  status on the PBX: available, away, business trip, do not disturb,
  lunch or off work.
- **Voicemail.** Your own extension's box: the first 100 messages, play,
  mark read, delete. Audio is streamed through the CRM, so the PBX's
  link and token never reach the browser.
- **Groups & queues.** Ring groups and queues with live agent state.
  Agents log in, log out and pause themselves; team leaders and above
  can do it for people in their workspace. Only groups with someone from
  this workspace are shown, and static agents cannot be logged in or
  out.
- **PBX setup.** The API application needs the extension update,
  voicemail, ring group, queue and agent permissions for these to work.
  See `docs/yeastar.md` sections 1 and 11 to 14.

### Calls: share a call into team chat

**Share to chat** posts a call card from three places: the Calls
screen, the customer page and the call wrap-up. It can go to a team or
private channel, or to a deal room's Team notes. It never goes to
WhatsApp.

- **What the card shows:** direction, who took the call, when, how
  long, the outcome, a short excerpt of the notes, and the customer with
  a link to their page.
- **Who sees it:**
  - Only colleagues who can see the call get the call's details.
  - The customer's name and link appear only to colleagues who can also
    see that customer; anyone else sees a masked number.
  - Everyone else sees only that a call was shared.
  - An erased call shows nothing.
- **Where it can't go:** a channel with a bank guest in it is never
  offered. A deal room's Team notes are offered, because guests never
  read them.
- **Wrap-up posts:** the wrap-up's "share call" used to post the
  customer's name and notes as plain text for every reader. It now posts
  the same card.

> **Migration required:** apply
> `supabase/migrations/103_chat_call_cards.sql` (re-runnable) as a
> superuser or BYPASSRLS role.

### Calls: unrouted calls for admins

A new **Calls → Unrouted** tab, for owners and admins, lists inbound
calls to a phone number that has no phone-system route. Until now, no
screen showed these calls.

- Calls are listed newest first, with the number that was dialled.
- Each number shows how many calls it received in the last 30 days and
  when the latest one came in, most recent first.
- A link opens Settings → Phone system → Routes, where a route can be
  added for the number.
- `GET /api/pbx/calls` takes `scope=unrouted` (refused below admin) and
  returns `didNumber` on every call.

### Phone system (Yeastar): event link health and a silence alert

- **Events card.** Settings → Phone system → **Events** now shows:
  - whether phone events are arriving: live, quiet for N minutes, or
    none yet;
  - whether they come by webhook or through the gateway;
  - how many of the PBX's 8 API sessions the CRM holds (at most one per
    credential);
  - the last time missing calls were filled in from the PBX's call
    records, how many were added, and how many could not be.

  An open page re-reads this about once a minute, so it doesn't go
  stale.
- **Silence alert.** If phone events stop for 15 minutes during working
  hours (09:00–20:00 Dubai), owners and admins get one bell. They get
  another when events resume. It only rings when events had already
  arrived earlier that working day. Webhooks have no heartbeat, so before
  the day's first event a quiet link can't be told apart from a call
  centre that opens late or is closed.
- **Event clock.** The "last event" time only moves forward, and a
  timestamp in the future is capped. A retried old event, or a wrong
  clock, can't make the link look live or silent when it isn't.

> **Migration required:** apply `supabase/migrations/104_pbx_health.sql`
> (re-runnable).

### Workspaces: archive and restore

An owner can archive a workspace from Settings → Workspace, and restore
it later from the **Archived workspaces** list on the same screen.

**What archiving does**
- Moves everyone working in the workspace to another of their
  workspaces.
- Revokes its invitation links.
- Stops its API keys. They work again after a restore.
- Closes its team chat, and its notifications leave everyone's bell.
- Nobody can open the workspace until an owner restores it. In the
  workspace rail its tile is dimmed for owners and hidden from everyone
  else.

**When archiving is refused** (the reason is shown):
- a WhatsApp number or the phone system is still connected;
- another workspace's phone routes or extensions point at it;
- someone works only in this workspace;
- the owner has no other workspace to move to.

`POST /api/workspaces/archive` does the same thing for scripts.

> **Migration required:** apply
> `supabase/migrations/105_workspace_archive.sql` (re-runnable) as a
> superuser or BYPASSRLS role.

### Automations: post to team chat

A new automation step, **Post to team chat**, posts a message into a
team or private channel as "automation", with the same `{{ … }}`
placeholders as Send message. It never posts into a DM, a deal room, an
archived channel, or a channel with a bank guest in it. The builder
leaves those channels out of its picker, and every run checks again.
Customer text copied into a post cannot add bold text or @mentions.
Each post records which conversation and contact it came from. If team
chat is off, the channel was archived or it no longer exists, the step
fails and the run log says why.

> **Migration required:** apply
> `supabase/migrations/102_automation_chat_post.sql` (re-runnable).

### Deal rooms: send files and call a participant

The deal-room composer now sends an image (JPEG or PNG, up to 5 MB) or
a document (up to 9 MB) to the group while its 24-hour window is open.
The file is kept in the deal file. The server checks that the file's
name and its first bytes match its type, which allows for
password-protected Office files, Unicode text and the types Windows
gives `.csv` and `.rtf`. Staff from agent up can call a participant
from the Members panel. The call rings their own desk phone, and the
customer's number is never sent to the browser. Do-not-contact
customers cannot be called. A bank officer can be called only while
that bank's guests are allowed, and the call is never recorded. The
call is refused while the workspace records calls with bank numbers,
unless that bank allows recording.

### Deal rooms: group costs, settings from WhatsApp, Team notes

- **Group costs per member.** Meta bills a group message once for each
  member it reaches, at that member's rate. The message cost tracker
  now records a group message per delivered member. The room's
  transcript shows the message's category and how many deliveries were
  billed, including receipts that arrived before the message was
  recorded. A repeated receipt counts once.
- **Group settings from WhatsApp.** A subject, description or
  join-approval change made in WhatsApp is copied onto the room, and its
  Team notes channel is renamed to match.
- **Team notes.** The room's Team notes get a short note when someone
  joins or leaves, a join request is waiting, the room is suspended or
  cleared, or the room is closed.
- **STOP in a group.** A member who writes STOP gets one Team note. It
  says whether their contact was marked opted out, could not be marked,
  or was not found. The contact is found however its number was saved,
  including local forms such as `050…`. If removing the member from the
  group fails, the transcript says so.

> **Migration required:** apply
> `supabase/migrations/100_deal_room_costs.sql` (re-runnable) as a
> superuser or BYPASSRLS role.
>
> `051_whatsapp_message_costs.sql` changed too, so that a fresh replay
> of every migration still works. Do **not** re-run it on a database
> that already has it. If you ever do re-run 051, re-apply 100
> afterwards.

### Phone system (Yeastar): missed calls on the customer page

- **Who was rung.** A missed call on the customer page names everyone
  the call rang, not just one person. The missed-call task's fallback
  owner comes from the same list.
- **Missed-call draft.** The "Draft WhatsApp" offer on a missed call now
  follows the Settings → Phone system switch, which was saved before but
  never used. The offer is off unless switched on, and it is never shown
  for a do-not-contact or opted-out customer.
  - The draft greets the customer by name and opens in that chat's
    composer for a person to send. It is never sent automatically.
  - When the draft is sent, the server checks consent again and refuses
    it if the customer has since been marked do-not-contact or opted
    out.
  - Ordinary typed replies are unchanged.
- **Downloading recordings.** Team leaders and above can download a
  recording from the customer page. Agents can still play recordings.

### Phone presence on every person's dot

Team chat (DMs and member lists), the inbox assign picker and the
customer page now show each person's phone status live: red while on a
call, grey with a line on Do not disturb, away on away / lunch /
business trip, grey when off work; otherwise the app's own presence. A
status chosen on the phone no longer fades after ten minutes, a long
call stays red (the phone-system cron keeps it fresh), and remapping an
extension or switching its presence monitoring off moves or clears the
status at once. The customer page no longer shows people without a desk
phone as offline. Workspaces without a phone system are unchanged.

> **Migration required:** apply
> `supabase/migrations/101_pbx_presence_mapping.sql` (re-runnable).

### Team leaders invite agents and viewers

Team leaders can invite agents and viewers to their workspace by link
(Settings → Members) and see and revoke the links they made; adding
someone with a password, changing roles, deactivating and removing
people stay with owners and admins. An invitation link now stops
working once its creator can no longer grant that role (removed,
deactivated or demoted). The create-workspace dialog lists Admin and
Supervisor (team leader) separately.

> **Migration required:** apply
> `supabase/migrations/099_leader_invites.sql` (re-runnable).

### Phone system (Yeastar) — call wrap-up and mandatory outcomes

After a call ends, the call panel counts down two minutes to add the
outcome (Interested, Docs requested, Call back, Not eligible, Wrong
number) and a note, then closes by itself; it comes back after a
reload. A live call always takes the panel, and unfinished wrap-ups
queue behind it; the ringing card always stays on top. Team leaders
and up can make outcomes mandatory (Settings → Phone system): the
wrap-up then can't be closed without an outcome, and anyone who leaves
one out gets one bell reminder linking to the customer. Only calls that
end after the switch is turned on are owed.

> **Migration required:** apply `supabase/migrations/097_pbx_wrapup.sql`
> (re-runnable).

### Deal rooms — add people, cancel a stuck room, alerts

Managers of a room can add team members from the members panel (team
leaders and up can also add a bank officer login, for a bank whose
officers may join customer groups and that has an approved officer in
the room). A room stuck in *creating* can be cancelled; if WhatsApp
creates its group later, that group is deleted (never another room's).
Owners and admins are alerted when a room can't be created (including
when WhatsApp refuses the request) or its group is suspended or
reinstated. **Fixed:** adding a bank officer login now requires
managing the room.

> **Migration required:** apply
> `supabase/migrations/096_deal_room_people.sql` as a superuser or
> BYPASSRLS role (re-runnable).

### Phone system (Yeastar) — recording retention, legal hold, call report

- **Recording retention is enforced.** Recordings older than the
  workspace's retention period (Settings → Phone system → Recording
  rules) are deleted by the phone-system cron, on every run (usually
  each minute); the call, its notes and its outcome stay. Age is counted
  from the later of the PBX's start time and when the CRM recorded the
  call, so a wrong PBX clock can't make a fresh call look old. A period
  only deletes once an admin has **confirmed** it: saving a first or
  shorter period shows how many recordings it would delete now and asks
  first, and the server refuses an unconfirmed shortening (so a stale
  tab can't shorten it unasked). A period saved before this release is
  *not* enforced until an admin saves it again.
- **Legal hold.** Owners and admins can place or lift a legal hold on a
  call's recording from the customer page, with a reason of at least
  five characters; every change is audited. Held recordings are skipped
  by retention and by the owner's erasure. Lifting a hold on a recording
  already past the period warns that it will be deleted.
- **Calls → By person** (team leaders and up): a per-person call report
  for today, this week, this month or up to 92 custom days — answered,
  outbound, missed, talk and ring time, outcomes — and a workspace
  total. Team leaders see their teams and themselves.

> **Migration required:** apply
> `supabase/migrations/093_pbx_recording_retention.sql` and
> `supabase/migrations/098_pbx_call_report.sql` (both re-runnable).

### Phone system (Yeastar) — incoming-call card and the Calls screen

- **The incoming-call card no longer shows the wrong customer's facts.**
  The next caller's card used to show the previous caller's owner, deal,
  last message and consent until its own load landed, and a customer the
  ringing agent may not see showed as "No owner · Calls OK" even when on
  do-not-contact. Facts now belong to their customer and call; for a
  hidden customer the card shows only the name, the owner and the
  consent ("Do not contact" / "Opted out"), and never "Calls OK" for
  them. The last WhatsApp time carries its date when it isn't today, and
  the card says "Owned by …" when the customer belongs to someone else
  ("Transfer to owner" appears only when that owner has an extension and
  isn't you).
- **Create contact for a new caller** opens the contact form with the
  caller's number filled in, beside the ringing card (Answer and Decline
  stay usable, and an Escape elsewhere doesn't close it), and links the
  new contact to the call even if the call ended meanwhile.
- **The ring timer** counts from when the call (last) started ringing,
  on the database clock, so it survives a reload, a transfer and a
  skewed browser clock.
- **Calls** is in the sidebar for staff once the phone system has an
  extension, with a badge for open missed-call tasks; bank guests are
  turned away from /calls on the server. Call back (on a missed call and
  on the customer page's task strip) is disabled for a do-not-contact
  customer and shows the reason; owners and admins can still call with a
  logged reason. Missed calls from numbers with no contact can be called
  back by team leaders and up.

> **Migration required:** apply
> `supabase/migrations/094_pbx_call_live_rang_at.sql` (re-runnable).

### Deal rooms from the customer, the deal and the inbox

Deal rooms can now be opened from the customer page, a deal's sheet in
Pipelines and the inbox contact panel. Each lists that customer's (or
deal's) rooms and offers **New deal room** with the customer (and deal)
filled in. Shown only while the workspace has a Meta number, never to
bank guests.

### Fixed

- **Team chat:** Saved items and Settings → Team chat's list of private
  channels to read never loaded (an ambiguous database query: PostgREST
  refused it).
- Settings → Phone system → Bank numbers: saving the list deletes only
  the numbers the admin removed. Before, saving could delete numbers
  that were added after the screen was loaded.
- A broadcast's page now shows "Broadcast not found" for a deleted,
  hidden or mistyped broadcast, instead of a raw database error.

### Team chat: channel settings, mute and edit history

Channel admins, and workspace owners and admins (in a private channel
only as members), can now rename a channel, change or clear its topic,
archive and unarchive it from the gear menu in the channel header, and
remove members from the members panel; every change is audited.
Archived channels sit in a collapsed **Archived** group in the channel
list and open read-only. Anyone can mute a channel or DM from the same
menu: a muted chat rings the bell only for a direct @mention, is dimmed
in the list, and its plain unread no longer counts in the Team chat or
workspace badges. Owners and admins can view an edited message's
earlier versions. A viewer is told that agents and above open deal
rooms (it used to say "coming soon"), shared conversation cards open a
team leader's team inbox, and the audit log shows a channel edit's old
and new name and topic. See `docs/internal-chat.md`.

> **Migration required:** apply
> `supabase/migrations/091_chat_channel_admin.sql` as a superuser or
> BYPASSRLS role (re-runnable). It changes `chat_unread_counts`'s return
> type, so re-running 087 after it fails: re-run 091 afterwards.

### Workspaces: rename, and an audit log of membership changes

**Settings → Workspace** lets admins rename the workspace and change the
short name on its rail tile; the rail and headers update without a
reload (`PATCH /api/account` now accepts `short_name`). **Settings →
Audit log** gains a *Workspace* source: members added, removed,
re-roled, deactivated or reactivated, a bank guest's bank changing,
renames, ownership transfers, and team chat switched on or off. Only the
workspace's owners and admins can read it; it is append-only. See
`docs/workspaces.md`.

**Fixed:** Settings → Team chat's on/off switch failed with "permission
denied" for everyone (migration 057's column grants on `accounts`
predate the column).

> **Migration required:** apply
> `supabase/migrations/092_workspace_audit.sql` as a superuser or
> BYPASSRLS role (re-runnable).

### Notifications

The notifications page now lists every workspace's notifications, as
the sidebar badge counts them; a row from another workspace shows that
workspace's name, and opening it switches there and opens its screen.
Clicking a notification opens its screen for every kind: missed calls
and tasks the customer page, deal-room events the room, channel alerts
the WhatsApp settings (admins), team-activity alerts Team activity (team
leaders too). Each kind has its own icon. "Mark all read" covers what
the page lists.

### Fixed

- **Deal rooms:** a team leader can approve or reject a bank officer
  only in a room they manage (any team leader could, by id); a create
  that WhatsApp refused closes the form instead of inviting a second,
  duplicate room; join requests show in the open room as they arrive.
  > **Migration required:** apply
  > `supabase/migrations/095_deal_room_approve_scope.sql` (re-runnable).
- **Background jobs:** a once-a-minute job on the automations cron
  (journey tick, phone system) skipped a minute whenever the pinger's
  request landed a few milliseconds early, so it ran about every two
  minutes.
- **Error pages:** a crashed screen keeps the sidebar and offers *Try
  again*; an unknown address shows a 404 page with a link home (it used
  to be Next's bare default page).
- **Bank guests** no longer get a 403 from `/api/pbx/me` on every page.
- The invitation page's sign-in buttons are valid links (a button was
  nested in a link).

### Phone system (Yeastar) — pause storing recordings

Admins can pause the CRM's copies of call recordings, for a server
with little disk: **Store call recordings on this server**, the first
switch under **Recording rules** in the phone-system settings. While it
is off the CRM stops downloading recordings; nothing on the PBX
changes, and Yeastar keeps recording calls as before. Calls that end
meanwhile are not downloaded later, and the customer page shows
"Recording not stored in the CRM. It is still on the PBX." Recordings
already stored stay. See `docs/yeastar.md`, section 8.

> **Migration required:** apply
> `supabase/migrations/090_pbx_recording_storage.sql` (re-runnable)
> **before** deploying the app.

### Phone system (Yeastar) — browser softphone

Agents whose softphone is switched on can answer, decline and control
calls in the CRM tab through the Yeastar Linkus SDK for Web, which the
operator hosts (`NEXT_PUBLIC_LINKUS_SDK_URL`; the PBX's address goes in
`NEXT_PUBLIC_PBX_ORIGIN`, both build-time). Without it, calls keep
ringing the desk phone. The Content-Security-Policy now also allows a
self-hosted Supabase origin for media, so recordings keep playing once
the policy is enforced. See `docs/yeastar.md`, section 12.

### Phone system (Yeastar) — database

The database for the Yeastar P-Series phone system. Calls land on the
customer's timeline next to their WhatsApp chat (direction, number,
extension, ring and talk time, outcome and notes); an agent sees the
calls they were on and those of customers they can see, team leaders
and up every call of the workspace, bank guests none. Recordings are
kept in a private storage bucket no browser can read: every play is
logged, and playback is held until the English/Arabic recording notice
is confirmed played (a workspace can switch that requirement off). It
also holds PBX connections (credentials encrypted, service role only),
number routing, extension mapping, the live screen pop and presence.
The owner can erase a customer's call records on request, unless a
recording is under legal hold. Missed-call tasks come with the event
processor.

> **Migration required:** apply `supabase/migrations/089_pbx.sql`
> (re-runnable) **before** deploying the app.

### Deal rooms

A deal room is a real WhatsApp group on the workspace's verified Meta
number, made from the chat screen for one customer and, optionally,
one deal. The customer's consent is recorded before any group exists,
and a group holds at most 8 members including the business number.
People who opted out or are marked do-not-contact are refused.

- **Invites.** Each person gets the group's invite link in their own
  1:1 chat, as the group-invite template an admin picks in Settings →
  Deal rooms. A join request from an expected number is approved
  automatically; any other waits for the relationship manager.
- **Messaging.** Free text goes out inside the group's 24-hour reply
  window (any member's message opens it for everyone) and approved
  templates outside it. Files members send are saved to the deal file
  automatically.
- **Close room.** Saves a transcript to the deal file, removes everyone
  and deletes the group. A room stuck in "creating" is finished or
  failed by a background job (`/api/deal-rooms/cron`, also run every 2
  minutes by the automation cron).
- **Bank officers** can join only for a bank whose DSA terms an admin
  has checked, and an agent's bank officer waits for a team leader's
  approval. Members never see each other's phone numbers in the CRM,
  and a bank guest sees only the names, roles and messages of their own
  rooms. Each room also has a staff-only Team notes tab that never
  reaches the group.

Subscribe the Meta app to the four `group_*` webhook fields and use a
Meta number that is an Official Business Account; setup is in
`docs/meta-cloud-api.md` (Deal rooms).

> **Migration required:** apply `supabase/migrations/088_deal_rooms.sql`
> (re-runnable; re-apply if you applied an earlier copy — it gained the
> `deal_room_settings` table) **before** deploying the app.

Admin routes for the phone system: extension sync and mapping, number
routing to workspaces, recording settings and bank numbers
(`/api/pbx/*`, no new migration); operator notes in `docs/yeastar.md`.

Phone-system event processor and the signed webhook
(`POST /api/pbx/yeastar/events/{token}`): calls, the screen pop,
presence, recordings to fetch, and a task plus bell for each missed
call. `089_pbx.sql` gains `calls.recording_file` and `calls.meta`
(re-runnable; re-apply it if you applied an earlier copy).

### Phone system (Yeastar) — recordings, call-backs, cron

`GET /api/pbx/cron` (also run by the automations cron, once a minute)
copies pending recordings into private storage, dials due call-backs
between 09:00 and 20:00 Dubai time from the owner's free extension,
retries failed events (three times), and purges old rows. A call-back
left _dialing_ for 30 minutes with no result (a restart mid-dial, or a
lost call-end event) is released on the next run, at any hour: settled
from the call's record if it ended, left alone while the call is still
on, otherwise counted as one unanswered attempt. See
`docs/yeastar.md` (sections 7–10).

> **Migration required:** `089_pbx.sql` gained
> `pbx_events_raw.attempts` and `callback_requests.pbx_call_id`, and
> `pbx_purge()` now drops events that failed all retries after 30 days.
> Re-apply the file (it is re-runnable).

Calling from the CRM: call lists, this month's totals, team presence,
recording playback (5-minute links, downloads for team leaders and up,
every access logged, held until the notice is confirmed) and attaching
a recording to a deal as a reference; no new migration. See
`docs/yeastar.md` section 11.

### Internal team chat

Slack-style chat for the team, inside each workspace: open team
channels, private channels, direct messages and group DMs (up to 8
people), one-level threads, @mentions (including @channel and @here),
reactions, pins, saved messages, unread counts and search that works for
Arabic and English. A customer's WhatsApp conversation can be shared
into a channel as a read-only card; the card shows its live status only
to people who can open that chat in the inbox. Mentions and direct
messages ring the notifications bell. Nothing typed in a channel can
reach WhatsApp. Owners and admins can read a private channel they are
not in only through an audited action that records the reason, and an
owner can erase one person's messages on a lawful request. Internal
chat can be switched off per workspace.

> **Migration required:** apply
> `supabase/migrations/087_internal_chat.sql` (re-runnable)
> **before** deploying the app.

### Edge security for the WhatsApp webhooks

Both WhatsApp webhooks (Whapi and Meta) now screen every authenticated
delivery against Postgres stores that every app instance shares, so
limits and clocks agree across instances: replay keys per number (a
redelivery within 24 hours is skipped), 4 messages per second per sender
(a message over the limit is kept in the inbox but not auto-answered)
and an IP sanity limit. The webhooks never answer 429; a delivery whose
event another delivery is still processing is answered 503, so the
provider redelivers it. Behind a proxy, set `EDGE_CLIENT_IP_HEADER`
(`cf-connecting-ip` behind a Cloudflare tunnel) and, for
`x-forwarded-for`, `EDGE_TRUSTED_PROXY_HOPS`; see _Edge security_ in
`docs/whapi.md` and `docs/meta-cloud-api.md`. The automations cron
purges expired rows at most every 15 minutes (or schedule
`SELECT public.edge_purge()` with pg_cron); correctness does not depend
on it.

Sign-in now goes through `POST /api/auth/login`, which locks out 5
failures per email and IP, or 20 per IP, within 10 minutes for 15
minutes, before GoTrue sees the password; the login page shows "Try
again in N minutes". The public API locks out an IP that presents bad
keys the same way, answering `429 rate_limited`. See `docs/security.md`.

> **Migration required:** apply
> `supabase/migrations/084_edge_security.sql` (re-runnable)

### Journey bot: WhatsApp journeys from first message to closed deal

In the app: each customer's panel in the inbox shows their journey —
stage, reply window, next reminder and the advisor decisions that stage
accepts — next to their marketing consent and do-not-contact flag; a
**Journeys** page shows every journey by stage; and **Settings → Journey
bot** switches the bot on, checks which templates are still missing or
unapproved, and edits the bot's session messages and button titles.

The journey bot (module 016, "Welcome to Close") now answers on
WhatsApp for accounts whose admin switches it on (`enabled` in
`PUT /api/journeys/settings`):
it welcomes the customer, pitches a POS terminal, business account or
business loan, and walks them through quote or eligibility,
documents, the partner's decision and fulfilment, parking quiet
customers and re-engaging them once. Advisors record the steps only a
person can take — quote ready, fit, documents complete, partner
approved, close with a reason — through the new journey APIs
(`/api/journeys`, `/api/journeys/{id}/advisor`, `/api/journeys/start`
for a cold start, `/api/journeys/settings`). Marketing messages go
only to customers with a recorded opt-in, and STOP / UNSUBSCRIBE (and
the Arabic equivalents) opt out at any point. Contacts gain a consent
register beside the existing opt-out — a marketing opt-in, which
always names its source, and a do-not-contact flag — with an
append-only history. A STOP reaches the contact's opt-out at once,
even while the journey bot is off, and only an admin can change or
clear a do-not-contact. "Call me back" opens an advisor task and queues
a callback request for click-to-call. Timers and quiet-hours sends run
from `GET /api/journeys/cron`, which the automation cron also runs
every minute. The templates the bot needs, its timing and consent
rules are in `docs/journey-bot.md`.

> **Migration required:** (re-)apply
> `supabase/migrations/086_journeys.sql` — it is re-runnable and has
> gained columns since it was first published (journey copy, delivery
> claims).

### Workspaces: one login, several businesses

A workspace rail at the far left of the sidebar shows every workspace
you belong to (with unread chat badges); click one to switch, or use
**+** (owners and admins) to create a workspace and invite its first
people, choosing Admin, Team leader, Agent, Viewer or Bank guest.

A person can now belong to more than one workspace (account) — for
example Taamul Credit and TrafeeqPay — with a separate role in each,
and switch between them. Each workspace keeps its own contacts, chats,
numbers and settings apart: everything you see follows the workspace
you are working in. Teams and number allocations survive switching.
An existing login can be added by email only by an owner or admin of a
workspace that person is active in, and someone removed from their only
workspace leaves as a viewer (a bank guest as a guest) of an empty one,
never its owner.
An owner or admin can create a new workspace and add its first people
in one step, and adding a member by an email that already has a login
adds that person to your workspace, with no new password.

Someone in more than one workspace switches from the sidebar; the app
reloads in the chosen workspace, and other open tabs follow. See
`docs/workspaces.md`.

A new role, **Bank guest**, is for bank officers invited into deal
rooms and channels: a guest sees none of the inbox, contacts, deals or
settings.

> **Migration required:** apply
> `supabase/migrations/082_account_role_bank_guest.sql` and then
> `supabase/migrations/083_workspaces.sql` (both re-runnable, in that
> order, each in its own run — 082 adds an enum value that 083 uses)

### Tasks: call-backs and follow-ups on contacts

A shared task list for the follow-ups that used to live in someone's
head or a chat note: call a customer back, chase a document, follow
up on a deal. A task has a title, an optional note and due date, an
assignee, and can be linked to a contact, a chat and a deal. People
create tasks themselves; the phone system (a missed call) and the
journey bot (an advisor step) open them automatically, once per
event, so a redelivered webhook never opens a second task. Assigning
a task to someone else rings their bell; assigning it to yourself
does not. A task follows its customer the way chats do: you see the
tasks you hold or created and those on contacts you can see, a team
leader also their team's, admins every task. See `docs/tasks.md`.

> **Migration required:** apply
> `supabase/migrations/085_tasks.sql` (re-runnable)
> **before** deploying the app.

### AI agent: approved answers only, and a sensitive-data warning

A new answer mode for the auto-reply bot, **Approved answers only**:
the bot never writes text. It sends one answer an admin approved, word
for word, or hands the chat to a person. Answers are imported from the
review spreadsheet (sheet `Knowledge_Base`); only rows marked Approved
are ever sent, and an answer still saying `[TO CONFIRM …]` cannot be
approved. A file without a Status column that edits an approved answer
files it as To confirm until it is approved again. TypeSafe picks the answer from a shortlist; a pricing, legal
or angry message, a weak match (below the minimum score, 0.8 by
default), a missing Arabic answer, or TypeSafe being unavailable all
hand the chat to a person. Answers for internal staff never reach
customers. The mode needs `TYPESAFE_API_KEY` and the account in
`TS_ACCOUNT_IDS`. See `docs/ai-agent.md`.

In either mode, an optional **sensitive-data reply** is sent instead of
an answer when a customer shares an Emirates ID, a card number or an
IBAN. The default mode and settings are unchanged.

> **Migration required:** apply
> `supabase/migrations/081_approved_answers.sql` (re-runnable)
> **before** deploying the app.

### AI safety check: no Central Bank or bank/lender claims

The AI reply guardrail now holds, for a person to review, any draft
that describes the business as registered with, licensed or regulated
by the Central Bank of the UAE (CBUAE), or as a bank or a lender —
in English or Arabic, whatever the knowledge base says (reason
`CODE_REGULATOR_CLAIM`). The one rewrite is told to describe the
business as a Dubai-based financial broking firm and Direct Sales
Agent working with UAE partner banks. No migration.

### Tagged campaign chats move to the Inbox

A chat in **Broadcasts → Campaign inbox** now moves to the **Inbox**
as soon as it is given a chat tag, and stays there while it carries
one — tagging a chat is filing it for the team. This covers tags set
from the chat header and by automations and Flows; removing the tag
puts a chat the bot is still answering back in the Campaign inbox.
Chats that already carry a tag move on upgrade. No migration.

### Broadcast audiences from Excel files

The broadcast wizard's **Upload CSV or Excel** audience now takes an
Excel `.xlsx` file as it is (the first sheet), so an export no longer
has to be re-saved as CSV — which is where long numbers turned into
`9.71505E+11`. Headers such as **Phone Number**, **Customer Name** and
**Company Name** are recognised alongside `phone`, `name` and
`company` (also when importing contacts from CSV), and every column
can still be mapped to a template variable. Rows without a phone
number are skipped and counted. A new option, **Numbers without a
country code are UAE mobiles (add +971)**, off by default, accepts
locally written UAE mobiles (`050 123 4567`, `501234567`); without it
they are refused as before. Old `.xls` workbooks are refused with a
request to save as `.xlsx` or CSV. No migration.

### Pipelines for every member, and deals from chat tags

Pipelines is now in every member's sidebar. Each deal belongs to one
person: its assignee, else whoever created it. Admins and owners see
every deal and can narrow the board to one person with **Showing**; a
team leader sees their own deals and their teammates' (**My team**,
**My deals**, or one teammate); everyone else sees only their own. The
database enforces this (`can_view_deal`), so the contact panel and the
dashboard's pipeline figures follow the same rule. Agents create and
reassign deals for themselves only, leaders for their teammates too.
Creating pipelines and editing stages stays admin-only.

In **Manage pipeline** an admin can link a stage to a main chat tag
(**Auto-add chats tagged**). When a chat is given that tag, with or
without a sub-tag, a deal is created in that stage for the chat's agent
(the person it is assigned to or who started it, else whoever tagged
it). The deal is never moved by later tagging, and no second deal is
made while the contact has an open one in that pipeline. Tags set by
automations and flows count too.

> **Migration required:** apply
> `supabase/migrations/080_pipeline_ownership_and_tag_deals.sql`
> (re-runnable) **before** deploying the app. Then link the stage you
> want (e.g. New Lead ← Interested customer) once in Manage pipeline.

### Settings reorganised

Settings is now a row of category tabs, each with sub-tabs. The URL is
`?tab=<sub-tab id>`; AI Agents uses `?tab=ai-<tab>`.

- **Overview**
- **My account**: Profile, Login & security, Appearance
- **WhatsApp**: Connections, Numbers & access, Routing, Templates,
  Message costs
- **Inbox**: Chat tags, Quick replies, Custom fields
- **Team**: Members, Teams
- **AI Agents**: Overview, Assistant, Auto-reply, Knowledge, Safety
  checks, Playground, Usage. The sidebar "AI Agents" link redirects here.
- **Integrations**: API keys, Deals & currency

Renames: "AI safety checks" is now Settings → AI Agents → Safety checks
(Partner banks sits under it); "Which number sends what" is Settings →
WhatsApp → Routing; the old AI Agents "Setup" is split into Assistant,
Auto-reply and Knowledge.

One home per setting, so duplicates are gone: team number access is set
only in Numbers & access (Settings → Teams shows it read-only); removing
a Cloud API number is in Numbers & access, like a Whapi one; the AI's own
number moved from Routing to AI Agents → Auto-reply → Reply on; the team
leader is offered the same way everywhere; Settings → Quick replies is
translated.

AI Agents fixes in the same release:

- Leaving AI Agents with unsaved changes (for another Settings tab, or
  by a link) asks first; moving between AI Agents tabs keeps the edits.
- **Reply on → Only on** always pins the AI to one number: Save writes
  the picked number (the default number when none was picked) as the
  AI's route. An account that never saved a route is not pinned, and
  its Overview now says so: "The default number and others of its
  type", not "Only on the default number".
- The embeddings key has a **Remove key** button (with a confirm).
  Focusing the masked key field no longer deletes the stored key on the
  next Save, and a blank key field never clears a key.
- On a phone the Settings and AI Agents tab rows fade at the edge where
  more tabs are hidden, and keep the active tab in view.

No migration required. Docs paths updated in `docs/`.

### Reply on every WhatsApp number

Settings → AI has a switch, **Reply on every WhatsApp number**. On, the
AI answers each chat on the number the customer wrote to (Whapi or Cloud
API); off, only on the number routed for AI auto-reply. A chat a person
pinned to another number is skipped. Settings → WhatsApp → Which number
sends what hints when the switch is on. See
[docs/ai-agent.md](./docs/ai-agent.md).

> **Migration required:** apply
> `supabase/migrations/079_ai_reply_all_numbers.sql` (re-runnable)
> **before** deploying the app. The bot tolerates a pre-079 database (it
> keeps answering on its routed number), but Settings → AI fails to load
> until 079 is applied.

### Partner banks, Important chats and open-question retrieval

Each account sets its own partner banks, chats the AI hands over are
pinned in the Inbox until a person acts, and the bot retrieves for the
customer's open question rather than only the last message. See
[docs/typesafe.md](./docs/typesafe.md) and
[docs/ai-agent.md](./docs/ai-agent.md).

> **Migration required:** apply
> `supabase/migrations/078_partner_banks_and_attention.sql`
> (re-runnable) **before** deploying the app. It adds
> `ts_account_settings.partner_banks` and `conversations.ai_attention_at`,
> and extends the 077 reply trigger to clear it. Without it, partner
> banks fall back to the built-in list (saving one answers "Partner
> banks need database migration 078") and the Important pin never
> shows, but a hand-off, **Take over**, **Resume** and sending or
> discarding a held draft also write `ai_attention_at`, so on a pre-078
> database those writes fail: the hand-off is not saved (the chat is
> not paused and gets no note) and the Take over, Resume and draft
> buttons return an error. Apply it without `-1` so the backfill does
> not hold table locks.

- **Partner banks.** Settings → AI safety checks → Partner banks: tick
  built-in banks (default Mashreq, RAKBANK, NBF, Wio, Ruya, UBL), add
  others with their abbreviations, or take suggestions from _Found in
  your knowledge base_. The guardrail blocks a draft naming any other
  bank, and the bot is told the list. Uploading a bank's documents does
  not make it a partner.
- **Important chats.** A chat the AI hands over is pinned at the top of
  the Inbox with a red Important label, an _Important · N_ filter, and a
  red bar with Take over and Resume. A person replying, taking over,
  resuming or acting on a held draft clears it.
- **Open-question retrieval.** Knowledge lookup uses every customer
  message since the bot last spoke; a "Hi" after an unanswered question
  still retrieves for the earlier question.
- **Changed.** Hand-off notes read as plain sentences ("🤖 AI needs a
  person ...").

### AI agent v2

The auto-reply bot gains model tiers with per-message routing, a
rewrite-then-review path for held drafts, pause and resume around people
replying, and a record of why it did or did not answer. See
[docs/ai-agent.md](./docs/ai-agent.md).

> **Migration required:** apply
> `supabase/migrations/077_ai_agent_v2.sql` (re-runnable) **before**
> deploying the app. The new code selects the new `ai_configs` columns,
> so on a pre-077 database the AI config load fails and the bot stops.
> It adds the Small and Large model tiers (filled once for existing
> accounts from the provider), the pause and auto-resume settings,
> `conversations.ai_paused_reason`, the held-draft columns, the
> `ai_reply_events` table and the `ai_handoff` notification type. Apply
> it without `-1` so the backfills do not hold table locks.

- **Model tiers.** Settings → AI has Small, Standard and Large models.
  *Route each message to the right model* (on by default) lets
  TypeSafe Jev judge each message in parallel with triage; without
  TypeSafe a simple rule decides. Greetings skip knowledge retrieval,
  but only when every customer message since the bot last spoke is
  one: "Hi" after an unanswered question retrieves for that question.
  Urgent or ready-to-apply customers never get the Small model. A model
  the provider rejects is retried once on the Standard model.
- **Held drafts.** A draft the TypeSafe guardrail holds is rewritten
  once by the Large model; if it is still held, the chat goes to a
  person with the draft in the inbox banner (Send draft, Edit, Discard).
- **Pause and resume.** A person replying in a chat pauses the bot
  there. *Give the chat back to the AI after* resumes it on the
  customer's next message. Hand-offs and Take over never auto-resume.
  The banner shows why the bot is paused and offers **Resume & reply**.
- **Why didn't the AI reply?** Every dispatch records an outcome; the
  banner says why the last message went unanswered, and Settings → AI
  shows a 7-day activity card.
- **Fixed.** The bot no longer stands down for every message when any
  keyword automation exists, only when one matches. Two quick messages
  get one reply that answers both (`AI_BURST_WAIT_MS`, default 3 s). A
  WhatsApp send failure after the bot drafted a reply now hands the chat
  to a person. Hand-offs ring a bell for owners and admins when no
  hand-off agent is set.

Adds an optional **second WhatsApp number** on Meta's Cloud API,
alongside the existing Whapi channel, with an admin selector for which
number sends what.

> **Migration required:** apply
> `supabase/migrations/046_multi_channel_whatsapp.sql` (lets
> `whatsapp_config` hold one row per provider per account, records which
> number carried each message, and adds the `whatsapp_routes` table
> behind the selector). Existing installs keep working unchanged: the
> single connected channel becomes the account default and every task
> inherits it.

> **Migration required:** also apply
> `supabase/migrations/047_ai_knowledge_fts_any_term.sql`. Keyword
> search over the AI knowledge base previously required _every_ word of
> the customer's question to appear in a chunk, so a natural question
> almost never matched and accounts without an embeddings key ran the
> bot with an effectively empty knowledge base.

> **Migration required:** and
> `supabase/migrations/048_campaign_conversations.sql`, which records on
> each conversation the campaign the customer replied to. The Campaign
> inbox and the bot's campaign context both read it.

> **Migration required:** and
> `supabase/migrations/049_ai_auto_reply_campaign_only.sql` for the
> _Campaign replies only_ switch on the AI agent (off by default).

> **Migration required:** and
> `supabase/migrations/050_contact_card_messages.sql`, which adds the
> `contacts` message type and the `contact_cards` column that shared
> contact cards are stored in.

> **Migration required:** and
> `supabase/migrations/051_whatsapp_message_costs.sql` for the
> message-cost ledger behind Settings → Message costs (the rate card,
> the market map, the per-message ledger and its reporting views).
> Optional afterwards: load Meta's full rate card with
> `scripts/load-meta-rate-card.ts`.
>
> If you applied 051 before this change, **apply it again** — the file
> is re-runnable and `record_whatsapp_message_cost` has been corrected
> (see _Fixed_ below). Deliveries already in the ledger keep the
> category and cost they were written with; re-run only affects
> receipts that arrive afterwards.

> **Migration required:** and
> `supabase/migrations/052_ai_escalation_gates.sql` for the escalation
> gates on the AI agent (keyword list, retrieval threshold, strict
> grounding, handoff message, the handoff reason on conversations, and
> the `ai_knowledge_gaps` log). Every gate is off by default, so an
> existing install behaves as before until an admin turns one on.

> **Migration required:** and
> `supabase/migrations/053_broadcast_scheduling.sql` for scheduled
> broadcasts and quiet hours (`header_media_url`, `quiet_hours`, and
> the index the scheduler reads). **Scheduled campaigns are delivered by
> `GET /api/whatsapp/broadcast/cron`** — point your pinger at it
> alongside the automation and flow crons, same `x-cron-secret`
> header. Until it is pinged, a scheduled campaign stays _scheduled_
> and its page offers _Send now_.

> **Migration required:** and
> `supabase/migrations/054_campaign_flow_continuation.sql` for
> campaigns that continue as a conversation (`follow_up_flow_id` on
> broadcasts, `broadcast_id` on flow runs, and the `cap` handoff
> reason). Existing campaigns and flows behave exactly as before until
> a campaign is pointed at a flow or a flow's off-script setting is
> changed — with one exception noted under _Changed_: the AI agent now
> hands off at its reply cap instead of going silent.

> **Migration required:** and
> `supabase/migrations/055_message_forwarding.sql`, which adds
> `messages.is_forwarded`. Both webhooks and every outbound send write
> it, so **apply it before deploying this build** — without it every
> message insert fails.

> **Migration required:** and
> `supabase/migrations/056_compass_integration.sql` for the Taamul
> Compass integration (the `compass_contacts` and
> `compass_notifications` tables). Nothing else depends on it; until it
> is applied only the `/api/v1/compass/*` endpoints and the Taamul
> Compass screen fail.

> **Security — action required on every self-hosted install:** disable
> public signup in GoTrue (`DISABLE_SIGNUP=true`,
> `ENABLE_PHONE_SIGNUP=false` in a self-hosted Supabase `.env`, or turn
> off "Allow new users to sign up" in the dashboard), then restart the
> auth service. The app has no signup screen, but GoTrue's own
> `/auth/v1/signup` stays open by default and hands anyone with the
> public anon key a session — and, before 057, a phone signup could
> use it to make itself owner of any account. Members are provisioned
> with the service role and keep working. See `docs/docker.md`.

> **Migration required:** and
> `supabase/migrations/057_security_hardening.sql`. Closes schema holes
> reachable with the public anon key: profile self-insertion into any
> account, anonymous listing of every tenant's files in the
> `chat-media` / `flow-media` / `avatars` buckets, a cross-tenant read
> of the AI knowledge base (047 had undone 032's fix), and
> `SECURITY DEFINER` helpers any client could call to exhaust a
> conversation's AI reply cap, disable a webhook or rewrite broadcast
> counters. Also makes `ai_configs`, `webhook_endpoints` and
> `api_keys` admin-only to read, scopes `flow_runs` and
> `broadcast_recipients` like the conversations they describe, and
> stops an agent opening a thread on a contact they can't see.

> **Migration required:** and
> `supabase/migrations/058_dashboard_aggregates.sql` — the dashboard
> charts are now computed in SQL instead of downloading every message
> of the last 30 days into the browser (which was also silently wrong
> past 1,000 rows). **Apply before deploying this build**, or the
> dashboard charts fail to load.

> **Migration required:** and
> `supabase/migrations/059_rls_performance.sql`. Rewrites the
> conversations / messages / contacts row-level-security policies so
> Postgres can use an index on `account_id` instead of scanning every
> tenant's rows and calling the visibility function per row — who can
> see what is unchanged — and adds the indexes the inbox, thread,
> contacts list and inbound webhook were missing.

> **Migration required:** and
> `supabase/migrations/060_whatsapp_channel_access.sql` for multiple
> Whapi numbers. It lets `whatsapp_config` hold any number of Whapi rows
> (the Meta number stays one per account), records the exact number on
> every conversation and message (`channel_id`), and adds
> `whatsapp_channel_members` plus the visibility rule behind number
> allocation. **Apply before deploying this build**: the send and
> inbound paths write `channel_id`. Existing installs are unchanged
> until an admin allocates someone to a number, because a number with
> nobody on it stays shared.

> **Migration required:** and
> `supabase/migrations/061_conversation_send_channel.sql` for choosing
> a chat's sending number. It adds `conversations.send_channel_id`, the
> `conversation_events` table (the notes in the thread) and the
> `set_conversation_send_channel` function, and extends the visibility
> rule. **Apply before deploying this build**, because the send path
> reads `send_channel_id`. Every existing chat stays on automatic.

> **Migration required:** and
> `supabase/migrations/062_channel_access_hardening.sql`, from a
> security and correctness review of 060 and 061:
> - Allocations and a chat's number or pin are tied to their own
>   account by composite foreign keys.
> - The number guards now run when a chat is created, not only when it
>   is edited.
> - A pin can only be set through the chat's number picker, so every
>   pin leaves a note.
> - Signed-in users can no longer insert customer messages.
> - Access lists and the default number are each saved in one
>   transaction.
> - The visibility check is one flat function again, for speed.
> - A tiny index backs the media proxy's new visibility check.
>
> **Apply before deploying this build**, because the app calls
> `set_channel_members` and `set_primary_channel`.

> **Migration required (before deploying this build):** apply
> `supabase/migrations/065_channel_health_notifications.sql`. It lets
> the notifications table hold the new *number disconnected* /
> *number reconnected* alerts. Without it no alert can be stored:
> each sweep marks a logged-out number disconnected, cannot save the
> alert, puts the status back and logs `[channel-health] … the alert
> was not saved`, so the number keeps showing connected; a number that
> comes back is marked connected without its notice.

> **Migration required (before deploying this build):** apply
> `supabase/migrations/066_broadcast_status_reconcile.sql`, then run
> once, as postgres, `SELECT public.reconcile_broadcast_recipient_statuses(NULL, '60 days');`
> to repair older campaigns. It adds
> `reconcile_broadcast_recipient_statuses()`, which replays Meta's cost
> ledger onto broadcast recipients a delivery receipt missed (a receipt
> that arrived before the recipient was recorded left it at *sent*),
> stores Meta's failure reason on failed recipients, and marks a
> campaign whose recipients all failed later as *failed*. The app runs
> it after each delivery pass and on every broadcast cron tick, and
> skips it quietly until the migration is applied.

> **Migration required:** apply
> `supabase/migrations/076_contact_opt_out.sql` (re-runnable) **before**
> deploying the app. It adds `contacts.opted_out_at` (when a customer
> asked not to be messaged) and fills it from any existing `opted-out`
> contact tag. Every broadcast now leaves those customers out, and only
> an admin (or the AI bot) can set or clear the mark. The
> `tags` / `contact_tags` tables are left in place, unused.

> **Migration required:** apply
> `supabase/migrations/075_chat_tags.sql` (re-runnable) **before**
> deploying the app. It adds the `chat_tags` table (admin-defined,
> colour-coded main tags with optional sub-tags, one level deep) and
> `conversations.chat_tag_id` / `chat_sub_tag_id`. A chat carries at
> most one main tag and one sub-tag of it; the database refuses any
> other pair, and switching a chat's main tag drops its old sub-tag.
> Deleting a main tag deletes its sub-tags and clears them from every
> chat. Members read the list, admins and owners edit it.
> `conversations.status` is unchanged, so automations and the public
> API keep working as before.

> **Migration required:** apply
> `supabase/migrations/073_team_activity_accuracy.sql` and then
> `supabase/migrations/074_team_activity_team_leaders.sql` (both
> re-runnable), before deploying the app.
> - 073 corrects the Team activity figures. Its one-time backfill fills
>   `messages.channel_id` / `conversations.channel_id` where the number
>   was unambiguous at the time.
> - 074 opens the report to team leaders, scoped to their team, and adds
>   `team_activity_alerts.recipient_id`.
>
> The new page reads keys that only 073 and 074 produce, and team leaders
> are refused without 074.

> **Migration required:** apply
> `supabase/migrations/072_allocation_grants_no_visibility.sql`
> (re-runnable). It replaces `can_view_conversation` and
> `can_view_contact` so that allocation to a WhatsApp number (directly
> or through a team) no longer shows a member every chat on it. Apply it
> together with the app: the inbox no longer assumes allocated agents
> see other people's chats.

> **Migration required:** apply
> `supabase/migrations/071_team_number_allocation.sql` (re-runnable)
> **before** deploying the app. It adds `whatsapp_channel_teams`, the
> `direct` / `via_team` flags on `whatsapp_channel_members`, the triggers
> that keep team-derived access in step with team membership (and drop
> a removed member's teams and allocations), and the atomic
> `update_team` / `set_channel_access` RPCs the Teams and Numbers &
> access saves now use, over `set_team_members` / `set_channel_teams` /
> `set_team_channels`. Without it, Settings →
> Numbers & access and Settings → Teams fail to load (500).

> **Migration required:** apply
> `supabase/migrations/070_contact_avatars.sql` (re-runnable). It adds
> `contacts.avatar_checked_at`, which throttles profile-picture lookups
> to one per contact per week. Until it is applied the inbox keeps
> showing initials, and its picture request answers 500 (logged, not
> shown).

> **Migration required:** apply
> `supabase/migrations/069_member_deactivation.sql` (re-runnable). It
> adds `profiles.deactivated_at` / `deactivated_by`, the
> `set_member_active` RPC, and makes the RLS role helpers ignore a
> deactivated member. The app reads the new column defensively, so an
> older database keeps working; the Deactivate button needs 069.

> **Migration required (before deploying this build):** apply
> `supabase/migrations/068_team_activity.sql` (`psql -v ON_ERROR_STOP=1
> -f …`; re-runnable). It adds the Team activity limits
> (`team_activity_settings`), the alert log behind the once-a-day bell
> alerts, the `team_activity_alert` notification type, and the report,
> drill-down, per-person, send-check and alert-sweep functions. The
> send path asks `team_activity_start_check` before a person's message
> on a Whapi number and lets the message through if it is missing, so
> an older database keeps sending; the page itself needs 068.

> **Migration required (before deploying this build):** apply
> `supabase/migrations/067_conversation_human_engaged.sql` statement
> by statement (not with `-1`). It adds `conversations.human_engaged_at`,
> which triggers set the first time a conversation is assigned or a
> person sends a message in it, and fills it in for conversations
> people are already on; and `ai_auto_reply_live()`, which tells any
> member whether the bot is on. The Inbox, the Campaign inbox and the
> Inbox's unread dot all read both, and fail to load without them.

> **Migration required (before deploying this build):** apply
> `supabase/migrations/064_typesafe_account_settings.sql` as one
> transaction, after 063. It adds `ts_account_settings`, the
> per-account switches behind Settings → AI safety checks; the
> `ts_decision_log.intervened` column and `ts_activity_summary()`,
> which the panel's activity view reads; and an index the opt-out watch
> uses. No row means off, so nothing changes until an admin switches
> the layer on.

> **Migration required (before deploying this build):** apply
> `supabase/migrations/063_typesafe_decision_layer.sql` as one
> transaction (`psql -1 -v ON_ERROR_STOP=1 -f …`). It adds:
> - per-account threshold policies with two-person activation, enforced
>   on every path, and a one-admin emergency stop (`ts_retire_policy`);
> - an append-only decision log, labels, and the usage and
>   label-agreement views;
> - two new AI hand-off reasons, `triage` and `guardrail`.
>
> It also changes `claim_ai_reply_slot` to refuse a thread that was
> handed off or assigned while a reply was being drafted. With
> `TYPESAFE_API_KEY` set, this build reads 063's and 064's tables on
> every inbound message, so apply both first.

### Added

- **One tag system: chat tags replace contact tags everywhere.** The
  older contact tags are gone from every screen — the contact panel,
  the chat list's filter, the Contacts page, contact form and import,
  and Settings (*Fields & tags* is now **Custom fields**; old
  `?tab=tags` links open Chat tags). Their jobs use chat tags instead:
  **broadcasts** go to, or exclude, everyone with a chat tag or a
  sub-tag such as *Interested · ADCB*; **automations** gain the
  trigger *Chat tag set*, the step *Set chat tag* and the condition
  *Has chat tag*; **flows** set and branch on chat tags; the **Contacts
  page** shows and filters by each contact's chat tag. In the public
  API, conversations carry `chat_tag` and `chat_sub_tag`; contacts keep
  a deprecated `tags` field that is always empty (`tags` sent on create
  or update is ignored, and `?tag=` returns nothing), plus a new
  `opted_out_at`. The MCP tools drop their tag parameters.
- **Opted-out customers are skipped automatically.** When a customer
  asks the AI bot to stop, they are marked **Opted out** (a badge in
  the contact panel and on the Contacts screens), and every broadcast
  leaves them out — the wizard shows how many it skipped, and a
  customer who opts out after a campaign was planned is skipped when it
  sends. Before, they were only tagged, and an admin had to exclude the
  tag by hand.
- **Chat tags, in place of Open / Pending / Closed.** Admins set up
  colour-coded tags in **Settings → Chat tags** — for example *New
  customer*, *Interested customer*, *Not interested* — in the order
  they want. A main tag can have sub-tags with a heading of its own,
  such as *Interested customer* → **Bank**: ADCB, Emirates NBD, FAB. In
  a chat, the tag sits under the customer's name: pick one main tag,
  and if it has sub-tags the sub-tag menu opens straight away
  ("Bank: ADCB"). A chat carries one main tag and one sub-tag of it;
  switching the main tag drops the old sub-tag. The chat list shows
  each chat's tag and filters by main tag or sub-tag (Open / Pending /
  Closed filters are gone; the status itself is kept for automations
  and the public API). Agents and up tag the chats they can see;
  viewers can't. (Contact tags were later retired in their favour;
  see above.)
- **A chat's tag and sub-tag read as one pill.** In the chat header and
  the chat list, the main tag is the bold, tinted half and its sub-tag
  is joined on the right in a lighter tint of its own colour
  (*Interested customer* | ● ADCB), so the two are never mistaken for
  two separate tags; the sub-tag's heading (*Bank*) shows on hover. Tag
  text takes a shade of the tag's colour. In the list the pill sits on
  the right of each row, beside the unread count, and may take most of
  that line: the message preview shortens first.
- **A rebuilt chat header.** Two rows: the customer (photo, name,
  number — on desktop, click it to open or close the contact panel),
  the sending number, who is on the chat and the refresh and panel
  buttons; then the chat's tags. In a narrower chat the sending number
  shows just its name (its phone joins once there is room), your own
  chats read "Me" and long names truncate, so the customer's name keeps
  its room; tooltips and menus show everything in full.
- **Broadcasts to Compass customers.** The broadcast wizard's audience
  step has a fifth option, *Compass contacts*: pick an order (top or
  bottom of the Compass list, newest or oldest added, name A→Z or Z→A),
  a start position and how many numbers — e.g. 100 numbers from the
  bottom of the list. The step shows which numbers it will take ("1–100
  of 4,213"), and the personalize step can map a template variable to
  any Compass field, ERP attributes included. Only customers with a
  phone number count; numbers that fail the contact rules are skipped,
  and recipients become CRM contacts owned by the admin who sends.
  Exclude tags and the frequency cap apply as for any audience. A slice
  over 1,000 numbers that Compass changes while it is being read is
  refused, with nothing sent, rather than sent to the wrong people.
- **Team activity for team leaders.** A team leader can open Team
  activity and sees only their own team. In the bell, they are told when
  someone in their team reaches the daily new-chat limit.
- **Team activity in plain language.** The page now starts with "Needs
  attention today", one card per person or number. Below that are three
  everyday figures with what "safe" looks like, then a card per person
  with a traffic light and one line of advice, and phone numbers with a
  new-chats-today bar. The charts and a "How we count" explanation are
  folded away.
- **Allocate a WhatsApp number to a team.** In Settings → Teams (or the
  Teams section of Settings → Numbers & access), tick the numbers a team
  works. Everyone in the team and its leader get the number, as if
  allocated one by one. Someone who joins the team gets it, and someone
  who leaves loses it, unless they were also allocated by name.
- **Settings → Teams redesigned:** an overview of each team's leader,
  members and numbers, plus who is not in a team yet. Teams are edited in
  a side panel with search, renaming and an explicit Save.
- **WhatsApp profile pictures in the inbox** for chats on Whapi numbers:
  the chat list, the thread header and the contact panel show the
  contact's photo instead of an initial. The picture is copied into your
  own storage (WhatsApp's links expire) and refreshed weekly; a contact
  who hides their picture, or who only wrote to the Meta number, keeps
  the initial. See `docs/whapi.md` → Profile pictures.

- **Deactivate a member** (admins, Settings → Team members). A
  deactivated person stays on the roster with their role, chats and
  history, but cannot sign in: their Supabase Auth login is banned, an
  open session is signed out, and RLS returns them nothing even on an
  access token issued before the switch. Reactivate gives access back.
  The owner and your own row can't be deactivated, and deactivated
  members are no longer offered as assignees or picked by round-robin.

- **Team activity** (admins, sidebar → Team → Team activity). Per person and
  per WhatsApp number, for today, yesterday or the last 7, 30 or 90
  days: chats started (and how many with new contacts), how many got no
  reply and the reply rate, messages sent, messages piled on contacts
  who stopped answering, failed sends, response time, customers waiting
  now, broadcasts, the busiest day, the fastest 10 minutes, chats
  started at night, links in a first message and the same opener sent
  to many people. Each person and number gets a status (OK, Watch, At
  risk) with what to fix and what to tell them, and a click opens the
  chats behind the numbers. Whapi numbers also show Whapi's own Safety
  Meter rating. See `docs/team-activity.md`.
- **Warnings before a risky message.** On a Whapi number the inbox
  composer (and Contacts → Send message) warns as a person nears their
  daily new-chat limit, when they or the number reach it, and when the
  contact has not answered the last few messages. Once an admin has
  saved the limits, owners, admins and the person get a bell alert,
  once a day, when someone goes over the limit or a number reaches its
  own. An admin can also switch on **Block new chats over the limit**,
  which refuses (with a clear error) a person's message that would
  start a chat past the limit. Replies always go out, including a late
  answer to a customer who wrote last, and owners and admins are never
  blocked. The per-person limits count chats started on Whapi numbers
  only.
- **WhatsApp number health monitor.** Every five minutes (from the
  automation cron, or `GET /api/whatsapp/health/cron`) each Whapi
  number is probed without waking it. When one is logged out or its
  token stops working it is marked *disconnected* and every owner and
  admin gets a notification that says what to do and who does it (scan
  the QR code at panel.whapi.cloud on the phone that holds the number);
  another notification follows when it is back. The inbox warns above
  the composer while a chat's number is disconnected.
- **Failed replies can be retried.** A reply WhatsApp refused stays in
  the thread as *Not sent*, with Retry and Discard, and a failed text
  goes back into the composer. Retry is offered only when the gateway
  definitely refused the send, never when it may have gone out.
- **Contact numbers are checked where people type them** (contact form,
  contact screen, CSV import, the broadcast CSV upload, `POST
  /api/v1/contacts`, Compass contact sync): spreadsheet notation
  (`9.71505E+11`), a number without a country code, fewer than 10
  digits, and malformed +971 numbers are refused with a message asking
  for the country code. A number saved without it used to take the
  customer's inbound messages while every reply went to a WhatsApp
  address that does not exist.
- **Settings → WhatsApp flags webhooks that are not this CRM's**, since
  they receive every message on the number.
- **Settings → AI safety checks.** Admins switch the TypeSafe layer on
  and off for their account, choose **Monitor only** or **Live**, pick
  the checks and the languages it may act on, and see what it did: a
  seven-day summary (hand-offs, opt-outs, replies held or blocked,
  excerpts removed, outages, cost, latency) and every decision, with
  the contact. The server now needs only `TYPESAFE_API_KEY` and
  `TS_LOG_HASH_KEY`; `TS_ACCOUNT_IDS`, `TS_ENABLED_*` and `TS_SHADOW`
  became optional install-wide overrides (`TS_SHADOW` defaults to
  `false`). **Live** acts on the built-in thresholds unless two admins
  approved custom ones.
- **Opt-outs are caught on every conversation**, not only the ones the
  bot answers. When *Watch conversations your team handles* is on (the
  default), an inbound message the bot did not judge is triaged after
  every reply has gone out, and in Live a clear opt-out tags the
  contact `opted-out`. It never hands over or replies.
- **TypeSafe decision layer for the AI bot (module 013, off by
  default).** Three checks run on the TypeSafe (Jev) API around the
  auto-reply bot, for each account that switches them on in Settings →
  AI safety checks:
  - **Triage**, before any model call. It hands the thread to the team
    when the customer asks for a person or complains, or might be
    complaining. It also catches free-text opt-outs, where the bot stays
    silent and the contact is tagged `opted-out`. A message that tries
    to steer the bot gets knowledge-base-only answers.
  - **Passage filter**, after knowledge-base retrieval. Irrelevant and
    injected excerpts are dropped, and excerpts that contradict the
    customer's premise are set apart.
  - **Guardrail**, just before the send. It holds or blocks replies
    that:
    - promise approval;
    - quote a figure no source contains;
    - name a non-partner bank;
    - ask for an OTP;
    - share another customer's details.

    The draft is quoted in the hand-off note for the team. Its
    deterministic checks keep acting even while the model is in shadow
    for the reply's language.

  **Monitor only** logs every decision and changes nothing; **Live**
  acts on the built-in thresholds, or on custom ones an owner or admin
  proposed and a **different** one approved. With *English only* (the
  default), Arabic, mixed and other-script traffic is logged only until
  calibrated. Checks in monitor mode add no latency to replies.

  Before any customer text leaves the server, it is redacted (Emirates
  ID, IBAN, cards, phones, e-mail, passport and licence numbers, any
  long number). Only keyed hashes are logged, and deleting a contact
  erases its identifiers from the log. An invalid `TS_*` value turns the
  layer off and says so in the service log; it never stops the bot.

  Setup, rollout, emergency stop and calibration are in
  `docs/typesafe.md`. The pre-eligibility check (E) is included in
  `lib/typesafe` but not wired, since the app has no eligibility step
  yet.
- **Switch a chat's sending number mid-conversation.** The thread header
  has a number picker on every chat, including existing ones.
  *Automatic*, the default, replies on the number the customer last
  wrote to, as before. Picking a number sends everything in that chat
  from it until someone switches again: agent replies, API replies, and
  flows, automations and AI replies in the chat. Each switch leaves a
  note in the thread, e.g. "Alice switched this chat to Support".
  People only see the numbers they may use: every number for admins,
  otherwise their allocated numbers plus shared ones. The database
  enforces this too. A pinned chat stays with the team that had it when
  the customer answers on the new number, and that number's people can
  see it as well. A reply that quotes a message carried by the other
  number is sent without the quote on WhatsApp; the thread still shows
  it.

- **Several WhatsApp numbers, each with its own people.** New admin
  screen **Settings → Numbers & access**: connect another Whapi
  number, name each one ("Sales", "Support"), pick the default, and
  allocate numbers to specific members. People on a number see every
  chat on it, which makes it a shared inbox for them, and their new
  chats start from it. A number with nobody on it works exactly as
  before, and admins still see everything. Replies always leave on
  the number the customer last wrote to. Flows, automations and AI
  replies stay on that number too, unless the admin has routed that
  task to the Meta number. The inbox labels each chat with its number
  when an account has more than one. Settings → WhatsApp gets a
  switcher for each Whapi number's connection panel. See
  `docs/whapi.md` → *Several numbers*.

- **Taamul Compass (ERP) integration.** Compass syncs its customers
  into a dedicated table (`POST /api/v1/compass/contacts`, batch upsert
  keyed by Compass's id, bad records reported per index) and sends
  status notifications (`POST /api/v1/compass/notifications`). A
  notification always goes out on the **Whapi** number — it fails with
  `whapi_not_connected` rather than falling back to Meta — lands in the
  customer's existing chat without changing who handles it, and is sent
  at most once per `idempotency_key`. New API-key scopes
  `compass_contacts:read`, `compass_contacts:write`,
  `compass_notifications:send`; new admin screen **Taamul Compass**.
  Integration guide for the Compass team: `docs/compass.md`.
- **Forward a message to other chats.** Hover a message in the inbox →
  _Forward_, pick up to five chats, send. Text, photos, videos, voice
  notes and documents can be forwarded; templates and button messages
  go out as their text; locations and contact cards cannot. It is a
  re-send rather than a WhatsApp-native forward (only Whapi has one,
  and only within a single channel), so the recipient sees no
  "Forwarded" label — the inbox does. Each target is an ordinary agent
  send: it follows that customer's number, and on the Meta number it
  fails outside the 24-hour window like any free-form message. An
  attachment the gateways can't fetch directly (Meta media, or a Whapi
  link with mirroring off) is copied into `chat-media` first.

- **"Forwarded" label on inbound messages.** A message the customer
  forwarded from another chat is now marked as such in the thread, on
  both the Whapi channel and the Meta number.

- **Personalize a CSV campaign from the file itself.** When the
  audience is an uploaded CSV, the _Personalize_ step lists every
  column of the file as a source for each template variable — with
  row 1's value shown as the example — so `{{1}}` can be an
  `order_id`, a `due_date`, or any other column the contact record
  doesn't have. Each recipient gets their own row's value, including
  contacts that already existed in the CRM under a different name.
  The preview on that step now renders the file's first row.

- **Campaigns that keep going.** A broadcast can name a Flow to start
  for each recipient on their first reply (wizard → _When they reply_;
  `flow_id` on `POST /api/v1/broadcasts` and the MCP `send_broadcast`
  tool). The reply that started it — the tapped template button or the
  typed text — is seeded into the run as `{{vars.campaign_reply}}` /
  `{{vars.campaign_reply_id}}`, so the flow can branch on it without
  asking again. The campaign page shows the linked flow; the run log
  records which campaign started a run.
- **The AI agent inside a Flow.** A new off-script setting on every
  flow (_Off-script replies_ panel in the editor) — _Let the AI agent
  answer, then continue the flow_: when the customer types a question
  instead of picking an option, the agent answers it in the context of
  the step (it is told the prompt and the options) and asks them to
  pick one; the run stays where it is, so the buttons still work. If
  the agent is off, at its cap, on the other number, or the thread has
  a human, the options are re-sent as before; if the agent hands off,
  the run ends and the human takes over. Existing flows keep the
  re-prompt default. The panel also exposes the re-prompt count and
  what happens after it, which previously could only be set through
  the API.
- **Video and document template headers can be uploaded.** The template
  editor and the broadcast wizard's personalise step now offer _Upload
  video_ / _Upload PDF_ next to the URL field (MP4/3GPP ≤16 MB, PDF),
  with an inline player for video, instead of image-only upload with a
  bare URL box for everything else. This matters most for a template
  created and approved in Meta's dashboard: it syncs with a video
  header but no link, and WhatsApp needs the video on **every** send —
  the review sample is never reused — so without a URL the send was
  refused. Upload once in the editor and every send of that template
  carries it.
- **A broken flow no longer strands the customer.** When a run hits an
  unrecoverable error on a message — a node deleted while a customer
  was on it, a send that failed — the run ends as _failed_ and the same
  message is handed to the AI agent and automations, instead of being
  swallowed as "handled". `docs/campaign-journeys.md` describes the
  whole Flow → AI → human chain and what answers at each moment.

- **Broadcast CSV template.** The _Upload CSV_ audience step now links
  a downloadable template (`name,company,phone`) and keeps the
  `company` column: contacts created from a broadcast upload used to
  land with only a name and number, so `{{company}}` variables and the
  contacts screen were blank for them. Only `phone` (E.164) is
  required; the header check and column names are unchanged, so
  existing files still upload.

- **AI agent escalation gates.** Three deterministic checks now run in
  front of the auto-reply bot, each handing the thread to a human with
  a recorded reason instead of letting the model answer, and each
  configured under Settings → AI → _Escalation gates_:
  - _Escalation keywords_ — words or phrases in any language (`refund*`,
    `complaint`, `شكوى`, …) that send the message straight to the
    handoff agent without spending a token. Word-boundary matching; a
    trailing `*` matches word beginnings.
  - _Retrieval threshold_ — the minimum similarity the best
    knowledge-base match must reach; below it the bot hands off and the
    question is logged under _Unanswered questions_ on the same page,
    so the knowledge base can be extended where customers actually ask.
    Needs an embeddings key; short conversational turns (under four
    words) skip the gate.
  - _Strict grounding_ — the knowledge base becomes the bot's only
    source of facts; it may greet and clarify but never states a price,
    timeline, or policy it cannot quote.
    A _handoff message_ is sent to the customer when a gate hands off, so
    they are not left waiting in silence. A provider error or timeout is
    now a handoff too (previously the bot logged the error and the
    customer heard nothing), and the internal note the bot leaves names
    the reason. The Playground exercises the same gates and shows which
    one fired.
- **Scheduled broadcasts.** The wizard's last step now offers _Send
  now_ or _Schedule_ with a date and time; a scheduled campaign is
  delivered server-side by the new broadcast cron, so the tab need not
  stay open. Its page shows the appointment and a _Send now_ override.
- **Quiet hours** on a broadcast — a do-not-send window in your time
  zone. A send that would land inside it (now or scheduled) is moved to
  the moment the window ends, and the wizard says so before you
  confirm.
- **Frequency cap** on a broadcast audience — skip contacts who
  received any campaign in the last _N_ days, whatever list they came
  from (CSV included).
- **Message costs.** Settings → Message costs shows what the Meta
  Cloud API number is spending, priced from the `pricing` object on
  every delivery receipt Meta posts: this month so far, spend per
  month stacked by category, per number (with the position against
  the free tier of 1,000 service messages a month that starts on
  1 October 2026), and per recipient market. Deliveries to a market
  the rate card does not cover are counted and flagged as _no rate on
  file_ rather than silently priced at zero; loading Meta's published
  CSV with the new `scripts/load-meta-rate-card.ts` closes the gap.
  Meta's own billable flag on a receipt overrides the local rules,
  and costing runs last in the webhook and fails open, so a rate-card
  problem can never cost an inbound message. The Whapi channel is a
  flat subscription and is not metered. Admin and owner only.

- **Campaign inbox.** A second tab under Broadcasts listing the
  conversations that started as a reply to a campaign while the AI bot
  is answering them, with a per-campaign filter and, on every row,
  which campaign it came from. Each conversation is listed in exactly
  one place — the Inbox lists every other one. A campaign conversation
  moves to the Inbox for good once a person steps in (it is assigned
  to anyone, or a person replies; releasing the assignment or a reply
  to a later campaign does not bring it back), and it is in the Inbox
  whenever the bot is not answering it: handed off, paused, never
  answered (a reply on a number the bot does not run on, say), or with
  the AI auto-reply switched off. The Inbox's unread dot counts only
  conversations the Inbox lists. Admin and owner only, like the rest
  of the section.
- **The AI bot knows which campaign a customer is answering.** When a
  broadcast recipient replies, the thread is stamped with that
  campaign and the bot is told the campaign name and message, so its
  first reply is about the offer the customer received rather than a
  guess at what they want.
- **Sync templates from Meta.** Settings → Templates has a _Sync from
  Meta_ button that pulls every template registered on the connected
  WhatsApp Business Account — name, language, category, header, body,
  footer, buttons, approval status — into the CRM. Until now only
  templates submitted _from_ the CRM were listed, so an account whose
  templates were built in Meta Business Manager saw an empty list and
  could not start a broadcast. The Templates panel and the Settings
  overview counts are also account-wide now instead of per author.
- **AI agent: _Campaign replies only_.** A switch in Agents → Setup that
  restricts the bot to conversations that came from a broadcast, so a
  business can run bot-handled campaigns on a number that also takes
  ordinary customer chat handled by people.
- **Upload a file to the AI knowledge base.** Agents → Knowledge has an
  _Upload file_ button next to _Add document_: a PDF (with a text
  layer), .txt, .md, .csv or .json is extracted and indexed like pasted
  text. Scanned PDFs are rejected with a clear message rather than
  saved empty.
- **Shared contact cards render as cards.** A contact the customer
  shares from WhatsApp — on either number — now shows in the thread
  as a card with the name, every phone number, email and company,
  plus a _Save to contacts_ action that creates the CRM contact (or
  opens the existing one when the number is already known). Previously
  the numbers were discarded at the webhook and the thread showed a
  bare "[contact] Name" line.
- **`scripts/bot-pack.ts`** loads a Taamul bot-pack (one product line,
  or the manifest for all four merged into one agent) into an
  account's AI agent and knowledge base, and runs the pack's test
  cases through the same path the live bot uses.

- **The inbox agrees with itself about who owns a chat.** The
  conversation list now shows the owner's name on a chat nobody has
  formally assigned, instead of the bare word _Unassigned_, and the
  **Agent** filter returns those chats under that owner's name. The
  amber person icon still marks a chat as unclaimed, so the triage
  signal survives — and **Unassigned** still lists exactly the chats
  nobody has taken, which now deliberately overlaps with their owner's
  name.
- **The chat header names whoever is on the thread.** The Inbox header
  now carries the agent working the conversation next to the status and
  Assign controls, instead of leaving a bare **Assign** button on every
  thread nobody had formally claimed. It shows the assignee when there
  is one; otherwise the last agent who actually replied, falling back to
  the chat's owner — hover it to see which of the three you are looking
  at, and whether the thread is still unassigned. Outbound sends from
  the composer now record who sent them, which is what makes the
  "replying" case possible; threads answered before this update fall
  back to the owner until the next reply.
- **The inbox now says whose chat each one is.** Every conversation in
  an admin's inbox — and in a team leader's `/team-inbox` — carries the
  name of the agent holding it, with unassigned threads called out in
  amber so the ones nobody has picked up are visible at a glance. A
  plain agent's inbox is unchanged: every chat there is already theirs.
- **A chat you start is yours from the first message.** Writing to a
  contact who has no thread yet now opens it assigned to you, so it
  shows your name in the inbox instead of Unassigned. Admins reassign to
  anyone and team leaders within their own team, exactly as before —
  this only sets the starting point. Inbound chats from strangers are
  deliberately left unassigned: that is the triage queue.
- **Filter the inbox by agent.** The same views get an **Agent** filter
  next to Tags and Company — pick a teammate to see everything they are
  handling, or **Unassigned** to work the queue nobody has claimed. It
  combines with the existing status, tag, company and search filters,
  and clears with **Clear all**.
- **Meta WhatsApp Cloud API as a second number.** Connect a Cloud API
  number in Settings → WhatsApp and keep your Whapi channel for
  conversations. It must be a _different_ phone number — registering a
  number on the Cloud API removes it from the WhatsApp app, so no number
  can be on both. See `docs/meta-cloud-api.md`.
- **Per-task number selection.** An admin can point each of inbox
  replies, broadcasts, automations, flows, AI auto-reply and the public
  API at either number, or leave it on the account default. The usual
  split is campaigns and automations on the Cloud API number (the
  sanctioned path for business-initiated messaging) and everything
  conversational on Whapi.
- **Meta inbound webhook** at `/api/whatsapp/meta/webhook`, authenticated
  by `X-Hub-Signature-256` over the raw body. Verification fails closed:
  with no app secret configured, callbacks are rejected rather than
  trusted. Both numbers deliver into the same inbox, and a contact stays
  a single conversation regardless of which number they used.
- **Template review lifecycle is live again** when a Meta number is
  connected. Saving a template in Settings → Templates also submits it
  to your WhatsApp Business Account for review, and approvals,
  rejections and quality ratings arrive on the template webhook. The
  submission is best-effort: if Meta rejects the payload the template is
  still saved and still sendable over Whapi, with the reason recorded.
  One template row serves both numbers — Whapi renders it locally and
  needs no approval.
- New optional environment variables `META_APP_SECRET`,
  `META_VERIFY_TOKEN`, `META_API_VERSION` and `META_TIMEOUT_MS`, for a
  single-app self-host that would rather configure Meta's app-level
  secrets once than per account. See `.env.local.example`.

### Changed

- **The inbox looks and reads like WhatsApp.** WhatsApp Web's own
  palette in light and dark mode, independent of the accent theme:
  green bubbles for what we sent with the bubble tail, the time and
  ticks tucked into the last line, blue ticks once read, and the beige
  or dark chat wallpaper. In the chat list an unread chat is
  unmistakable — bold name and preview, a green time and a green count
  — while a read one is plain; the status dot that looked like an
  unread marker is gone (Pending and Closed now say so in words), rows
  are separated by hairline dividers, and times read `14:05`,
  `Yesterday`, `Monday`, `23/09/2026`. Status filters are WhatsApp-style
  chips with **Unread** always in view. Opening a chat with unread
  messages shows an **"N unread messages"** divider above the first
  one. The header gives the contact's name priority, folding labels
  away in a narrow pane, and the "who is on this chat" chip now opens
  the assign menu itself. Also fixed: on a phone the chat list was
  wider than the screen, cutting off times and unread counts.
- **The sidebar is grouped.** Dashboard, Notifications, Inbox and
  Contacts stay at the top for everyone. Below them, under small
  headings, come **Team** (Team inbox, Team contacts, Team activity),
  **Sales & marketing** (Pipelines, Broadcasts), **AI & automation**
  (Automations, Flows, AI Agents) and **Integrations** (Compass), and
  Settings sits apart at the foot. A heading shows only when there is
  something under it the person may open, so agents and viewers see just
  the top four, and team leaders also get Team.
- **Send failures say what actually happened.** A Whapi refusal is
  followed by a quick status check of the number, so agents see
  "logged out of WhatsApp — re-scan the QR code" rather than "token
  invalid or revoked", which sent admins to re-save a token that was
  fine. Compass notifications answer `409 whapi_not_connected` while the
  number is disconnected, instead of a 502 and an empty chat.
- **Broadcasts** stop sending, leaving recipients pending for Resume,
  when the number itself fails (logged out, token revoked, subscription
  lapsed), instead of failing every remaining recipient. A Meta
  template with an image, video or document header but no media is
  refused at launch (`400 template_media_missing`). Delivery ticks and
  `message.status_updated` webhooks no longer go backwards.
- **An AI reply WhatsApp fails to deliver hands the thread to a
  person** (reason `error`); it used to fail silently.
- **Meta webhook:** callbacks for a number not connected here are
  summarised once an hour per number (messages, statuses, how many are
  signed by this app) instead of one log line per request; template
  callbacks for a WABA not connected here are acknowledged without a
  signature check (a latent 401 while `META_APP_SECRET` was unset could
  have made Meta disable the app's subscription); template quality and
  components callbacks reach the template handler.
- **Meta connect** refuses a different number while one is connected
  (409) instead of silently overwriting the live number, lets the WABA
  id of the connected number be corrected once Meta lists the number
  under the new WABA, and checks that the phone number belongs to the
  WABA before subscribing it (400).
- **Meta webhook robustness:** a POST mixing template changes and
  messages processes both halves (the messages used to be dropped with a
  200); a database error while looking up the WABA or phone number id
  answers 503 so Meta retries; a malformed or forged body is answered
  200 `ignored` instead of a 500.
- **Compass notifications** check the Whapi number the customer's chat
  actually uses before refusing with `409 whapi_not_connected`, and a
  synced phone that is not a valid international number is refused with
  `422 invalid_phone` (it was "sent" to nobody).
- **Contact numbers:** a national number typed without its country code
  (e.g. `98765 43210`) is refused instead of being stored as +98…; a
  trunk 0 after any country code is removed; UAE 600/800 numbers are
  accepted; a `.0` suffix, letters, or more than 64 characters are
  refused instead of silently altered. `POST /api/v1/messages` and v1
  broadcast recipients follow the same rule, and `/messages` matches an
  existing contact by the normalized number.
- **Inbox:** a failed text is put back only in its own chat; when a send
  may have gone out (a timeout or a gateway error) there is no Retry and
  the toast says it may still have reached the customer; a "sent but not
  saved" error no longer deletes the attachment the delivered message
  links to. An attachment kept for Retry is left in storage if the tab
  is closed before it is retried or discarded.
- **Broadcasts:** a campaign stopped by a failure of the sending number
  records the reason on the recipient where it stopped; a delivered
  receipt no longer drops a read receipt that arrives at the same
  moment.

- **Contact detail sends split across the two numbers.** With both a
  Whapi channel and a Meta Cloud API number connected, opening a
  contact and choosing _Send message_ now goes out on the Whapi number
  and _Send template_ on the Meta number — a free-form text is what
  Whapi is for, and an approved template is the only thing that opens
  a business-initiated conversation on Meta. A caption under the two
  buttons names the number each will use. Single-number installs are
  unchanged: both actions use the one connected number. (The dashboard
  send endpoint gained an optional `provider: 'whapi' | 'meta'` pin
  behind this; the inbox composer leaves it unset and keeps following
  the customer's number.)
- **The AI agent hands off at its reply cap.** Once _Max replies per
  conversation_ is reached, the thread is handed to a human with reason
  _reply cap_ (internal note, handoff agent if one is set, the handoff
  message to the customer if one is set) instead of the bot silently
  ignoring every further message. A thread the bot has left is still a
  thread someone must answer.
- **Replies follow the customer's number.** An agent replying in the
  inbox now answers on whichever number the customer last wrote to,
  rather than a single configured channel. On Meta this is also what
  keeps the reply inside the 24-hour service window the customer opened.
- **AI auto-reply answers only on its own number.** With two numbers
  connected, the bot replies to messages that arrive on the number it
  is routed to and leaves the other number to humans — so routing it to
  the Meta number gives you a Meta-only bot. Single-number installs are
  unchanged.
- **The AI bot can say goodbye before handing off.** When it decides a
  human should take over, a closing line it wrote ("a relationship
  manager will contact you within working hours") is sent first instead
  of the customer seeing silence. Counts against the per-conversation
  reply cap like any other bot message.
- **Clearer send failures.** Gateway rejections are translated before
  they reach you — most usefully Meta's closed 24-hour window, which
  previously surfaced as a bare numeric code.
- Disconnecting one number no longer disturbs the other; any task routed
  to the removed number falls back to the account default.

- **Renamed the product to Taamul Connect.** The app title, sidebar,
  UI strings (`en` and `ko`), docs and package names now read Taamul
  Connect. The npm packages are `taamul-connect` and
  `taamul-connect-mcp`; the Docker Compose project is
  `taamul-connect`.

  Nothing you have integrated breaks. Every renamed identifier keeps
  accepting its old value:

  - **API keys** — new keys mint as `taamul_live_…`; existing
    `wacrm_live_…` keys keep authenticating. The prefix is not a
    secret and carries no scope, so there is nothing to rotate unless
    you want to.
  - **Outbound webhooks** — deliveries now send `X-Taamul-Event`,
    `X-Taamul-Webhook-Id` and `X-Taamul-Signature`, _and_ continue to
    send the identical `X-Wacrm-*` headers. Receivers verifying the
    old names need no change. The old names are deprecated and will
    be dropped in a future release.
  - **MCP server** — reads `TAAMUL_BASE_URL` / `TAAMUL_API_KEY` /
    `TAAMUL_ENABLE_WRITES` / `TAAMUL_ENABLE_BROADCASTS`, falling back
    to the `WACRM_*` names, so an existing client config keeps
    working.
  - **Sessions and preferences** — the auth cookie name is
    deliberately unchanged (renaming it would sign everyone out).
    Theme, mode, inbox panel and flow-editor preferences are read
    from their old `localStorage` keys once and migrate on next
    write.

  No database migration is required.

  Two things are **not** renamed automatically because they name
  objects outside this repo: the systemd units, log files and
  checkout path in `scripts/sync-tunnel-url.sh`, and the
  `github.com/ArnasDon/wacrm` URLs in the GitHub issue templates and
  `SECURITY.md`. Update those to match your own deployment and
  repository.

  If you run Docker Compose, the project name changed, so the old
  containers are no longer tracked. Run `docker compose -p wacrm
down` once before bringing the new project up. There are no named
  volumes, so no data is involved.

### Fixed

- Broadcasts: a template variable that came out blank for some
  recipients (a Compass field or CSV cell they lacked, a contact with
  no email) failed every one of them on Meta with `(#131008) Required
  parameter is missing`, and on Whapi sent "Hi ,". Each variable in the
  Personalize step now has an *If empty, use* fallback, and the step
  warns how many CSV rows, or how many customers in a sample of a
  Compass selection, would get a blank. A blank value that still
  reaches a Meta send is refused before the gateway call, and the
  recipient's error names the variable; a #131008 from Meta is worded
  plainly too. Values are fixed when a broadcast is created, so an
  affected campaign is fixed by creating it again with a fallback, not
  by *Retry failed*.
- Team activity figures and warnings were inaccurate:
  - Since a second phone number was connected, older chats belonged to no
    number, so per-number and per-person totals read low.
  - "Messaged without an answer" only looked back 7 days.
  - "Customers waiting" counted threads that ended weeks ago.
  - Chats started minutes earlier already counted as "no reply".
  - Compass notifications showed up as replies.
  - "At the limit" meant different things on the page, in the bell and in
    the message box.
  - The reply-rate warning told people to reach a rate they were already
    above.
  - Failures on the official number were blamed on agents.
  - Near-identical first messages that differed only by a name went
    unnoticed.
  - New phone numbers now have a lower daily limit (10) for their first
    two weeks.
- Number allocation: an agent allocated to a WhatsApp number (or in a
  team allocated to it) could see every other agent's chats and
  contacts on that number. Allocation now only controls which numbers
  they send from and start new chats on; they see their own and
  assigned chats (team leaders also their team's), and admins and owners
  see everything. Settings wording and docs updated to match (migration
  072).
- Inbox: after a Whapi channel was re-paired to a different phone, the
  number picker, the conversation list and the alerts kept showing the
  old number, which was only stored when the token was saved. Settings
  showed the new one. The channel health check and Settings → WhatsApp
  now store the number Whapi reports paired, so these screens follow it
  within one health tick.
- Inbox: a chat that receives (or sends) a new message now jumps to the
  top of the list, as in WhatsApp; it used to stay where it was until a
  reload. Chats with no messages at all — left behind when a first send
  failed — no longer appear, and no longer sit above every real chat.
- Re-saving a Whapi token while the phone was logged out erased the
  number's stored phone number.
- Inbound contact lookup preferred whichever of two near-duplicate
  contacts the database returned first; it now prefers the exact number,
  then the oldest.
- Broadcast failure reasons were never stored ("-" on every failed
  recipient); the legacy broadcast route logged full customer phone
  numbers.

- **Multi-number review.**
  - *Wrong number:*
    - Reactions go out through the number that carried the message.
    - The AI replies only when the number it would answer from is the
      one the customer wrote to. An explicit AI route to one Whapi
      number keeps the other Whapi numbers human-only.
    - A quoted reply to an older message is sent unquoted when it
      could have been carried by another number.
  - *Robustness:*
    - One number with an unreadable token no longer stops every other
      number from sending.
    - When no default is flagged, the fallback is a Whapi number, not
      Meta.
    - An agent on no number no longer starts new chats from a number
      allocated to someone else.
    - A pin set while an inbound message is being processed is no
      longer overwritten.
    - Switching back to automatic re-syncs which number the chat is
      on.
  - *Speed:* fewer database round trips per send.
  - *Screens:*
    - The chat header fits on phones.
    - Rapidly switching chats no longer mixes up their number or their
      notes.
    - Routing dropdowns show names instead of `__inherit__`.
    - The inbox list no longer loads twice on open.
- **Security.**
  - *Outside the multi-number work:*
    - Delivery-status callbacks only touch the authenticated account's
      messages and broadcasts.
    - A Meta callback that batches several numbers is split and each
      part is filed under its own number and account.
    - Automation read/edit/delete/duplicate routes are scoped to the
      caller's current account, so a removed admin can no longer edit
      automations they wrote. Any admin of the account can now open an
      automation, not only its author.
    - The legacy media proxy only serves media that a message the
      caller can see points at.
    - Webhook URLs are checked for private addresses when saved.
  - *Public API:*
    - Pagination cursors are validated as strict timestamps.
    - The send error no longer carries raw database text.
  - *Legacy broadcast endpoint:* capped at 100 recipients per call.

- **A large CSV broadcast import failed with a page of HTML instead of
  an error.** Importing an audience looked up every phone number in the
  file in one request, and PostgREST echoes the whole
  `?phone_normalized=in.(...)` filter back in the `Content-Location`
  response header. Past roughly 250 rows that header outgrew the
  default 4 KB buffer in a reverse proxy sitting in front of a
  self-hosted Supabase, which answered 502 — so the upload stopped with
  the proxy's "Bad gateway" markup quoted back as the reason, while the
  identical query was fine against Supabase directly. The lookup is now
  chunked like the insert beside it. Self-hosters behind a proxy should
  also raise its response-header buffers; see `docs/docker.md`.

- **A tapped template button got no reply from the AI agent.** A
  campaign sent without a follow-up Flow whose recipient answered by
  tapping a quick-reply button ("Get a quote") was never handed to the
  bot: button taps were reserved for Flows and _interactive reply_
  automations, and the agent's transcript only read typed messages, so
  with neither in place the customer heard nothing back. The agent now
  answers a tap nothing else claimed, reading the tapped title as the
  customer's message; it still stands down when a Flow consumed the tap
  or an active _interactive reply_ automation owns the buttons.
- **The AI agent's _Campaign replies only_ switch did nothing.** The
  setting (migration 049) was saved and shown but never checked when
  a message arrived, so the bot answered every chat on its number
  regardless. It is now enforced: with the switch on, the bot only
  answers threads a broadcast reply has stamped.
- **A resumed broadcast lost its media header.** The wizard passed the
  image / video / document URL per request and never stored it, so a
  Resume or Retry sent the template's stored sample instead. The URL is
  now persisted on the campaign and used by every server-side pass.
- **A media header chosen in the broadcast wizard never reached the
  Cloud API.** The provider-neutral send layer forwarded the header URL
  to Whapi but dropped it on the Meta branch, so a video / image /
  document template synced from Meta (which carries no stored media
  link) failed every recipient with _"video header requires a media
  link or id at send time"_ even though the wizard had the URL. The URL
  is now folded into the Meta send.
- **Inbound messages from a contact whose number was typed with spaces
  were silently dropped.** The duplicate-contact lookup pre-filtered on
  the raw `phone` column, so a contact saved as `971 50 455 5843` was
  invisible to the webhook; the insert then tripped the unique index
  and the message never reached the inbox. The lookup now filters on
  the normalised column the index is built on.
- Every screen under the dashboard (`/flows`, `/agents`,
  `/notifications`, `/team-inbox`, `/team-contacts`) now redirects a
  logged-out visitor to `/login` at the edge, like the rest. Data was
  never exposed — RLS and the client-side guard still applied — but the
  page shell was served before the redirect fired.

## [0.8.1] — 2026-07-10

Fixes inbound chats fragmenting into multiple threads for the same
number.

> **Migration required:** apply `supabase/migrations/036_conversation_contact_dedup.sql`
> (merges any existing duplicate conversations into the oldest thread —
> no messages are lost — then adds a `UNIQUE (account_id, contact_id)`
> index so one contact can only ever have one conversation).

### Fixed

- **Message costs no longer zero-rates a template send.** Meta attaches
  the `pricing` object to the `sent` receipt and does not always repeat
  it on `delivered`. A delivery with no category of its own was filed
  as _service_ — free, and invisible to the _no rate on file_ counter —
  so a marketing or utility send could disappear from the ledger
  entirely. Such a delivery now adopts the category already recorded
  for the same message, and the pre-per-message `user_initiated` origin
  maps to _service_.
- **Message costs: "Free service messages used" counts.** The tile read
  the ledger's quota flag, which is only ever set once the 1,000-message
  allowance is what makes a message free — so it showed a flat zero
  until 1 October 2026 while the per-number rows beneath it counted
  normally. It now reads the same free-tier figure they do.
- **Message costs: a service message Meta bills is no longer also
  counted as free.** Meta's `billable` flag overrides the local rules,
  but the row kept its quota-free mark, charging the message and
  spending an allowance slot for it.
- **Message costs: an unrecognised category is shown, not dropped.** A
  category outside the known list (a pre-per-message `business_initiated`,
  or one Meta adds later) vanished from the stacked chart — leaving the
  bars short of the headline total — and rendered as a raw translation
  key in the breakdown list.

### Changed

- The migrations workflow now also replays
  `supabase/ci/verify-message-costs.sql`, which drives
  `record_whatsapp_message_cost` with real receipt shapes and asserts
  the ledger rows it writes. The costing rules live in SQL, so `npm
test` cannot reach them, and a wrong rate is silent by nature — it
  under-reports spend without erroring.
- **AI knowledge base keyword search matches natural questions.** See
  the migration note above.
- **Broadcast audience → Upload CSV actually offers a file picker.**
  The option, its copy and the send-side handling all existed, but the
  panel with the upload button was never rendered, so choosing it left
  nothing to click. A `phone` column (E.164) is required; `name` is
  optional.
- **CSV audiences no longer fail on contacts that already exist.**
  Sending to a CSV matched the file's numbers against the raw phone
  string of the sender's own contacts, so a number a teammate had
  already saved — or the same number written with spaces or a `+` —
  was re-inserted and rejected by the per-account unique phone index
  (`duplicate key value violates … idx_contacts_account_phone_normalized`).
  Matching is now on the normalized number, account-wide.

- **Duplicate chats for a single contact.** An inbound message could
  create a second conversation for a contact under a race (Meta retries a
  delivery, or a batch fans out to concurrent runs). Once two existed,
  the `.single()` lookup errored on every later message and the webhook
  created yet another conversation each time, snowballing into a wall of
  duplicate chats. The find-or-create now resolves to the oldest existing
  thread and a DB unique index makes the one-conversation-per-contact
  rule authoritative. The same hardening was applied to the public-API
  conversation resolver. (Issue #363)

## [0.8.0] — 2026-07-08

Polishes the AI auto-reply bot: it's now **visible and controllable from
the inbox**, its **handoff actually hands off**, and its **token spend is
logged**.

> **Migration required:** apply `supabase/migrations/033_ai_reply_polish.sql`
> (adds `messages.ai_generated`, `ai_configs.handoff_agent_id`,
> `conversations.ai_handoff_summary`, and the `ai_usage_log` table).

### Added

- **"AI" badge in the inbox.** Replies the bot sent are tagged with a
  small ✨ AI badge, so agents can tell an automated reply from their own
  or a Flow's at a glance. (New `messages.ai_generated` flag; only the
  auto-reply bot sets it.)
- **Take over / Resume from the thread.** A banner on AI-handled
  conversations lets an agent **Take over** (pauses the bot for that
  thread and assigns it to them) or **Resume AI** (hands the thread back
  and clears the pause). Backed by `POST /api/ai/autoreply/[id]`.
- **Real handoff.** When the bot bails (can't help, or hits the reply
  cap) it now (1) routes the conversation to a configurable **handoff
  target** — a specific agent, or the unassigned queue — and (2) leaves a
  short **internal note** summarizing the exchange for whoever picks it
  up. Assigning fires the existing assignment notification. Pick the
  target under **AI Agents → Setup → Hand off to**.
- **Token-usage logging + dashboard.** Every draft and auto-reply records
  its provider token counts to the new `ai_usage_log` table
  (admin-readable). A new **AI Agents → Usage** tab (admin-only) charts
  daily token spend on your BYO key with per-mode and per-model
  breakdowns, backed by `GET /api/ai/usage`. Counts only — no message
  content is stored or shown.

### Changed

- Auto-reply now has an **account-wide rate limit** (30/min) on top of
  the existing per-conversation cap, so a burst of inbound can't run your
  provider key past its limit. Over the limit, inbounds simply wait in
  the inbox for a human instead of being auto-answered.

## [0.7.0] — 2026-07-02

Promotes the AI assistant to a first-class **AI Agents** section in the
sidebar — it's no longer tucked inside Settings.

### Added

- **AI Agents (sidebar).** A dedicated `/agents` area with two tabs:
  - **Playground** — a test chat to message your agent and see its
    grounded, multi-turn replies (and where it would hand off to a human)
    _before_ it ever answers a real customer. Runs the exact same path as
    the auto-reply bot (knowledge-base retrieval + your provider), and
    works even before you flip the master switch on, so you can try, then
    enable. Backed by `POST /api/ai/playground`.
  - **Setup** — the provider/key, business context, knowledge base, and
    auto-reply controls (moved here from Settings → AI Assistant).

### Changed

- The AI configuration moved out of **Settings → AI Assistant** into the
  new **AI Agents** section. No data change — same account config, new
  home. No migration required.

## [0.6.0] — 2026-07-02

Adds an **AI knowledge base** so the assistant (0.5.0) can answer from
your own content instead of handing off. Paste FAQs, policies, or
product details under **Settings → AI Assistant → Knowledge base**; the
relevant excerpts are retrieved into every draft and auto-reply.

### Added

- **Knowledge base with hybrid retrieval.** Lexical Postgres full-text
  search works for every account with no extra credentials. Optional
  **semantic search** (pgvector, OpenAI `text-embedding-3-small`) turns
  on when you add an **embeddings key** — semantic-primary, topped up
  with lexical to fill the result set. Anthropic-only accounts (Anthropic
  has no embeddings API) keep the lexical path with zero extra setup.
- **Knowledge base manager** in Settings — add/edit/delete documents and
  a **Reindex** action to backfill embeddings after adding a key. Both
  drafts and the auto-reply bot are grounded in the retrieved excerpts,
  and the prompt still instructs the model to hand off (auto-reply) or
  say it will follow up (draft) when the KB doesn't cover the question.
  **Migration required:** apply `supabase/migrations/030_ai_knowledge.sql`
  (enables `pgvector`; adds `ai_knowledge_documents` + `ai_knowledge_chunks`
  and an `embeddings_api_key` column on `ai_configs`).

## [0.5.0] — 2026-07-02

Adds the **AI reply assistant** — bring-your-own-key. Each account
pastes its own OpenAI or Anthropic key under **Settings → AI
Assistant**; wacrm calls the provider directly with that key, so
there's no per-seat AI fee and your conversation data never leaves
your own infrastructure for a wacrm-run service. The key is stored
AES-256-GCM-encrypted at rest (same as WhatsApp tokens) and never
returned to the client after saving.

### Added

- **AI-drafted replies in the inbox.** A ✨ button in the composer
  (agent+) reads the recent conversation and drops a suggested reply
  into the box for the agent to edit and send. Read-only server-side —
  `POST /api/ai/draft` never sends or stores anything. Respects your
  business context / persona from the settings prompt.
- **AI auto-reply bot.** When enabled, inbound messages that no
  deterministic Flow consumed and that have no agent assigned get an
  automatic LLM reply. Bounded by a per-conversation cap
  (`auto_reply_max_per_conversation`, default 3) and a clean human
  handoff: when the model can't confidently help — or the customer
  asks for a person — it stays silent and leaves the message for a
  human, and won't auto-reply on that thread again until re-enabled.
  Flows always win over the bot.
- **Settings → AI Assistant** (admin+ to edit): pick provider + model,
  paste your key, add business context/tone, toggle the assistant and
  auto-reply, set the per-conversation cap, and **Test key** against
  the provider before saving.
- Providers: OpenAI (Chat Completions) and Anthropic (Messages) behind
  one interface; model is a free-text field with sensible defaults, so
  you can point it at any current model your key can access.
  **Migration required:** apply
  `supabase/migrations/029_ai_reply.sql` (adds `ai_configs` +
  per-conversation auto-reply columns on `conversations`).

## [0.4.0] — 2026-07-01

Completes the public API (#245): **outbound event webhooks** so
automations can _react_ to activity instead of polling.

### Added

- **Outbound event webhooks (`/api/v1/webhooks`).** Register an HTTPS
  endpoint (scope `webhooks:manage`) to be POSTed to when an event
  happens in your account — `message.received`, `message.status_updated`,
  or `conversation.created`. Manage endpoints with
  `GET/POST /api/v1/webhooks` and `GET/PATCH/DELETE /api/v1/webhooks/{id}`.
  Each delivery is signed with an `X-Wacrm-Signature`
  (HMAC-SHA256 over `timestamp.body`) so receivers can verify
  authenticity and reject replays; the signing secret is returned once
  at creation and stored encrypted. Delivery is best-effort — an
  endpoint that fails repeatedly is auto-disabled after a threshold of
  consecutive failures. See `docs/public-api.md`.
  **Migration required:** apply
  `supabase/migrations/028_webhook_endpoints.sql`.
  ([#245](https://github.com/ArnasDon/wacrm/issues/245))

## [0.3.0] — 2026-07-01

Multi-user accounts ship. Every wacrm install is multi-tenant on the
database side: a single user's signup creates a fresh "account", and
every row is scoped to that account rather than to the user directly.
This release also opens the user-visible **Members** surface — invite
teammates by link, manage their roles, transfer ownership — to all
users. The `'account_sharing'` beta gate that hid it during
development is removed (mirrors the Flows soft-GA in 0.2.0). Existing
self-hosted instances keep working: every existing user is backfilled
as the sole owner of their own account and sees identical data, and a
solo owner who never invites anyone sees the same single-user app they
always did.

### Added

- **Public REST API (`/api/v1`) — groundwork.** A scoped, revocable
  **API key** system so you can drive wacrm from your own scripts and
  automations. Create keys under **Settings → API keys** (admin+),
  grant only the scopes each integration needs, and authenticate with
  `Authorization: Bearer <key>`. Keys are account-scoped and stored
  hashed (plaintext shown once). This release ships the auth layer,
  scopes, per-key rate limiting, the management UI, and a
  `GET /api/v1/me` probe to verify a key. See
  `docs/public-api.md`. **Migration required:** apply
  `supabase/migrations/026_api_keys.sql`. ([#245](https://github.com/ArnasDon/wacrm/issues/245))
- **Public REST API — data endpoints.** Built on the key auth above,
  so external automations can read and drive the CRM:
  - `POST /api/v1/messages` — send a text / template / media message to
    a phone number; finds-or-creates the contact + conversation
    (`messages:send`).
  - `GET/POST /api/v1/contacts`, `GET/PATCH /api/v1/contacts/{id}` —
    list (search + tag filter), create (find-or-create by phone), read,
    and update contacts, including tags (`contacts:read` /
    `contacts:write`).
  - `GET /api/v1/conversations`, `GET /api/v1/conversations/{id}`, and
    `GET /api/v1/conversations/{id}/messages` — browse conversations and
    their message history with delivery status (`conversations:read` /
    `messages:read`).
  - `POST /api/v1/broadcasts` + `GET /api/v1/broadcasts/{id}` — launch a
    template broadcast to a recipient list and poll its progress
    (`broadcasts:send`).
    All list endpoints share one cursor-pagination contract
    (`{ data, meta: { next_cursor } }`). No migration required — the
    scopes already existed and the tables are unchanged. Outbound event
    webhooks (react to inbound messages) are the remaining roadmap item.
    See `docs/public-api.md`. ([#245](https://github.com/ArnasDon/wacrm/issues/245))

### Changed

- **Tenancy moves from per-user to per-account.** RLS on every
  domain table (contacts, conversations, messages, broadcasts,
  automations, flows, pipelines, templates, tags, …) now checks
  account membership via a new SECURITY DEFINER helper
  `is_account_member(account_id, min_role)` instead of
  `auth.uid() = user_id`. The `user_id` columns stay on every row
  for assignment / audit but no longer enforce isolation.
- **WhatsApp config is one-per-account, not one-per-user.** The
  `whatsapp_config.UNIQUE(user_id)` constraint is replaced by
  `UNIQUE(account_id)`.
- **`flow_runs` idempotency key swaps to `(account_id, contact_id)`**
  so two accounts sharing a contact phone number can each run their
  own flows independently.
- **The signup trigger (`handle_new_user`) now also creates a
  personal account** and links the new profile to it as `owner`.

### Changed

- **Flow-media storage is now account-scoped.** Migration 016
  pathed uploaded files under `auth.uid()/...`, which orphaned
  flow media when a teammate left a shared account. New uploads
  go under `account-<account_id>/...` and any account member
  with the right role can edit them. Legacy paths remain
  writable by the original uploader for backward compatibility.
- **Webhook contact lookup now pre-filters in SQL.** Previously
  pulled every contact in an account just to JS-filter to one
  row by phone — fine when account = one user, painful when
  account = team. Pre-filter by phone suffix on the database
  side; re-apply `phonesMatch` on the (typically 0-2 row)
  candidate set.

### Migration required

- `supabase/migrations/020_account_sharing_followups.sql` —
  composite partial indexes on `automations(account_id,
trigger_type) WHERE is_active` and `flows(account_id) WHERE
status='active'` for the engine dispatch hot path; updated
  `flow-media` storage RLS to allow account-member writes under
  the new path convention. Idempotent.

- **Role-aware UI gating across the app.** The inbox composer's
  send button + textarea, the "New broadcast / automation / flow"
  buttons, the "Add pipeline / deal" buttons, and the "Add /
  Import contact" buttons are now disabled-with-tooltip for
  viewers (and for agents on settings-class actions). Choice:
  show-but-disable rather than hide, so the UI never feels
  silently broken to a teammate looking at a feature they don't
  yet have permission for.
- **Sidebar surfaces the active account** above the user info
  whenever the account name differs from your own — i.e. once
  you've renamed the account or joined a shared one. A default
  solo account is named after you, so the strip stays hidden to
  avoid duplicating your name in the footer.
- **Members is open to all users.** The `account_sharing` beta
  flag that hid the Settings → Members tab and the sidebar
  account strip during development is gone; the multi-user
  surface is now part of the standard app. (Same soft-GA move as
  Flows in 0.2.0.)

### Fixed

- **Inbound WhatsApp messages now land in the shared inbox.** The
  webhook + automations + flows engines used to route inbound
  events by `user_id`, which after the 017 migration only matched
  the WhatsApp config owner's automations / flows — teammates'
  rules never fired. PR 8 of the multi-user series flips every
  lookup to `account_id` so any member of the account sees the
  inbound message and any teammate's automation or flow can react
  to it. Also fixes incipient NOT NULL violations on
  `automation_logs`, `automation_pending_executions`, `flow_runs`,
  and `deals` — those tables gained `account_id NOT NULL` in 017
  but the engines hadn't yet been updated to populate it.

### Added

- **Duplicate phone numbers are now prevented across contacts.** A
  phone number can no longer become more than one contact in the same
  account. Adding a contact whose number already exists is blocked
  with a link to the existing record (and a softer warning for
  near-matches that share their last 8 digits); CSV import de-dupes
  within the file and against existing contacts, reporting
  "X imported, Y duplicates skipped". The rule is enforced by a
  database unique index on the normalized number, so the WhatsApp
  webhook, the form, import, and any future path all agree. Existing
  duplicates are merged into the oldest contact on upgrade (their
  conversations, deals, notes, and tags are re-pointed, nothing is
  lost). Closes #212.
- **Configurable default deal currency.** Each account can now pick
  its default currency under **Settings → Deals** (admin+); the app
  previously hardcoded USD throughout. New deals default to it, and
  pipeline-stage totals, the dashboard "Open Deals Value" card, the
  pipeline-value donut, and automation-created deals all use it.
  Existing deals keep the currency they were saved with — totals are
  shown in the account default with no exchange-rate conversion (one
  currency per account). Full guide:
  [Default currency](https://wacrm.tech/docs/settings#deals).
- **Members tab in Settings.** The user-facing surface for the
  multi-user APIs below, available to everyone (no beta flag). From
  Settings → **Members** an admin or owner can: see who's on the
  account with their role and join date, invite teammates by
  generating a one-time share link (pick the role + optional
  expiry), revoke pending invites, change a member's role, remove a
  member, and — as owner — transfer ownership. Recipients accept via
  a public `/join/[token]` page. Full guide:
  [Members docs](https://wacrm.tech/docs/members).
- **Account & member management API** — server-side endpoints
  backing the Members tab. All routes are role-gated and
  return Supabase-RLS-scoped data.
  - `GET /api/account` — caller's account + role. Any member.
  - `PATCH /api/account` — rename the account. Admin+.
  - `GET /api/account/members` — list members. Email visible to
    admin+ only; agents/viewers see name + avatar + role +
    joined date.
  - `PATCH /api/account/members/[userId]` — change a member's
    role. Admin+. Owner promotion/demotion goes through the
    transfer endpoint instead.
  - `DELETE /api/account/members/[userId]` — remove a member.
    Admin+. The removed user keeps their login and is moved to a
    freshly-created personal account (mirror of the signup flow).
  - `POST /api/account/transfer-ownership` — owner only. Atomic
    swap with the named member.
- **Invitation API + redeem flow** — the no-email, link-only
  invite path that powers the Members tab's "Invite member" button
  and the `/join/[token]` accept page.
  - `GET /api/account/invitations` — list outstanding (admin+).
  - `POST /api/account/invitations` — create an invite, returns
    the plaintext token + share URL **exactly once** (we store
    only the SHA-256 hash on the row). Body
    `{ role, expiresInDays?, label? }`. Admin+.
  - `DELETE /api/account/invitations/[id]` — revoke (admin+).
  - `GET /api/invitations/[token]/peek` — public, per-IP
    rate-limited. Returns `{ ok, account_name, role, expires_at }`
    or `{ ok: false, reason }` so the join page can render
    "You're being invited to <Account> as <Role>".
  - `POST /api/invitations/[token]/redeem` — authenticated.
    Atomically moves the caller's profile to the inviter's
    account and cleans up the orphan personal account. Refuses
    with 409 if the caller's current account already contains
    domain data (no silent data loss).

### Migration required

Apply against your Supabase project before deploying this version:

- `supabase/migrations/017_account_sharing.sql` — introduces the
  `accounts` and `account_invitations` tables plus an
  `account_role_enum` type; adds `account_id` to every
  user-scoped table and backfills it; rewrites every RLS policy;
  replaces the new-user trigger. Idempotent. **No data loss** —
  every existing user is mapped to a freshly-created account
  with role `owner` and every existing row of theirs is linked
  to that account.
- `supabase/migrations/018_account_member_rpcs.sql` — adds three
  `SECURITY DEFINER` RPCs (`set_member_role`,
  `remove_account_member`, `transfer_account_ownership`) that
  back the member-management API. They self-check the caller's
  role and raise SQLSTATE `42501` / `22023` on forbidden / bad
  input so the API layer can map cleanly to 403 / 400.
  Idempotent.
- `supabase/migrations/019_invitation_rpcs.sql` — adds two
  `SECURITY DEFINER` RPCs: `peek_invitation` (anonymous read by
  token hash, returns a fixed-shape JSON envelope) and
  `redeem_invitation` (authenticated atomic move + orphan
  cleanup, with a domain-data safety check). Both bypass the
  RLS that would otherwise block their reads/writes. Idempotent.
- `supabase/migrations/021_account_default_currency.sql` — adds
  `accounts.default_currency` (`TEXT NOT NULL DEFAULT 'USD'`, with a
  3-letter-code `CHECK`) backing the configurable default currency.
  Idempotent; existing accounts backfill to `USD`. **Apply before
  deploying** — the app now reads this column when loading the
  account, so an un-migrated database breaks account loading.
- `supabase/migrations/022_contact_phone_dedup.sql` — adds the
  generated `contacts.phone_normalized` column, **merges existing
  duplicate contacts into the oldest** (re-pointing conversations,
  deals, notes, tags, custom values, and broadcast recipients — no
  data loss), then adds a `UNIQUE (account_id, phone_normalized)`
  index. Idempotent. **Apply before deploying** — CSV import reads
  `phone_normalized`, and the index is what enforces de-duplication
  for every write path. The one-shot merge runs inside the migration.

## [0.2.2] — 2026-05-29

Flow nodes can now send media. Closes the most-requested gap from user
feedback after the v0.2.0 Flows launch — flows were text-only and
couldn't deliver an invoice, receipt, product photo, or short demo
video mid-conversation.

### Added

- **`send_media` flow node.** Send an image (PNG / JPEG / WebP), video
  (MP4 / 3GP), or document (PDF, Word, Excel, PowerPoint, TXT) to the
  customer from any point in a flow. Pick a file in the builder, it
  uploads to the new `flow-media` Supabase Storage bucket, and Meta
  fetches the public URL at send time. Optional caption (1024 char cap,
  supports `{{vars.X}}` interpolation); documents also take an optional
  filename shown in the recipient's chat. Auto-advances after send —
  same suspend semantics as `send_message`.
  ([#156](https://github.com/ArnasDon/wacrm/pull/156))

### Migration required

Apply against your Supabase project before deploying this version:

- `supabase/migrations/016_flow_media.sql` — does two things:
  1. Adds `'send_media'` to the `flow_nodes.node_type` CHECK
     constraint. Without this the `send_media` node fails to save with
     a constraint violation.
  2. Creates the public `flow-media` Supabase Storage bucket (16 MB
     file-size cap, image / video / document MIME allowlist) plus
     per-user RLS policies (path prefix = `auth.uid()`). Without this
     the builder's file picker fails on upload. Same shape as the
     `avatars` bucket from migration 008 — the bucket is **public** so
     Meta can fetch the URL without credentials.

The migration is idempotent and safe to re-run.

## [0.2.1] — 2026-05-26

Bug-fix release. Plugs a silent inbound-message drop that triggered
when two users on the same instance saved the same WhatsApp
`phone_number_id`.

### Fixed

- **Inbound WhatsApp messages no longer silently disappear** when two
  users have claimed the same `phone_number_id`. Previously the
  webhook used `.single()` to look up the owning config, which errors
  `PGRST116` for both 0 rows _and_ ≥2 rows — the second user's save
  put the DB into the ≥2-row state and every inbound message was
  dropped while the log misleadingly reported _"No config found for
  phone_number_id"_. Three layers of fix: `POST /api/whatsapp/config`
  now returns **409** when another user has already claimed the
  number, the webhook lookup distinguishes 0 rows from ≥2 rows and
  logs the conflicting `user_id`s, and a new DB constraint
  (`UNIQUE(phone_number_id)`) prevents the bad state at the storage
  layer. Reported in
  [#136](https://github.com/ArnasDon/wacrm/issues/136), fixed in
  [#143](https://github.com/ArnasDon/wacrm/pull/143).

### Migration required

Apply against your Supabase project before deploying this version:

- `supabase/migrations/013_whatsapp_config_phone_number_id_unique.sql`
  — adds `UNIQUE(phone_number_id)` to `whatsapp_config`. **Fails
  loudly with a copy-pasteable resolution hint** if duplicate rows
  already exist; auto-deduping would destroy encrypted tokens, so
  the operator picks which row keeps the number. To check first:

  ```sql
  SELECT phone_number_id, array_agg(user_id) AS owners, count(*) AS n
  FROM whatsapp_config
  GROUP BY phone_number_id
  HAVING count(*) > 1;
  ```

  If that returns rows, `DELETE` the duplicate row(s) you want to
  drop, then re-run the migration.

### Note on multi-user setups

wacrm is intentionally **single-tenant per WhatsApp number**. RLS on
`conversations`/`messages` is `auth.uid() = user_id`, so a second
user physically cannot read messages routed to a different owner —
two users sharing one number was never supported. If you need
multiple humans handling the same inbox, run them under one shared
account.

## [0.2.0] — 2026-05-22

The **Flows** release. Adds a no-code, branching, button-driven WhatsApp
conversation engine that runs alongside Automations. Also ships a
5-theme color picker in Settings and opens Flows to all users.

### Added

#### Flows — branching chatbot conversations

- **Module + schema.** New `flows`, `flow_nodes`, `flow_runs`,
  `flow_run_events` tables with partial unique indexes that enforce
  one active run per contact. Widened `messages.content_type` CHECK
  to accept `'interactive'`; added `interactive_reply_id` column so
  the inbox can render button/list taps.
  ([#112](https://github.com/ArnasDon/wacrm/pull/112))
- **Runner engine.** `dispatchInboundToFlows` parses every inbound
  webhook, decides whether the message is a reply on an active run
  or a fresh trigger, advances the state machine, and reports back
  to the webhook so consumed messages don't also fire automations.
  Idempotent on Meta's `message_id`.
  ([#114](https://github.com/ArnasDon/wacrm/pull/114))
- **No-code builder UI** at `/flows`. Linear-list editor with
  per-node config forms, live validator, draft/active/archived
  status, and a 5-route REST API (`GET/POST /api/flows`,
  `GET/PUT/DELETE /api/flows/[id]`, `POST /api/flows/[id]/activate`,
  `GET /api/flows/[id]/runs`, `GET /api/flows/templates`).
  ([#115](https://github.com/ArnasDon/wacrm/pull/115))
- **Templates + v1.5 node types.** Three starter templates
  (Welcome menu, FAQ bot, Lead capture) cloneable from the New-flow
  dialog. Three new node types: `collect_input` (capture customer
  text into a variable), `condition` (branch on var / tag / contact
  field), `set_tag` (add or remove a tag). `{{vars.X}}` interpolation
  in send_message + collect_input prompts. Per-flow run-history
  viewer at `/flows/[id]/runs`.
  ([#117](https://github.com/ArnasDon/wacrm/pull/117))
- **Stale-run sweep cron** at `GET /api/flows/cron` — marks runs
  past their configured timeout (default 24h) as `timed_out` so
  abandoned conversations free up the contact for new triggers.
  Reuses `AUTOMATION_CRON_SECRET`.
  ([#114](https://github.com/ArnasDon/wacrm/pull/114))

#### Color themes

- **5 color themes** (Violet default, Emerald, Cobalt, Amber, Rose)
  selectable from a new **Appearance** tab in Settings. CSS variables
  scoped under `html[data-theme="..."]`, applied at runtime via
  `dataset.theme`, persisted to `localStorage`. Inline boot script in
  `layout.tsx` replays the choice before first paint so there's no
  flash of the default.
  ([#132](https://github.com/ArnasDon/wacrm/pull/132))
- **Theme tokenization sweep** — every previously hard-coded
  `violet-*` Tailwind class replaced with `primary` tokens across
  ~49 files. Picking a non-violet theme now themes the whole app,
  not just the chrome.
  ([#133](https://github.com/ArnasDon/wacrm/pull/133))

### Changed

#### Flows — soft-GA

- **Flows is now available to every authenticated user.** The
  per-account beta gate is gone; the sidebar entry + page header
  carry a small "Beta" chip as the only remaining signal.
  ([#134](https://github.com/ArnasDon/wacrm/pull/134))
- **Editor UX**:
  - Internal `node_key` + per-button/row `reply_id` identifiers
    hidden behind a per-node "Show advanced" disclosure.
    ([#118](https://github.com/ArnasDon/wacrm/pull/118))
  - `send_list` nodes can have multiple sections.
    ([#119](https://github.com/ArnasDon/wacrm/pull/119))
  - Collapsed node cards show a 1-line content preview per node
    type (text excerpt, button titles, condition summary, etc.).
    ([#120](https://github.com/ArnasDon/wacrm/pull/120))
  - Validation issues are clickable: jump to + flash the offending
    node.
    ([#121](https://github.com/ArnasDon/wacrm/pull/121))
  - Unsaved-changes "● Edited" indicator + `beforeunload` reload
    guard.
    ([#122](https://github.com/ArnasDon/wacrm/pull/122))
  - New-flow dialog actually widens to fit the 3 template cards
    (was capped at 384px by a baked-in `sm:max-w-sm` from shadcn).
    ([#129](https://github.com/ArnasDon/wacrm/pull/129),
    [#131](https://github.com/ArnasDon/wacrm/pull/131))
  - Validation panel pinned to the viewport bottom so
    activate-readiness follows the user as they scroll through nodes.
    ([#130](https://github.com/ArnasDon/wacrm/pull/130))

#### Engine reliability

- **Atomic `execution_count` increment** via SECURITY DEFINER RPC —
  prevents lost counts when two webhooks start runs concurrently.
  Mirrors the automations engine pattern.
  ([#124](https://github.com/ArnasDon/wacrm/pull/124))
- **Preload all flow_nodes once per dispatch** — one SELECT per
  inbound instead of one per advance-loop iteration. A 5-node
  auto-advance chain now costs 1 round trip, not 5.
  ([#125](https://github.com/ArnasDon/wacrm/pull/125))
- **Wasted re-read dropped** after reprompt reset; `loadActiveRun`
  switched to defensive `.limit(1)` so a migration glitch producing
  duplicates can't crash dispatch.
  ([#126](https://github.com/ArnasDon/wacrm/pull/126))

### Security

- **PII redacted from `reply_received` event payload** — customer
  text is no longer persisted to `flow_run_events.payload`; only
  the length is. A `collect_input` prompt asking "what's your card
  number?" used to leave the PAN sitting in the events table.
  ([#123](https://github.com/ArnasDon/wacrm/pull/123))
- **Constant-time cron-secret compare** on `/api/flows/cron`
  (`crypto.timingSafeEqual`) to close a theoretical
  timing-side-channel on the `x-cron-secret` header check.
  ([#127](https://github.com/ArnasDon/wacrm/pull/127))

### Fixed

- **`/flows` no longer spuriously redirects to `/dashboard`** when
  navigating in. Root cause: `useAuth` flipped `loading: false`
  before the profile fetch resolved. `use-auth` now exposes a
  separate `profileLoading` boolean.
  ([#128](https://github.com/ArnasDon/wacrm/pull/128))

### Migration required

Apply, in order, against your Supabase project:

1. `supabase/migrations/010_flows.sql` — Flows core tables, indexes,
   RLS policies, and the `messages` schema widening.
2. `supabase/migrations/011_profile_beta_features.sql` — adds the
   `profiles.beta_features` column. Surviving for future betas;
   Flows no longer reads it.
3. `supabase/migrations/012_flows_increment_counter.sql` — atomic
   counter RPC. Without this the engine still runs but
   `flows.execution_count` is racy.

Each migration is idempotent — safe to re-run if you're not sure
whether you applied a previous one.

### Removed

- **`src/lib/flows/feature-flag.ts`** + its tests. Flows is open to
  all users; the `profiles.beta_features` column itself survives
  for future beta gates.
  ([#134](https://github.com/ArnasDon/wacrm/pull/134))

---

## [0.1.1] — 2026-05-19

### Added

- Chat actions in the inbox: emoji reactions, reply-with-quote, and
  copy-text on individual messages. Hover on desktop, long-press on
  touch. Outbound reactions and replies forward to WhatsApp via the
  Cloud API; inbound reactions and swipe-replies from customers
  arrive through the webhook and appear in real time.

### Migration required

- Apply `supabase/migrations/009_message_actions.sql` to your
  Supabase project. It adds `messages.reply_to_message_id` and the
  new `message_reactions` table (with RLS and realtime). The
  migration is idempotent — safe to re-run.

### Changed

- The webhook no longer stores inbound customer reactions as fake
  text messages. They are written to `message_reactions` instead,
  so any custom queries that counted reactions as messages will
  need updating.

---

## [0.1.0]

Initial template release. Core CRM: inbox, contacts, pipelines,
broadcasts, automations (with a Wait-step cron drain), WhatsApp
Cloud API integration, Supabase auth + RLS.
