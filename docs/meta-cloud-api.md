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

**Settings → WhatsApp → Meta Cloud API number.** Paste the phone number
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
first: that removes the *Which number sends what* routes pointing at
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

**Settings → WhatsApp → Which number sends what.** Every task can be
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
person assigns the thread or replies in it), and the AI auto-reply,
if it is on and routed to the same number the campaign went out on, is
told which campaign message the customer is replying to. Routing both
`broadcast` and `ai_reply` to the Meta number is the setup that gives
you a bot-handled campaign.

**AI auto-reply only answers on its own number.** A message that arrives
on the *other* number is left for a human. Route AI auto-reply to the
Meta number and the bot runs there alone, while the Whapi number stays
fully human — and it can never try to answer a Whapi customer from a
Meta number they never wrote to.

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
**Settings → Templates** becomes live again: submit, track
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
(migration 051) and shown under **Settings → Message costs** — this
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
| Broadcast recipients fail with "Template variable {{N}} is empty" or `(#131008) Required parameter is missing` | A template variable resolved blank for them, and Meta rejects blank values. Set an *If empty, use* fallback for the variable in the broadcast's Personalize step. |
| Message costs shows *no rate on file* | The recipient's market or the category is not in the seeded rate card. Load the official CSV (see above). |
| Message costs stays empty | Costs come from delivery receipts, so the webhook must be reaching this deployment; check the inbound row above first. |
