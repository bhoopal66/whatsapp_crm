# Phone system (Yeastar P-Series)

Operator notes for connecting a Yeastar P-Series PBX (Cloud, Software or
Appliance edition) to Taamul Connect. Calls land on the customer's
timeline next to their WhatsApp chat. The database side is migration
`089_pbx.sql`.

Everything below is set in **Settings → Phone system** by an owner or
admin of the workspace that owns the PBX.

## 1. What to enable on the PBX

| On the PBX                                                                    | What for                                                                                                                                                                    | Needs                                                                                                                                                         |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Integrations › API** — an application with **Client ID / Client Secret**    | Everything the server does: listing extensions, click-to-call, call control, call records, recording downloads                                                              | —                                                                                                                                                             |
| **Linkus SDK** — **AccessID / AccessKey**                                     | The browser softphone (agents answer and place calls in the CRM)                                                                                                            | **Ultimate** plan, firmware **84.12.0.32** or later                                                                                                           |
| **Webhook push** to the URL shown in Settings, with a **32-character secret** | Live call events, registration and presence                                                                                                                                 | Firmware **84.20.0.21** or later. On older firmware run the **WebSocket gateway script** instead, which relays the same events                                |
| **Extension Status Monitor**                                                  | Presence, registration and per-extension call state                                                                                                                         | —                                                                                                                                                             |
| **API permissions** on the same application, for the Linkus-style features    | Presence (_My status_): extension read and update. Voicemail: read, download, mark read, delete. Ring groups and queues: ring group read, queue read, agent login and pause | The call, extension and recording permissions the rest of the CRM already uses stay on. Without a permission, only that feature fails, with the PBX's refusal |

Paste the Client ID and Secret (and the SDK pair, if you use the
softphone) into Settings and press **Test connection**. Secrets are
stored encrypted and never shown again; leave a field empty to keep the
stored value. The Client ID works the same way: only its last four
characters are shown, and an empty field keeps it. On the Cloud edition the address must be `https://`. Changing the address of a saved connection means typing the Client Secret again (and the SDK pair, if stored): a stored secret is never sent to a new host.

### Two PBX limits to respect

- **8 tokens per API application.** The server keeps one shared token
  per connection (and one for the SDK credentials) in the database, so
  every process reuses it. Don't point a second system at the same API
  application, or the two will compete for its 8 tokens; give it an
  application of its own.
- **5 failed logins block the server's IP.** Unblocking it takes an
  admin on the PBX. A refused Client ID / Secret is never retried: the
  test button, an extension sync, and anything else that logs in, back
  off for five minutes after a refusal, and the button answers "wait"
  meanwhile. Correct the credentials (saving them clears the backoff)
  rather than pressing it again.

## 2. Routing calls to workspaces

One PBX can serve several workspaces.

- **Numbers.** Under **Phone numbers → workspace**, list each dialled number (DID) and the
  workspace its calls belong to. Numbers are stored as digits only, and
  each may be listed once. You can route a number only to a workspace
  where you are an owner or admin.
- **Extensions.** **Sync extensions** reads every extension off the PBX.
  New ones arrive unmapped in this workspace; a sync never changes an
  existing mapping, only the registration status. Map each extension to
  a person, in any workspace where you are an owner or admin. Only an
  active owner, admin, team leader or agent can hold an extension (not a
  viewer or a bank guest), and a person holds at most one extension per
  workspace. Turn on **Softphone** for people who should take calls in
  the browser, and leave **Presence** on (the default) for those whose
  status the team should see.

  That status colours the person's dot wherever it shows (team chat
  DMs and member lists, the inbox assign picker and handler, a
  customer's "Team on this customer"), live within a couple of
  seconds: red on a call (ringing or busy), grey with a line on Do not
  disturb, the away colour on away, lunch or business trip, grey off
  work. Otherwise, and for anyone without a monitored extension, the
  dot is the app's own presence (online, away, offline). Yeastar
  reports a status only when it changes, so the one a person chose
  holds until they choose another. A call state lapses after 10 minutes
  without news; the phone-system cron (section 10) refreshes it while
  the call is live, so a long call stays red. Turning **Presence** off,
  or deleting the extension, removes the status; remapping the extension
  moves it to the new person (migration 101). A removed status leaves
  open screens within a minute. A workspace with no extensions does not
  watch the phone at all.

## 3. Recording rules

- **Announcement.** Configure the English/Arabic recording notice on
  the PBX to play before **every** recorded call. A recording fetched
  while the workspace requires the notice (the default) is marked as
  announced on that basis; the basis is kept on the call
  (`meta.announcement_basis`: `pbx_prompt` while required,
  `not_required` while switched off). A recording fetched while the
  notice was switched off is not marked announced, so it is held from
  playback whenever the requirement is on.
- **Bank numbers.** List the bank staff numbers (with the bank's code)
  under **Bank numbers**. While **Exclude bank numbers** is on (the
  default), calls with those numbers are kept unrecorded. Leave it on
  until each bank's DSA terms allow its calls to be recorded. Saving
  the list deletes only the numbers removed on that screen (the PUT
  sends the numbers it loaded as `loaded`): a number a deal-room call
  listed after the screen loaded (section 11) stays listed.
- **Retention.** Empty keeps recordings; otherwise 1 to 3650 days. How
  long to keep them is an open legal decision for each workspace. With
  a period set, the phone-system cron (section 10) deletes the CRM's
  copy of every recording whose **call** is more than that many days
  old, except recordings under legal hold. A call's age runs from the
  later of its start time as the PBX reported it and the moment the CRM
  first recorded the call: never from the day the audio was copied, so
  a late download never lengthens its life, and a PBX clock that is
  wrong cannot make a fresh call look old and delete its audio at once.
  A recording not yet copied whose call is already past the period is
  never downloaded: the call is marked *not stored in the CRM*, and the
  PBX keeps its own copy. Only the audio goes: the call,
  its notes and its outcome stay, and the customer page says the
  recording was deleted under the retention period. The PBX's own
  copies are not touched. The recording row is marked deleted first
  (from then on it cannot be played) and the audio removed after; audio
  a run could not remove is taken by the orphan sweep. Each run's
  deletions are written to the phone-system audit log
  (`recording_retention`). The section shows what is kept now: how many
  recordings, the oldest call, how many are under legal hold and how
  many the period has deleted so far. The cron deletes on every run
  (usually each minute), not once a day, so saving a first or a shorter
  period asks first and says how many recordings it deletes now,
  counted by the run's own rule (the call's age as above, legal holds
  left out, this workspace only); they go within minutes, and that
  cannot be undone. The server holds the same rule: it refuses a first
  period, or one shorter than the period in force, unless the save
  carries that confirmation, and the screen sends the period only when
  it was changed. So a page opened before another admin lengthened the
  period cannot shorten it back unasked when someone saves another
  setting from it. A period counts only once saved through Settings
  (migration 093 stamps it): one saved before 093, while the screen
  stored it and nothing acted on it, deletes nothing after the upgrade
  and does not stop downloads. Settings shows it as **saved but not
  enforced yet**; saving it again, with the same count and
  confirmation, starts the deletions. Clearing the period stops them.
- **Legal hold.** An owner or admin can place or lift a legal hold on a
  recording from the customer page (**Place legal hold**), with a
  reason of at least five characters. Each change is written to the
  append-only audit log with who made it and why (`legal_hold_placed`,
  `legal_hold_lifted`). A held recording is kept past the retention
  period and blocks the owner's erasure of that customer; a recording
  already deleted cannot be held. Lifting the hold of a recording whose
  call is already past the period asks first: once lifted, it is
  deleted on the next cron run.
- Recordings sit in a private bucket. Every play is logged, and the
  owner can erase a customer's call records on request, unless a
  recording is under legal hold. The erasure takes every call of the
  workspace that is linked to the customer, that listed them as a
  possible match, or that came from their number (matched as incoming
  calls are, so also calls from before the contact existed). It deletes
  the recordings and clears the notes, the outcome, the caller's number,
  the recording's file name and the match details. What stays is the
  bare call: time, duration, extension, direction and status. Audio the
  erasure could not delete at once is swept by the phone-system cron
  (section 10) once it is an hour old.

## 4. What is never done

- **No WhatsApp calling.** Calls go through the PBX only; nothing places
  or answers a call over WhatsApp.
- **Nothing from a call is ever sent to a customer automatically.** No
  recording, transcript, note or disposition leaves the CRM by itself.
  A missed call can at most prepare a WhatsApp _draft_ (if the workspace
  turns that on), which a person reviews and sends.

## 5. Admin API

The settings screens use these routes (owner or admin of the active
workspace; errors are `{ error }`):

| Route                                                          | Does                                                                    |
| -------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `GET/PUT /api/pbx/connection`, `POST /api/pbx/connection/test` | The connection, its webhook URL, the test                               |
| `GET /api/pbx/extensions`, `POST /api/pbx/extensions/sync`     | Extensions with their mapping; sync from the PBX                        |
| `PATCH /api/pbx/extensions/{id}`                               | `{ userId?, accountId?, softphoneEnabled?, presenceMonitor? }`          |
| `GET/PUT /api/pbx/routes`                                      | `{ routes: [{ didNumber, nameOnPbx?, accountId }] }`, replaces the list |
| `GET/PUT /api/pbx/settings`                                    | Recording and missed-call settings                                      |
| `GET/PUT /api/pbx/bank-numbers`                                | `{ bankNumbers }`; PUT adds `loaded`, deletes only those removed        |

## 6. Live events

The PBX pushes to `POST /api/pbx/yeastar/events/{token}` (the URL shown
in Settings). Each request must carry `X-Signature`, the Base64
HMAC-SHA256 of the raw body with the webhook's 32-character secret; a
connection with no secret stored refuses every push. Optionally set
`PBX_WEBHOOK_ALLOWED_IPS` (comma list, read through
`EDGE_CLIENT_IP_HEADER`) to accept the PBX's address only.

- **Workspace.** An inbound call belongs to the workspace its dialled
  number routes to. A number with no route files the call under the
  PBX's own workspace, flagged _unrouted_ with the number kept, so an
  admin can add the route. Other calls follow their extension's
  workspace.
- **Unrouted calls** are listed for owners and admins under Calls ›
  Unrouted (`/calls?tab=unrouted`), newest first with the number
  dialled; anyone else who opens that link is shown Missed calls.
  Above them, each dialled number called in the last 30 days with its
  count of unrouted calls and the latest one, the most recently called
  first, and a link to the routes in Settings › Phone system. A call
  stays flagged after its number gets a route: a number whose latest
  call stops moving has been fixed, sinks down the list and drops off
  it after 30 days. An erased call keeps the flag and the dialled
  number, but not the caller's.
- **Several records for one call.** The PBX may send more than one
  end-of-call record for a call (a transfer, a ring group, a no answer
  followed by voicemail or a failed record). The CRM keeps them all and
  combines them: the call is answered if any record is answered; talk
  time is the longest answered record; the start is the earliest; a
  trailing failed record never hides a no answer; and the answering
  extension gets the call. A missed-call task opened by an early no
  answer record is closed when an answered record follows, unless other
  calls were folded into it. Calls stored before this release can be
  repaired with `npx tsx scripts/pbx-repair-call-legs.ts` (a dry run
  that lists what would change), then `--apply`.
- **Customer.** The caller is matched only among that workspace's
  contacts. Several matches link none; the candidates are kept on the
  call for the person to pick.
- **Missed calls** (an inbound call that ends unanswered, busy,
  abandoned or in voicemail) open one _Call back_ task, due after the
  workspace's missed-call delay, and ring its holder's bell. The task
  goes to a person the call rang (an active owner, admin, team leader
  or agent of the workspace): the chat's assigned agent or the
  contact's owner when the call rang them, else the first person it
  rang. A call that rang nobody goes to the chat's assigned agent, else
  stays unassigned (admins see it; no bell). It never goes to whoever
  created or imported the contact merely for that. A ring-group call a
  colleague answered is not missed.
- **Repeat missed calls** from the same caller (the same contact, else
  the same number) while their _Call back_ task is still open fold into
  that task: its note counts the calls ("3 missed calls, the latest …"),
  `meta.call_ids` lists them, the due time stays, and no second task or
  bell is made. If the task was unassigned and the new call rang
  someone, it is handed to them, and the assignment bell rings once.
  Once the task is done or cancelled, the next missed call opens a new
  one.
- **Who it rang.** Every person an inbound call rang is kept on the
  call (`calls.meta.rang_user_ids`, first rung first), gathered from
  each ringing frame, so it survives the screen pop going away. The
  customer page's timeline names them ("rang Sara and Faisal for
  24 s"), as profiled in the viewer's workspace. Calls from before
  this was kept name only the extension's person, if any. An erased
  call loses the list with the rest of its details.
- **WhatsApp draft** (Settings › Phone system, off by default). While
  it is on, a missed call on the customer page offers **Draft
  WhatsApp**, which opens the customer's chat with "Hi {name}, sorry we
  missed your call — how can we help?" in the composer (also when that
  chat is already open; typed words are kept) for the person to edit
  and send. Nothing sends it by itself. A do-not-contact or opted-out
  customer is never offered one: the call says why instead. On the same
  terms (a known contact with a chat, neither do-not-contact nor opted
  out) the missed-call task's note says the draft is ready.
  The draft is a **human-sent message**, so the consent register is
  checked again at both ends. The composer reads it when it picks the
  draft up, and drops a draft left for a customer marked since, with a
  notice. A send whose text began as the draft (edits included, until
  the box is emptied) carries `origin: "missed_call_draft"` to
  `POST /api/whatsapp/send`, which refuses it before the gateway with a
  409 `do_not_contact` or `opted_out`; that refusal offers no Retry. An
  ordinary typed reply carries no origin and is not gated by the
  register. The TypeSafe guardrail does not apply to the draft: it
  screens the AI bot's replies, not what a person sends.
- **Recordings** are marked for fetching, or kept unrecorded (_held_)
  for a bank number while **Exclude bank numbers** is on.
- Every event is stored once (re-sends are ignored); one that cannot be
  processed keeps its error on the stored event.

**The Events card** in Settings states what the server recorded
(migration `104_pbx_health.sql`):

- whether events arrive: _Receiving events_ while the latest is under
  15 minutes old, _Quiet_ after that, _No events yet_ before the first.
  Quiet is not a fault by itself; a night without calls is quiet too.
  An open tab reads the connection again about once a minute while it
  is in view, so the verdict does not go stale;
- the path that carried the latest event: Yeastar's webhook push or the
  WebSocket gateway. A retried or late old event moves neither the time
  nor the path. A stamp more than a minute ahead of the database's clock
  (a wrong clock on the app server) is stored as that clock plus a
  minute, so it cannot hold every later event back;
- the API sessions the CRM holds: 0 or 1 of the 8 Yeastar allows an
  API application, because one cached token serves every person and
  process (section 1);
- the gateway's latest call-record backfill: when, how many calls it
  added and how many it could not. A webhook-only install never
  backfills, so it says _never_.

**The silence alert.** When no event has arrived for 15 minutes, all of
them inside working hours (09:00–20:00 Dubai, the call-backs' window),
the owners and admins of the workspace that owns the connection get one
bell, _No phone system events for …_, which opens Settings → Phone
system. When events arrive again they get one more, _Phone system events
are arriving again_, at any hour. It rings only for a link that was
delivering earlier the same working day and then stopped: webhook
delivery has no heartbeat, so silence before the day's first event could
as well be a call centre that opens late or is closed, and would ring
every such morning. A connection that never received an event never
alerts, and a quiet night does not either. The PBX cron checks every
pass (section 10); `pbx_connection_silence()` moves the state and rings
in one statement, so overlapping passes ring once.

## 7. Running the gateway

Firmware without webhook push (before 84.20.0.21) relays events through
`scripts/pbx-gateway.mjs`, a plain Node 22 process that holds the PBX's
event socket and posts each frame to the app. It never sees the PBX
credentials. Set:

| Variable             | Value                                                               |
| -------------------- | ------------------------------------------------------------------- |
| `APP_URL`            | The app's address as the gateway reaches it, e.g. `http://app:3000` |
| `PBX_GATEWAY_SECRET` | A long random secret; the app must have the same value              |
| `PBX_CONNECTION_ID`  | Optional: which PBX connection, when more than one is configured    |

Run it one of three ways:

- `APP_URL=… PBX_GATEWAY_SECRET=… npm run pbx:gateway`
- Docker: `docker compose --profile pbx up -d` starts the `pbx-gateway`
  service (`node:22-alpine`, reading `.env.local`).
- systemd: a unit with `ExecStart=/usr/bin/node /opt/taamul/scripts/pbx-gateway.mjs`,
  the variables in `Environment=` lines (or an `EnvironmentFile=`), and
  `Restart=always`.

Run one gateway per PBX.

After a reconnect the gateway asks for the gap's call records
(`POST /api/pbx/gateway/backfill`, the last 24 hours at most), and each
is stored as the Call End event it would have been. The Events card
shows the latest backfill. Identical records (overlapping pages) are
read once; records that differ but share a uid are separate legs of
one call and are all kept.

### Importing past calls

Calls made before the webhook or gateway was connected are not in the
CRM. Import them from the PBX's call records with

```bash
npx tsx scripts/pbx-import-cdr.ts --from 2026-10-27T00:00:00Z --to 2026-10-27T10:48:00Z
npx tsx scripts/pbx-import-cdr.ts --from … --to … --apply
```

run from the app's directory (it reads `.env.local`: the Supabase URL,
the service-role key and `ENCRYPTION_KEY`). `--connection <id>` picks
the connection when there are several. The window is at most 24 hours
and may not end in the future. The first run is a dry run: totals, the
calls already in the CRM (always skipped, because the live feed owns
them) and per extension the calls, answered calls and talk minutes.
`--apply` stores each record as its Call End event, deduped like any
other, and writes the calls row as a live call end would: legs
combined, contact, workspace routing, extension owner and recording
state (so the recordings cron fetches the audio, bank numbers held as
usual). It never opens or closes a missed-call task, rings a bell,
settles a call-back, touches a screen pop or moves the Events card's
last-event clock. The run shows on the Events card as the latest
backfill. A record that fails is removed again, so the next run
retries it.

## 8. Recordings

A call the PBX recorded is marked _pending_ when it ends, and the
phone-system cron (below) copies the audio **once** into the private
`call-recordings` bucket (`account-<id>/calls/<call id>.<ext>`, with
its SHA-256 and size), one download at a time. The PBX's own download
link (valid 30 minutes) is never stored. A busy answer from the PBX
ends the run and the next run continues; any other failure is retried,
up to five times, before the call is marked _failed_.

Calls _held_ for a bank number and _erased_ calls are never fetched.

**Pausing storage.** When the server's disk is short, an admin can
turn off **Store call recordings on this server**, the first switch
under **Recording rules**, and save. This pauses the CRM only: it stops
downloading recordings and never contacts or changes the PBX, so
Yeastar keeps recording calls as before and keeps its own copies. A
call that ends while storing is off, or that was still waiting for its
download, is marked _not stored_ and is **never downloaded later**,
also after the switch is turned back on; the customer page says the
recording was not stored in the CRM and is still on the PBX.
Recordings already stored stay. While the saved setting is off, the
section is marked _Paused_.
Playback goes through the server, which logs every access before it
signs a short-lived link.

## 9. Call-backs

When a customer taps **Call me back**, the journey opens a CALLBACK
task and a call-back request. The cron dials a request once it is due,
only between **09:00 and 20:00 Dubai time**, from the extension of the
request's assignee (else the contact's owner) in that workspace, and
only while that extension is idle (and registered and available, when
known). The PBX rings the owner first, then the customer, who hears the
recording notice before the owner is connected.

- A customer on **do-not-contact** is never dialled (the request is
  _skipped_).
- While the owner is on a call or away, the request waits.
- An answered call marks the request _done_ and closes its task. An
  unanswered one is tried again; after three attempts the request is
  _failed_, and the task stays open for a person.
- A request still _dialing_ 30 minutes after its last update has lost
  its result (the server stopped mid-dial, or the PBX's call-end event
  never arrived). The next cron run releases it, at any hour. If the
  call's record shows it ended, the request is settled by that outcome,
  as above. A call still on the line is left alone. With no trace of a
  call, it counts as one unanswered attempt ("no result came back from
  the PBX").

## 10. The phone-system cron

`GET /api/pbx/cron` (header `x-cron-secret` = `AUTOMATION_CRON_SECRET`)
first keeps the red dot of anyone still on a live call (above), then
rings the outcome reminders (where outcomes are mandatory, at most
200 a run; see **The wrap-up** below) and the silence alert (section
6), then
fetches pending recordings, dials due call-backs, retries events that
failed to process (three times each), purges old rows, deletes
recordings past the workspace's retention period (section 3; up to
1,000 a run, oldest calls first), and deletes recording audio that no
live recording points to any more (left by an erasure or a retention
run, at most 500 files a run). Each run
stops starting work after 45 seconds. The automations cron also runs it,
at most once a minute, so an install that already pings
`/api/automations/cron` needs nothing more. A PBX connection that is
backing off after a refused login is skipped until the backoff ends.

## 11. Calling from the CRM

**Off unless switched on.** The CRM places no calls unless the app was
built with `NEXT_PUBLIC_PBX_OUTBOUND_CALLS=on` (exactly `on`; it is
inlined at build time, so changing it needs a rebuild). While it is off,
every Call and Call back button is hidden (inbox, customer page, contact
detail, Calls screen, Colleagues, voicemail, groups and queues, deal-room
members, team-chat DMs), the Calls screen offers no Keypad, and
`POST /api/pbx/calls/dial` answers 403 `outbound_calls_off`. The
call-back dialler dials nothing: each due "Call me back" request is marked
`skipped` (`outbound_calls_off`) and its CALLBACK task stays open for a
person. Incoming calls, the call log, missed-call tasks, recordings,
voicemail, presence and the controls of a call already in progress (hang
up, hold, transfer, keypad tones) are unaffected. The rest of this
section describes the behaviour once it is on.

- **Click-to-call rings your own extension first.** The PBX rings the
  extension mapped to you in this workspace, then the customer; an
  extension cannot be chosen in the request. With no extension mapped,
  calling is refused.
- **Who may dial what.** Every agent and above may dial any extension
  or any outside number, typed in or picked from a list. Viewers and
  bank guests cannot dial. The do-not-contact rule below applies to
  everyone. Previously, typing a number was limited to team leaders and
  above.
- **Keypad.** The Calls screen's _Keypad_ tab (agents and above who have
  an extension mapped) is a dial pad for an extension or outside number.
  It remembers the numbers you dialled last in your own browser, not on
  the server. It dials through the same route as every other Call
  button. Tones during a live call are sent from the in-call panel's
  own keypad, not this one.
- **Colleagues.** The _Colleagues_ tab (same people as the keypad)
  lists the extensions on your phone system, people with a known name
  first, sorted by name, then the other extensions by number. A dot
  shows the extension's state as the phone reports it, only for an
  extension whose presence is monitored (section 1). Your own extension
  has no Call button. Each row has a Call button and the list can be
  searched.
- **Call a colleague from team chat.** A 1:1 direct message with
  someone who has an extension shows a _Call_ button in its header, for
  staff who have an extension themselves. Group DMs and channels have
  none. It dials through the same route.
- **Transfer.** The in-call panel's blind transfer takes any extension.
  An outside number is narrower than dialling: below team leader it must
  belong to a customer you can see. Never a do-not-contact customer's
  number.
- **Browser softphone or desk phone.** When an admin switches the
  browser softphone on for your extension (and the PBX has Linkus SDK
  credentials), the call rings in the CRM tab. Otherwise the same call
  rings your desk phone or Linkus app on that extension.
- **Do-not-contact.** A customer marked do-not-contact cannot be
  called, through any of their contacts or by typing the number. An
  owner or admin can override with a reason, which is logged before
  the PBX is asked.
- **Calling someone in a deal room.** The room's Members panel shows
  _Call_ beside each customer, partner and bank officer who was let
  into the room (staff from agent up who can post in the room; never
  to a bank guest, never our own number, nobody once the room is
  closed). The request names only the person: the CRM reads their
  number itself and dials it from your own extension, so no number
  from the browser is dialled this way. (Room staff can still read
  the participants' numbers, which the panel shows masked.) Someone
  who cannot post in the room is told only that, nothing about the
  person. The do-not-contact rule applies to the number across the
  workspace and to the person's linked contact.
- **Calling a bank officer from a deal room** is allowed only while
  that bank's guests are on (the bank's guest switch), and the call is
  a bank call. Just before dialling, the CRM lists the officer's
  number under **Bank numbers** with the bank's code (a number already
  listed keeps its row; removing it there leaves later calls with it
  recordable until the next call from a room lists it again). While
  **Exclude bank numbers** is on (the default), the call is therefore
  unrecorded as far as the CRM goes: its recording is held, never
  downloaded, kept or played. While it is off, the call is refused
  (409 `bank_calls_recorded`) unless the bank's **Calls with this bank
  may be recorded** switch is on, which says its DSA terms allow it
  (off by default). Whether the PBX itself records the call is the
  operator's PBX configuration: if its extension or DID rules record
  it, the PBX keeps its own copy, so exclude bank numbers there as
  well where a bank's DSA terms require it.
- **The Calls screen** (sidebar › Calls: staff only, shown once the
  workspace has an extension) lists the last 7 days' missed calls and
  the call log. _Call back_ on a missed call dials the customer's
  contact or, for a caller with no contact, the number (any agent, as
  for a typed number). A do-not-contact customer's _Call back_
  is disabled with the reason; an owner or admin can still call, with
  a reason that is logged.
- **Who sees a call** (migration 113). Owners and admins see every call of
  the workspace. A team leader sees the calls they were on or that rang
  their phone, and the same for the people of the teams they lead. Agents
  and viewers see the calls they were on or that rang their phone. Everyone
  also sees the calls of the customers they can see (contacts they created,
  or whose chat they own or are assigned), so a customer's page shows that
  customer's call history. Recordings follow the call. The incoming-call
  card shows the same way: owners and admins every live call, a team
  leader the ones ringing or answered by them or their teams, everyone else
  only their own. Bank guests see no calls.
- **Tabs on the Calls screen.** Who is offered each:

  | Tab                    | Who                                                                        |
  | ---------------------- | -------------------------------------------------------------------------- |
  | My calls               | Everyone who can open the screen; the tab it opens on                      |
  | Keypad                 | Agents and above who have an extension                                     |
  | Missed calls           | Everyone who can open the screen                                           |
  | Team calls / All calls | Team leaders (Team calls); owners and admins (All calls)                   |
  | By person              | Team leaders, admins and owners                                            |
  | Voicemail              | Agents and above who have an extension                                     |

  Colleagues, Unrouted and Groups & queues were taken off the screen on
  2026-10-27; a link to one opens My calls. Unrouted calls still count in
  the Call report, under calls with no person.

  _My calls_ lists the calls you placed, took or were the other party
  to, and the ones that rang your phone. _Missed calls_ shows your own
  missed calls of the last 7 days and the missed-call tasks assigned to
  you; a team leader can switch it to _Team_, an owner or admin to
  _All_ (every missed call and task they can see). _Team calls_
  / _All calls_ is every call you can see. A link to a tab you are not
  offered opens My calls.

  The lists hold people's calls: an agent sees only their own, a team
  leader their own and those of the teams they lead (calls they took,
  were the other party to, or that rang them), and an owner or admin
  everyone's. A colleague's call with a customer you can see is not on
  your Calls screen; it stays on that customer's page.

- **By person** (the Calls screen's _By person_ tab: team leaders, admins and
  owners). For today, this week (from Monday), this month or up to 92
  whole days, in the workspace's time zone (the one saved in Team
  activity settings, else the viewer's): per person, incoming calls
  answered, outgoing calls, missed incoming calls, total and average
  talk time, average ring time of answered incoming calls, and outcomes
  plus _no outcome_ (answered calls nobody gave one), then the
  workspace total. Owners and admins see everyone; a team leader the
  people of the teams they lead and themselves, with the workspace
  total still counting every call. Calls between colleagues are left
  out. **Missed-call attribution:** a call counts for the person whose
  extension the PBX reports it to. A missed call that rang someone's
  own extension is theirs. A ring group or queue rings several people
  at once (the customer page lists them), but the report does not
  share a missed call out among them: when nobody answers the call has
  no person, and it is counted once, under
  _No person_ and in the total, never once per person it rang. A call
  to an extension with no CRM login is counted the same way.
- **Outcome and notes.** After a call, the person on it (or a team
  leader and up) sets the outcome (interested, documents requested,
  call back, not eligible, wrong number) and notes, up to 4,000
  characters. Nothing is sent to the customer. A call matched to the
  wrong customer can be re-linked.
- **The wrap-up.** When a call you answered ends, the call panel turns
  into a two-minute wrap-up with a countdown to add the outcome and a
  note, then closes by itself. Reloading the page within those two
  minutes brings it back (your own calls only, in this workspace). A
  team leader, admin or owner can make outcomes **mandatory**
  (Settings → Phone system; leaders see only that switch, every other
  phone setting stays with admins). Then the wrap-up cannot be closed
  without an outcome, stays open past the two minutes, and comes back
  after a reload for up to an hour after the call. Two minutes after
  such a call ends with no outcome, the person on it gets **one** bell,
  "Add the outcome for your call with …", linking to the customer page
  (the Calls screen for an unknown caller). Only calls that ended in the
  last hour **and after the rule was switched on** are reminded of or
  brought back after a reload, so switching it on never reaches older
  calls (`pbx_settings.mandatory_disposition_since`, kept by a trigger:
  set when the switch goes on, cleared when it goes off). A change to
  the switch reaches open screens when a wrap-up starts or the tab
  regains focus, without a reload.
- **A live call always has the panel.** Answering a call while a
  wrap-up is open (or reloading mid-call) shows the live call, with its
  hangup, hold, mute and transfer controls; the unfinished wrap-up waits
  and re-opens once the live call is over and its own wrap-up closed.
  Several waiting wrap-ups re-open newest first. One whose two minutes
  ran out while it waited comes back only if its outcome is still owed
  (mandatory, none chosen, within the hour). If a ticked call card
  cannot be posted when the wrap-up closes by itself, it is tried three
  times, then the wrap-up closes with an error saying the card was not
  shared (the outcome and notes are saved on the call).
- **Call cards in team chat (103).** The wrap-up's call card, and
  **Share to chat** on the Calls screen and the customer page, post a
  card of the call to a team or private channel or a deal room's Team
  notes (never to the customer or a WhatsApp group). The card is read
  from the call each time: only colleagues who can see the call see its
  details, and an erased call's card shows nothing but that it was
  erased. See `docs/internal-chat.md`.
- **Recordings.** An agent or above who can see a call can play its
  recording;
  only team leaders, admins and owners can download one (**Download**
  on the customer page's player). Every play,
  download and attach is logged (owners and admins can read the log),
  and the link the browser gets is valid for five minutes. A recording
  is held, for everyone, until the English/Arabic notice is confirmed
  as played (unless the workspace turned that requirement off).
- **Attaching to a deal** files a reference to the recording on the
  deal, not a copy: the audio stays in the private bucket, and playing
  it from the deal goes through the same checks and log.

The routes (errors are `{ error }`; recordings and attach need an
agent or above, the reads a viewer or above, never a bank guest):

| Route                                | Does                                                                                                                                                                                                      |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/pbx/calls/{id}/recording` | `{ action: 'play' \| 'download' }` → `{ url, expiresAt }` (409 if held)                                                                                                                                   |
| `POST /api/pbx/calls/{id}/attach`    | `{ dealId }` → `{ fileId }`, a reference row in the deal's files                                                                                                                                          |
| `GET /api/pbx/calls`                 | `?contactId=&scope=mine\|my_missed\|missed\|all\|unrouted&from=&to=&limit=` → `{ calls }`; `mine` (the default) includes calls that rang you; `unrouted` (owner and admin) adds `numbers: [{ didNumber, calls, lastAt }]`, over the last 30 days unless `from` is given |
| `GET /api/pbx/calls/summary`         | `?contactId=&tz=` → `{ total, answered, missed, talkSeconds }`, this month (default Asia/Dubai)                                                                                                           |
| `GET /api/pbx/calls/wrap-up`         | `{ calls, mandatory }`: your calls still owing their wrap-up, newest first (may be empty)                                                                                                                 |
| `GET /api/pbx/calls/report`          | `?period=today\|week\|month\|custom&from=&to=&tz=` → `{ report, range }` (team leader and up)                                                                                                             |
| `PUT /api/pbx/me/presence`           | `{ status }` → `{ status }`; your own extension's status (section 12)                                                                                                                                     |
| `GET /api/pbx/voicemail`             | Your own voicemail box (section 13)                                                                                                                                                                       |
| `GET /api/pbx/groups`                | Ring groups and queues (section 14)                                                                                                                                                                       |
| `POST /api/pbx/queues/{id}/agent`    | `{ action, extension? }` (section 14)                                                                                                                                                                     |

## 12. My status

The Calls screen's header has a status selector, as Linkus had. It sets
the presence of your own extension on the PBX (`PUT
/api/pbx/me/presence`, agents and above). The values are Yeastar's six:
available, away, business trip, do not disturb, lunch and off work.

- The extension is always your own, the one mapped to you in this
  workspace. The request cannot name another. With no extension mapped,
  it is refused.
- The CRM looks your extension up on the PBX and changes its presence
  only; nothing else on the extension is touched. If the PBX does not
  list your extension, the answer is 409 `extension_not_on_pbx`.
- The CRM updates your presence row straight away so open screens move
  at once. If that write fails it is only logged: the PBX has already
  changed and its own event writes the same row.
- The selector follows the phone, too: a status set on the desk phone
  or the Linkus app shows up in it.
- The dots in the Colleagues tab and elsewhere show monitored
  extensions only (section 1).

## 13. Voicemail

The _Voicemail_ tab (agents and above who have an extension) is your
own extension's box: nobody else's, and no shared group box.

- **List.** The first 100 messages, newest first, with the caller's
  number and name, the time, the length and read state. A caller's
  number is matched to a customer you can see, and links to them. The
  unread count covers those 100 only; the total is the PBX's count of
  the whole box.
- **Play, mark read, delete.** Each acts on a message id, and the CRM
  acts on it only once your own extension's box lists it (it looks
  through at most 1,000 messages); any other id is a 404. Playing does
  not mark a message read; the panel does that separately.
- **Audio goes through the CRM.** The PBX's download link carries a live
  token, so the CRM fetches the audio itself and streams it. The link
  never reaches the browser and is never logged or stored.
- The PBX endpoints used are `vm/get`, `vm/download`, `vm/update` and
  `vm/delete`. Marking read is the only status change the PBX accepts.

## 14. Ring groups and queues

The _Groups & queues_ tab shows the PBX's ring groups and queues, and
each queue agent's live state, as Linkus's Groups and Queues tabs do.

- **Which PBX.** The one your own extension is on. A team leader or
  above with no extension gets the workspace's PBX.
- **Which groups.** Only ring groups and queues that have at least one
  member mapped to a person in this workspace. On a PBX shared between
  workspaces the rest belong to another workspace. A group that is shown
  still lists its unmapped members, with no name.
- **Live status.** Read for at most 30 queues, yours first; if there are
  more, the screen says the list was cut short.
- **Your own queues.** Any agent can log themselves in or out of a
  queue, and pause or resume themselves. This needs an extension.
- **Someone else.** Team leaders and above can do the same for another
  extension, but only one mapped to a person in this workspace (404
  otherwise). The queue must list that extension (409 `not_in_queue`).
- **Static agents** cannot be logged in or out (409 `static_agent`);
  they can be paused.
- **Pause reasons are never sent.** Below Yeastar's Enterprise and
  Ultimate plans the PBX rejects the whole request if one is included.
- The PBX endpoints used are `ringgroup/list`, `ringgroup/query`,
  `queue/list`, `queue/agent_status`, `agent/login`, `agent/pause`,
  `queue/agent_login` and `queue/agent_pause`.

## 15. Browser softphone

With the softphone, agents answer and place calls in the CRM tab
instead of on a desk phone. Everyone else keeps desk-phone mode, and
so does anyone whose softphone cannot start: the call screens fall
back on their own.

**On the PBX**

- **Ultimate Plan**, firmware **84.12.0.32** or later (Cloud;
  Software 83.12.0.23, Appliance 37.12.0.23).
- **Integrations › Linkus SDK**: switch it on and save, then paste its
  **AccessID / AccessKey** into Settings › Phone system. Enabling it
  stops Linkus Mobile push notifications on that PBX.
- If your PBX restricts which web origins may use the SDK, allow the
  CRM's origin (Yeastar does not document such a list; check your
  firmware).

**On the CRM host**

- **Host the SDK bundle yourself.** `ys-webrtc-sdk-core` is published
  under a "Proprietary License", so this app does not ship it. Put
  `lib/ys-webrtc.umd.js` from the package (the build Yeastar documents
  for a script tag) on your own HTTPS host, or under `public/`, and set
  `NEXT_PUBLIC_LINKUS_SDK_URL` to its URL. An ES-module bundle also
  works, but the package's `lib/index.js` imports `ms` by bare name, so
  it must be bundled first.
- Set **`NEXT_PUBLIC_PBX_ORIGIN`** to the PBX's address (for example
  `https://yourcompany.ras.yeastar.com`, or `host:8088` on a Software
  edition) so the Content-Security-Policy lets the browser reach it
  over `https:` and `wss:`.
- Both are **build-time** values: rebuild the app after changing
  them. With `NEXT_PUBLIC_LINKUS_SDK_URL` unset, nothing loads.

**Per person**

- An admin ticks **Softphone** for the person's extension in Settings ›
  Phone system. The SDK loads only for those people, and only on a PBX
  with SDK credentials.
- The CRM must be served over **HTTPS**, and the browser asks for
  **microphone** permission on the first call.
- The softphone signs in as the person's extension (see
  `PBX_SDK_USERNAME_MODE` for Cloud PBXs that expect an email). It
  signs in again by itself after a lost login, at most every 30
  seconds. It does not when the extension signed in to the softphone
  in another tab or browser, so two tabs never take the login from
  each other: use one tab, or reload the one you want.
- When the softphone is off, not ready, or the browser is closed,
  calls ring the desk phone or the Linkus mobile app on the same
  extension.
