# Meta WhatsApp Cloud API (second number)

Taamul Connect can run **two WhatsApp numbers at once**: a
[Whapi.Cloud](whapi.md) channel for conversations, and a Meta Cloud API
number for marketing and automation. An admin then chooses, per kind of
message, which number sends it.

This is optional. A Whapi-only install is unaffected and needs nothing
here.

## It has to be a different phone number

This is the part that surprises people, so it is worth stating before
anything else:

- A **Whapi channel** pairs to a WhatsApp account the same way WhatsApp
  Web does — by scanning a QR code. The number keeps living in the
  WhatsApp app on a phone.
- **Registering a number on the Cloud API removes it from the WhatsApp
  app.** It becomes a Business Platform number, driven only by the API.

So one number cannot be on both. Running both means running two numbers:

| | Conversational number | Marketing number |
|---|---|---|
| Gateway | Whapi | Meta Cloud API |
| Free-form replies | always | only inside the 24-hour service window |
| Templates | local, usable immediately | submitted to Meta, reviewed, approved |
| Onboarding | scan a QR code | Business Manager + app review |
| Best for | inbox, support, flows | campaigns, business-initiated outreach |

## Why bother

Whapi rides an ordinary WhatsApp account, so it is bound by ordinary
WhatsApp anti-spam enforcement — blasting campaigns from it is what gets
a number banned. The Cloud API is the sanctioned path for
business-initiated messaging: you pay per conversation, templates are
reviewed up front, and the number is not at risk for doing exactly what
it is meant to do.

Keeping support on Whapi keeps the thing Whapi is good at: free-form
replies with no 24-hour window and no template round-trips.

## Setup

### 1. Get the credentials

In [developers.facebook.com](https://developers.facebook.com) create (or
open) an app with the **WhatsApp** product added. From **WhatsApp → API
Setup** collect:

- **Phone number ID** — a numeric id, *not* the phone number.
- **WhatsApp Business Account ID** (WABA id).
- **Access token** — use a **System User** token from Business Settings.
  The temporary token on that page expires in 24 hours; a System User
  token does not. It needs `whatsapp_business_messaging` and
  `whatsapp_business_management`.

From **App Settings → Basic** also copy the **App Secret**. Taamul Connect uses it
to verify the signature on inbound webhooks.

### 2. Connect it in Taamul Connect

**Settings → WhatsApp → Connections → Meta Cloud API number.** Paste the phone number
id, WABA id and access token, and optionally the app secret and a verify
token of your choosing. Saving:

1. verifies the credentials against Graph before storing anything,
2. checks that the phone number id is one of the WABA's numbers
   (`GET /{waba-id}/phone_numbers`, with the same token),
3. encrypts the token (and app secret) with `ENCRYPTION_KEY`,
4. subscribes the WABA to your app so Meta will deliver webhooks.

If the subscribe step fails the panel says so — it needs
`whatsapp_business_management`, which a messaging-only token lacks.

**The phone number must belong to the WABA.** If the WABA's number
list does not include the phone number id, the save is refused with a
400 (*"Phone number id … is not one of the numbers in WhatsApp Business
Account …"*) and nothing is subscribed. Subscribing is app-wide and
Taamul Connect never undoes it, so a mistyped WABA id would otherwise
send every one of *that* WABA's callbacks here for good. Copy both ids
from the same number in **WhatsApp → API Setup**. If the list cannot be
read at all (the token lacks `whatsapp_business_management`, or Graph
is down), the credentials are saved without subscribing, exactly like a
failed subscribe.

**One Meta number per account.** Once a number is connected, saving a
*different* phone number id — or clearing the WABA id — is refused
with a 409 (*"This account already has a Meta number connected
(…1234). Only one is supported — disconnect it first."*), before
anything is sent to Meta. It used to overwrite the connected number in
place, silently moving its routes, conversations and approved
templates onto the new one. Re-saving the same number (a new token,
app secret or verify token), or filling in a WABA id the number was
saved without, works as before. To really switch numbers, disconnect
first (Settings → WhatsApp → Numbers & access): that removes the Settings → WhatsApp → Routing routes pointing at
the old number (they fall back to the default) and unlinks its
conversations from it, so set the routes again afterwards.

**Correcting the WABA id.** Saving the *same* phone number id with a
different WABA id corrects a mistyped one in place, keeping the
number's routes and conversations — but only once Meta confirms the
number is in the new WABA (the listing above). If it is not listed,
the save is refused with the 400 above; if the listing cannot be read
(permissions, Graph down), it is refused with a 409 (*"Could not
confirm that phone number id … belongs to WhatsApp Business Account …,
so the connected number's WABA id (…1234) was not changed."*) and the
stored WABA id is left alone. A first save, by contrast, still goes
ahead without the check, like a failed subscribe.

### 3. Point Meta's webhook at this deployment

Unlike Whapi, Meta's callback URL is configured **by hand, once per
app**, and is not per-number. In **Meta → your App → WhatsApp →
Configuration** set:

- **Callback URL:** `https://<your-host>/api/whatsapp/meta/webhook`
- **Verify token:** the value you saved in Settings (or
  `META_VERIFY_TOKEN`)

then subscribe at least the **`messages`** field. Subscribe
**`message_template_status_update`** too if you want template approvals
and rejections to appear in the CRM automatically, and
**`message_template_quality_update`** /
**`message_template_components_update`** for quality ratings and
Meta's own edits to a template.

Meta calls the URL once with `hub.mode=subscribe` and refuses to enable
the subscription unless the challenge comes back verbatim. Taamul Connect handles
that automatically.

> Signature verification **fails closed**. If neither a saved app secret
> nor `META_APP_SECRET` is available, every inbound callback for a
> connected number is rejected with a 401 rather than trusted.

Template callbacks (status, quality, components) carry no phone number,
so they are matched on the **WABA id** (`entry.id`) instead: the
callback must be signed with the app secret saved on the channel whose
WABA id it names (or `META_APP_SECRET` when that channel stores none),
and it only updates that account's templates. Make sure the WABA id
saved in Settings is the real one, or template approvals will stop
arriving automatically (the **Sync from Meta** button still works);
see *Correcting the WABA id* above to fix it without disconnecting.

One POST can carry template changes **and** `messages` changes at once.
The two halves are verified separately against the same body — the
template half by the WABA ids of the entries that carry template
changes, the messages half by phone number id — and both are
processed. (A template change used to send the whole POST down the
template path, and the customer messages and receipts beside it were
answered 200 and lost.) If either half names a WABA or number connected
here and nothing in that half verifies, the answer is 401 even though
the other half was processed; Meta's retry of it is harmless, because
every step is idempotent.

If the database cannot be reached while looking up the WABA or the
phone number id, the callback is answered **503**, not 200: Meta
retries a 5xx with backoff, while a 200 would have filed a connected
number's message or template decision as "not connected here" for
good.

A template callback for a WABA that **no connected number uses** is
answered 200 `{"status":"ignored"}` without checking its signature, the
same way a message for an unknown phone number id is. Nothing is
touched, and there is no stored secret to check it with. (It used to
be verified against `META_APP_SECRET` alone, so on an install that keeps
the app secret in Settings rather than the environment it was answered
401 — which Meta retries, and a subscription that keeps failing is
disabled for the whole app, the connected number's messages included.)

### 4. Choose what each number sends

**Settings → WhatsApp → Routing.** Every task can be
pointed at either number, or left on *Use default*:

| Task | What it covers |
|---|---|
| Inbox replies | replies an agent types in the shared inbox |
| Broadcasts | campaigns sent to many contacts at once |
| Automations | keyword, tag and scheduled automation steps |
| Flows | conversational flow nodes |
| AI auto-reply | AI-drafted replies sent to the customer |
| Public API | messages sent through `/api/v1` |

A typical split is broadcasts and automations on the Meta number,
everything else on Whapi.

**Inbox replies and the public API are advisory.** They follow whichever
number the customer last wrote to, and consult their setting only for a
thread with no inbound history. Replying to someone from a number they
never contacted is confusing, and on Meta it also lands outside the
24-hour window they just opened. The bot tasks (broadcasts, automations,
flows, AI auto-reply) always obey the setting — that is the point of
routing marketing to the Cloud API number.

**The Contact detail view splits by action, not by setting.** Opening
a contact from Contacts offers two ways to start a thread, and with
both numbers connected they go out on different ones: **Send message**
(a free-form text) always uses the Whapi number, and **Send template**
(an approved template) always uses the Meta number. That is what each
number is for — a plain text is refused on Meta outside the 24-hour
window, while an approved template is exactly what opens a
business-initiated conversation there. Neither button consults the
*Inbox replies* setting; a caption under them says which number each
will use. With only one number connected, both buttons use it, as
before. Once the customer replies, the thread follows their number
like any other.

**Campaign replies.** A customer who answers a broadcast has their
conversation stamped with that campaign. Those threads are listed on
their own under Broadcasts → **Campaign inbox** while the AI auto-reply
is answering them (and in the Inbox otherwise, and for good once a
person assigns the thread or replies in it, and while it carries a
chat tag), and the AI auto-reply,
if it is on and routed to the same number the campaign went out on, is
told which campaign message the customer is replying to. Routing both
`broadcast` and `ai_reply` to the Meta number is the setup that gives
you a bot-handled campaign.

**AI auto-reply only answers on its own number.** A message that arrives
on the *other* number is left for a human. Route AI auto-reply to the
Meta number and the bot runs there alone, while the Whapi number stays
fully human — and it can never try to answer a Whapi customer from a
Meta number they never wrote to. With *Reply on every WhatsApp number*
on in Settings → AI Agents → Auto-reply, the bot instead answers on whichever number the
customer wrote to (so the 24-hour window is open), skipping chats a
person pinned to another number.

## How inbound works

Both numbers deliver into the **same inbox and the same conversation per
contact**. A contact who writes to your marketing number and later to
your support number is one thread, not two. Each message records which
number carried it, which is how a reply knows where to go back out.

### Callbacks for numbers not connected here

Meta's callback URL is per *app*, so every WABA subscribed to your app
delivers here — including numbers that are not connected in Taamul
Connect. Their callbacks are answered 200 `{"status":"ignored"}` (a
failure would be retried and eventually get the app's subscription
disabled) and dropped. They are not logged one line per request any
more; instead each unknown phone number id gets one line the first time
it is seen, then at most one summary an hour:

```
[meta-webhook] dropped 1 callback for unconnected phone_number_id "109876543210987" (first seen; further drops are summarised at most every 60m): 1 message, 0 statuses (1/1 signed by this app)
[meta-webhook] dropped 412 callbacks for unconnected phone_number_id "109876543210987" in the last 60m: 37 messages, 389 statuses (412/412 signed by this app)
```

- **messages vs statuses** — *messages* are customers writing to that
  number, and nobody here sees them. *Statuses* only are receipts for
  sends some other system makes from that number.
- **signed by this app** — how many of those callbacks verify against
  an app secret stored here (or `META_APP_SECRET`). All of them means a
  WABA is subscribed to **your** app. None means another app's callback
  URL points at this deployment.

The summary is emitted by the next drop after the hour has passed, so a
quiet tail waits for the next callback, and the counts reset on restart.

What to do about such a number is a business decision:

- **It belongs in this CRM** — only one Meta number per account is
  supported today (see *One Meta number per account* above).
- **It is handled elsewhere** — remove your app from that WABA in
  Business Manager (*WhatsApp accounts → the WABA → Connected apps*).
  The Graph equivalent is `DELETE /{waba-id}/subscribed_apps`, but it
  unsubscribes **the app that issued the token**, so only use a token
  issued by your app; run `GET /{waba-id}/subscribed_apps` before and
  after to confirm only your app disappeared. If the callbacks are *not*
  signed by this app, change the other app's callback URL instead.

## Deal rooms

A deal room is a real WhatsApp group for one deal: the customer, the
people on your side, and your Meta number as the business. If you allow
them, officers of a partner bank can be in it too. It is made through
the Cloud API's Groups API, so it needs a Meta number; the Whapi
channel cannot host one. In the CRM it is linked to the customer's
contact and, optionally, to a deal. A group holds at most 8 members
including your number, so a room lists 1 to 7 other people.

### Before the first room

1. **A Meta number that is an Official Business Account.** The Groups
   API is not available to other numbers. Without a connected Meta
   number, creating a room is refused with a message saying so.
2. **The four `group_*` webhook fields subscribed**, as described under
   *Groups webhooks* below.
3. **The group-invite template.** WhatsApp has no silent add, so each
   person is invited with a template message in their own 1:1 chat,
   carrying the group's invite link. Copy Meta's template from the
   **Template Library** (topic *group invite link*) **unmodified**:
   Meta turns its `group_id` parameter into the link, and an edited
   copy will not do that. Submit it in your WABA and wait for it to be
   approved.
4. **Settings → Deal rooms** (admins). Enter the approved template's
   name and language. The page shows whether each name is found in your
   synced templates and approved. An Arabic copy is optional; today
   everyone gets the default copy, because the CRM stores no language
   for a contact to choose a copy by. Until a template is configured a
   room is still created, but nobody is invited: the creator gets an
   *Invite template not configured* notification, and a manager sends
   the invites once it is set (`POST /api/deal-rooms/{id}/invites`).

### How a room runs

1. **Create it** (agents and up) from the chat screen, or with *New
   deal room* on the customer's page, on a deal in Pipelines (the deal
   is linked) or in the inbox's contact panel, which fill in the
   customer. Those three also list the rooms on that customer or deal,
   each opening in team chat; they appear only while a Meta number is
   connected, and never for bank guests. The customer's
   consent is recorded first (the wording shown, its version and how it
   was given); without it no group is made. People who opted out or are
   marked do-not-contact are refused. The room shows as *creating*:
   Meta answers at once and sends the group id in a `group_create`
   webhook, which opens the room. If Meta refuses, the room is marked
   failed straight away, and its creator and the workspace's owners and
   admins are told. A manager can cancel it while it is still
   *creating* (see "Cancelling a room" below).
2. **Each person gets the invite link in their own 1:1 chat**, sent
   from your Meta number as the template above. A person is invited
   once; sending the invites again only reaches those not yet invited.
   Each invite is re-checked just before it is sent: nobody is invited
   while the room is not open, after they opted out or were marked
   do-not-contact, if they are a customer without recorded consent
   (only the consented contact's own number counts), or if they are a
   bank officer whose bank's guest switch is off.
   An invite that was started but never finished (the server stopped
   mid-send) is released after 30 minutes and sent again, by the
   background job under "Rooms stuck in creating" below; if that first
   send had in fact gone out, the person gets the invite twice.
3. **Join requests.** Groups are made with join approval on, so tapping
   the link sends a request. A request from one of the numbers on the
   room's list is **approved automatically** — only while the same
   checks pass. Any other number, and any listed number that fails a
   check, **waits for the relationship manager**: the room's creator and
   the admins of its channel get a notification, and a manager approves
   or rejects it in the room.
   A closing or closed room takes no new staff, guests or approvals and
   sends nothing; messages that still arrive are kept for the record.
4. **Messaging.** Everyone in the group sees every message.
   - **Free text** can be sent only inside the group's **24-hour reply
     window**. Any member's message opens it for the whole group, not
     just for the sender.
   - **Outside the window**, only an **approved template** can be sent.
     Meta charges a template **once per member who receives it**.
   - A group message is text or a template: **no buttons, lists or
     calls**.
   - **A sent message cannot be edited or deleted.**
   - A member who writes `STOP`, `UNSUBSCRIBE` or an Arabic equivalent is
     removed from the group, marked opted out (no broadcast reaches
     them again), and one note in the Team notes says so, including
     when their contact could not be marked or none was found; the
     removal itself adds no second note.
   - A person removed by a manager **cannot rejoin through the invite
     link**. A manager can fetch the link or reset it; a reset ends
     every earlier link. The link is never stored, only its hash.
5. **Files members send are saved to the deal file automatically**
   (pictures, documents, audio, video, stickers), in a private bucket.
   If one cannot be saved, its message still arrives and shows the
   failure.
6. **Close room.** A manager closes the room: a **transcript is saved to
   the deal file** (every group message, the files shared and who joined
   and left, as an HTML file), then **everyone is removed and the group
   is deleted** at WhatsApp. If WhatsApp fails part-way the room stays
   *closing* with the reason, and closing again carries on from there.
   A transcript can also be saved at any time without closing.

A *manager* is an owner or admin, a team leader who can see the room's
customer (and its deal, if it has one), or an agent and up who is an
admin of the room's channel or owns the room's contact. If WhatsApp suspends a
group, the room shows *suspended*, its managers and the workspace's
owners and admins are notified (each person once), and nothing can be
sent until WhatsApp clears it; they are notified again when it is
cleared.

**Adding people.** A manager adds staff of the workspace to a room
(**Add people → Add team members** in the room's members panel), and
a manager who is a team leader or above adds a bank officer's login
(**Add a bank officer**). They then read the room and its Team notes;
nobody is added to the WhatsApp group. A bank officer's login is
accepted only when their bank already has an approved officer among
the room's people and the bank's guest switch is on. The panel offers
this while the room is creating, open or suspended; a closing or
closed room takes nobody.

### What never leaves the CRM

The room's **Team notes** tab is internal chat for staff. It does not go
through the group send path, so no member of the group ever sees it, and
it is not in the transcript. Staff also see group members' phone numbers
and WhatsApp ids only masked (`+971 XXXXXXX12`).

### Bank officers

- **Off per bank until the bank's DSA terms are checked.** An admin turns
  a bank on in Settings and the date it was checked is recorded. For any
  other bank, adding an officer is refused.
- **A team leader approves each guest** an agent adds: the officer
  waits, is invited only once a team leader (or above) who is a manager
  of that room approves, and is never invited if rejected. An agent
  cannot approve, even in a room they manage.
- **What a bank officer sees** is only their own rooms: a room shows
  while their bank's guest switch is on and the room has an approved
  officer of their bank who has not been removed. In it they read the
  group's messages only from when they were added to the room, and its
  people as name, role and status, never a phone number; someone nobody
  listed (who joined through the link) shows as _Unlisted number ending
  12_. They get no **Team notes** tab and none of the room's internal
  fields (the linked contact and deal, the group id, the last error):
  they read the room through a separate view, `deal_room_guest_rooms`.
  Room changes, such as it closing or being suspended, reach their
  screen within a minute.

### Cancelling a room

While a room shows *creating*, a manager can **Cancel room** (members
panel, with an optional reason). The server checks that the caller
manages the room, then marks it **failed** with the reason, stamps it
cancelled and records who cancelled it in the room's audit trail; the
room shows *cancelled*. A cancelled room never opens:

- When Meta's `group_create` webhook arrives afterwards, the room stays
  failed, nobody is invited, the group id is recorded once in the audit
  trail (`group_discarded`), and the group, which holds only your
  number, is deleted at WhatsApp. A delete that fails is logged, not
  retried. Nobody is told: the canceller already knows. If another room
  holds that group by then (the background job below matches a room to
  a group by subject alone), the group is left alone, people and all,
  and the webhook is logged as an error.
- Nobody is told that it "could not be created" either: a create call
  Meta refuses, a failed `group_create` webhook or the background job
  giving up fails only a room still *creating*, and alerts only then.
- It is never requested again: neither a create call still waiting for
  Meta's answer nor the background job below can put it back to
  *creating*.
- Once the group has arrived the room is open and cannot be cancelled
  (the panel says so); close it instead.

A cancelled room's group is left at WhatsApp, empty (only your number;
nobody was invited, so no customer is in it), rather than deleted when:

- the cancel lands while the create call is still waiting for Meta's
  answer: its request id is never recorded, so the webhook matches no
  room and is logged as unknown;
- the background job's retry created it: the retry's request id is
  never recorded either, so its webhook matches no room;
- the webhook is lost or never sent, so nothing hears of the group;
- the background job found the group by subject just as the room was
  cancelled: a group found by subject alone is never deleted.

Delete such groups from WhatsApp by hand if they matter to you.

### Rooms stuck in "creating"

The group id can fail to arrive (a lost webhook, or one that names a
request no room recorded). `GET /api/deal-rooms/cron`, authenticated like
the other cron endpoints (`AUTOMATION_CRON_SECRET` in `x-cron-secret`),
takes every room still *creating* after 2 minutes and finishes it:
finds its group by exact subject, or asks Meta once more if there is
none. A room still without its group after 10 minutes is marked
**failed**, and its creator and the workspace's owners and admins are
told. A group that cannot be told apart from another is never guessed:
nor is any group found while another room of the number with the same
subject is still being created, or was cancelled less than 10 minutes
before this one was created (or since), because that room's group may
still arrive, and a cancelled room's webhook deletes it. The automation cron runs it too, at most
every 2 minutes per process, so an install that pings only that one is
covered.

The same job frees an invite that has been stuck mid-send for 30 minutes
and runs that room's invites again.

## Groups webhooks (deal rooms)

A deal room is a real WhatsApp group on your Meta number, made with the
Cloud API's Groups API. Its events arrive on the same callback URL as
everything else.

- **Subscribe the four group fields**, once per *app*, in **Meta → your
  App → WhatsApp → Configuration**, next to `messages`:
  `group_lifecycle_update`, `group_participants_update`,
  `group_settings_update` and `group_status_update`. Without them a new
  room never learns that its group was created, and joins, leaves,
  join requests and suspensions are not recorded. Messages written in a
  group and receipts of group sends arrive on `messages` itself.
- **The number must be an Official Business Account** on the Cloud API;
  the Groups API is not available to other numbers.
- **Group events never reach the inbox.** Messages carrying a
  `group_id` and receipts with `recipient_type: "group"` are left out
  of the inbox, and handed, with the `group_*` changes, to the deal
  rooms of the account whose number they name. They are verified with
  that number's app secret exactly like its messages (a bad signature
  is a 401), screened under the same keys
  (`msg:<phone_number_id>:<message id>`, so a redelivery is skipped),
  and processed in the same callback.
- **Settings changes** (`group_settings_update`, migration 100): a new
  subject, description or join approval mode that WhatsApp reports is
  copied onto the room, and the room's Team notes channel takes the new
  subject as its name (its first 80 characters). A redelivery, a closed
  room, a setting WhatsApp reports as failed and a value the room
  cannot hold (a blank subject, one over 128 characters) change
  nothing. The payload is read as Meta's pages describe it
  (`group_subject` / `group_description` objects with `text` and
  `update_successful`); it has not yet been seen on a live callback,
  so any other shape is logged and ignored.
- **Group sends are costed per delivered member** (migration 100).
  Meta bills a group message once for each participant it reaches, at
  that participant's market rate, in the message's one category: a
  free-form message inside the group's 24-hour window is `service` for
  every member. Each receipt goes to *Message costs* keyed on the
  member (`recipient_participant_id`), so a member's delivery is never
  mistaken for a replay of another's, and a redelivered receipt still
  counts once. The room's transcript row keeps the message's
  `category` and `recipients_billed` (billable deliveries so far),
  including receipts that arrived before that row was written (it is
  written once Meta has answered the send). A receipt that names no
  member is recorded uncosted.

## Edge security

Every number's events are screened once their signature has verified,
before anything in them is processed — one check per POST, however many
numbers Meta batched into it. Claims and counters live in Postgres
(migration 084), so every app instance shares them.

- **Replay keys per number.** Each message, and each status transition,
  is claimed once under a key naming the phone number id it arrived on.
  A redelivery within 24 hours is skipped as a duplicate, and one
  account's callbacks can never claim another's events.
- **4 messages per second per sender** (the customer's number). A
  message over the limit is not lost: it is saved to the inbox (unread
  count, thread re-opened) but nothing answers it — no Flow, automation,
  AI reply or campaign follow-up, and no outbound message webhook.
  Duplicates never count against the limit.
- **IP sanity limit**, 600 requests per second per client IP. A request
  over it is answered 200 and nothing in it is processed, its receipts'
  costs included. Otherwise *Message costs* sees every receipt, a
  duplicate too; its ledger ignores a replay.

The webhook **never answers 429**; Meta would only retry sooner. The
one non-200 screening produces is **503**: another delivery holds a
live, unconfirmed claim on one of the POST's events (it is still being
processed, or the process handling it died). None of the POST's messages
or statuses are processed, and Meta redelivers; by then the claim was
confirmed (a duplicate) or its 60-second lease has lapsed (processed).
A claim is confirmed only once its number's events were processed
without error. If the stores cannot be reached, screening fails open: a
duplicate is cheaper than a lost message, and the `messages` upsert
still drops a replayed message.

**Client IP.** The IP limit keys on the one header your own proxy sets,
named by `EDGE_CLIENT_IP_HEADER` — never guessed:

- Behind a Cloudflare tunnel or proxy: `EDGE_CLIENT_IP_HEADER=cf-connecting-ip`.
- Behind a proxy that sets it: `x-real-ip`.
- `x-forwarded-for`, with `EDGE_TRUSTED_PROXY_HOPS` set to the number
  of proxies you run in front of the app (default 1). The client is
  the entry that many places from the right. Never trust the left-most
  entry: the client wrote it.

Unset (or the header missing), every request shares one `unknown`
bucket, which is safe but coarser.

**Housekeeping.** `edge_purge()` deletes expired claims and counters.
`GET /api/automations/cron` runs it at most every 15 minutes per
process; an install that does not ping that cron can schedule
`SELECT public.edge_purge()` with pg_cron instead. Correctness does not
depend on it — an unpurged row is dead weight, never a wrong answer.

## The 24-hour service window

The one operational difference you will actually feel. On the Cloud API,
a free-form message is only allowed within 24 hours of the customer's
last message. Outside that window only an **approved template** can be
sent.

So a flow or AI auto-reply routed to the Meta number will be refused
once the window closes. Taamul Connect surfaces this as *"This number can only
send an approved template right now"* rather than Meta's numeric error
code — but the fix is a routing decision, not a bug: keep free-form
conversation on Whapi, and use the Meta number for template-based
outreach.

The same applies to **Forward** in the inbox: forwarding a message into
a chat that is answered on the Meta number is a free-form send, so it
is refused for a customer who hasn't written in the last 24 hours. The
other targets of the same forward are unaffected, and the failure is
reported per chat.

## Templates

With a Meta number connected, the template review lifecycle in
**Settings → WhatsApp → Templates** becomes live again: submit, track
approved/rejected, and see quality ratings. Those states apply **only**
to sends going through the Meta number. A template sent over Whapi is
rendered locally and needs no approval, so the same row works on both.

## Message costs

Meta bills the Cloud API number **per delivered message**, at a rate
set by the recipient's market and the message category (marketing,
utility, authentication, service). The invoice arrives a month later as
one number. Taamul Connect keeps its own ledger so an admin can see the
spend as it happens: every delivery receipt Meta posts to the webhook
carries a `pricing` object, and the receipt is costed on arrival
(migration 051) and shown under **Settings → WhatsApp → Message costs** — this
month so far, spend per month by category, per number, per market, and
each number's position against the free service tier.

Only the Meta number is metered. A Whapi channel is a flat gateway
subscription with no per-message billing and nothing to cost from.

Four things to know:

- **The category comes from whichever receipt carries it.** Meta puts
  `pricing` on the `sent` receipt and does not always repeat it on
  `delivered`. A delivery that arrives without one adopts the category
  already recorded for the same message, so a template send is priced
  as marketing or utility rather than filed as a free service message.
  Only a delivery with no category on any of its receipts counts as
  service.


- **Unknown rates are reported, never zeroed.** The migration seeds
  Meta's published rates for the GCC corridors only (UAE, Saudi,
  Kuwait, Oman, the rest of the Middle East, Pakistan). A delivery to
  any other market — or in a category without a seeded rate — is
  counted but shown as *no rate on file* and left out of the totals.
  Load Meta's full card once and the gap closes:

  ```bash
  npx tsx scripts/load-meta-rate-card.ts card.csv --dry-run   # inspect
  npx tsx scripts/load-meta-rate-card.ts card.csv             # write
  ```

  The CSV needs `market,category,rate_usd,effective_from` columns
  (the script's header comment documents the market codes and
  aliases). Rates are captured at delivery time, so load a new card
  *before* the month it applies to; already-costed rows are not
  re-priced.

- **The 1 October 2026 rules are built in.** Service (free-form)
  messages are free until then; from that date the first **1,000
  delivered service messages per number per calendar month** are free
  and the rest bill at the market's utility rate. The month boundary
  is the WhatsApp Business Account's timezone — `Asia/Dubai` by
  default, overridable with `WHATSAPP_BILLING_TIMEZONE`. Meta's own
  `billable` flag on a receipt (the 72-hour click-to-WhatsApp free
  entry point, for instance) always wins over these local rules.

- **It is an estimate until reconciled.** The ledger is what the
  receipts say, priced from the card; Meta's invoice is the truth.
  Reconcile the first invoice against `whatsapp_cost_monthly` and load
  the official card if the two disagree.

The ledger never blocks a message. Costing runs last in the webhook
and fails open: a rate-card problem is logged, and the inbound message
and its automations are unaffected.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Meta rejects the callback URL | Not reachable over HTTPS, or the verify token does not match. |
| Inbound never arrives | The WABA is not subscribed to the app, or the `messages` field is not subscribed. |
| Every callback 401s | No app secret available — save one in Settings or set `META_APP_SECRET`. |
| Save says "already has a Meta number connected" (409) | One Meta number per account, and its WABA id cannot be cleared. Re-save the connected number, or disconnect it first. |
| Save says "Could not confirm that phone number id … belongs to" the WABA (409) | You changed the WABA id of the connected number and Meta's number list for the new WABA could not be read — usually a token without `whatsapp_business_management`. Fix the token and save again; the stored WABA id was not changed. |
| Meta's delivery log shows 503 from the webhook | The database was unreachable while looking up the number or WABA. Meta retries; check the database if it persists. |
| Save says the phone number id "is not one of the numbers" in the WABA (400) | The two ids come from different WABAs. Copy both from the same number in WhatsApp → API Setup. |
| Log shows `dropped … for unconnected phone_number_id` | A WABA subscribed to this app has a number not connected here. See *Callbacks for numbers not connected here*. |
| Templates never get a quality rating | Subscribe `message_template_quality_update` on the app. |
| "Service not found" style 404 on save | The phone number id is wrong — it is the numeric id, not the phone number. |
| Sends fail after a while | A temporary access token expired. Use a System User token. |
| "can only send an approved template right now" | The 24-hour window closed. Expected; see above. |
| Broadcast recipients fail with "Template variable {{N}} is empty" or `(#131008) Required parameter is missing` | A template variable resolved blank for them, and Meta rejects blank values. Set an *If empty, use* fallback for the variable in the broadcast's Personalize step. The values are fixed when a broadcast is created, so *Retry failed* sends the same blanks again: create the broadcast again with the fallback. |
| Message costs shows *no rate on file* | The recipient's market or the category is not in the seeded rate card. Load the official CSV (see above). |
| Message costs stays empty | Costs come from delivery receipts, so the webhook must be reaching this deployment; check the inbound row above first. |
