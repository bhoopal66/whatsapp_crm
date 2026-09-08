# Meta WhatsApp Cloud API (second number)

wacrm can run **two WhatsApp numbers at once**: a
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

From **App Settings → Basic** also copy the **App Secret**. wacrm uses it
to verify the signature on inbound webhooks.

### 2. Connect it in wacrm

**Settings → WhatsApp → Meta Cloud API number.** Paste the phone number
id, WABA id and access token, and optionally the app secret and a verify
token of your choosing. Saving:

1. verifies the credentials against Graph before storing anything,
2. encrypts the token (and app secret) with `ENCRYPTION_KEY`,
3. subscribes the WABA to your app so Meta will deliver webhooks.

If the subscribe step fails the panel says so — it needs
`whatsapp_business_management`, which a messaging-only token lacks.

### 3. Point Meta's webhook at this deployment

Unlike Whapi, Meta's callback URL is configured **by hand, once per
app**, and is not per-number. In **Meta → your App → WhatsApp →
Configuration** set:

- **Callback URL:** `https://<your-host>/api/whatsapp/meta/webhook`
- **Verify token:** the value you saved in Settings (or
  `META_VERIFY_TOKEN`)

then subscribe at least the **`messages`** field. Subscribe
**`message_template_status_update`** too if you want template approvals
and rejections to appear in the CRM automatically.

Meta calls the URL once with `hub.mode=subscribe` and refuses to enable
the subscription unless the challenge comes back verbatim. wacrm handles
that automatically.

> Signature verification **fails closed**. If neither a saved app secret
> nor `META_APP_SECRET` is available, every inbound callback is rejected
> with a 401 rather than trusted.

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

## How inbound works

Both numbers deliver into the **same inbox and the same conversation per
contact**. A contact who writes to your marketing number and later to
your support number is one thread, not two. Each message records which
number carried it, which is how a reply knows where to go back out.

## The 24-hour service window

The one operational difference you will actually feel. On the Cloud API,
a free-form message is only allowed within 24 hours of the customer's
last message. Outside that window only an **approved template** can be
sent.

So a flow or AI auto-reply routed to the Meta number will be refused
once the window closes. wacrm surfaces this as *"This number can only
send an approved template right now"* rather than Meta's numeric error
code — but the fix is a routing decision, not a bug: keep free-form
conversation on Whapi, and use the Meta number for template-based
outreach.

## Templates

With a Meta number connected, the template review lifecycle in
**Settings → Templates** becomes live again: submit, track
approved/rejected, and see quality ratings. Those states apply **only**
to sends going through the Meta number. A template sent over Whapi is
rendered locally and needs no approval, so the same row works on both.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Meta rejects the callback URL | Not reachable over HTTPS, or the verify token does not match. |
| Inbound never arrives | The WABA is not subscribed to the app, or the `messages` field is not subscribed. |
| Every callback 401s | No app secret available — save one in Settings or set `META_APP_SECRET`. |
| "Service not found" style 404 on save | The phone number id is wrong — it is the numeric id, not the phone number. |
| Sends fail after a while | A temporary access token expired. Use a System User token. |
| "can only send an approved template right now" | The 24-hour window closed. Expected; see above. |
