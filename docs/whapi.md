# WhatsApp via Whapi.Cloud

wacrm talks to WhatsApp through a [Whapi.Cloud](https://whapi.cloud)
channel. A channel is a WhatsApp account paired to the gateway the same
way WhatsApp Web pairs to your phone — you scan a QR code once, and the
gateway exposes that number over a REST API.

## Why this instead of the Meta Cloud API

Earlier versions of wacrm used Meta's official Cloud API. Both work; they
fail in very different places.

| | Meta Cloud API | Whapi.Cloud |
|---|---|---|
| Onboarding | Business Manager, app review, verified business | Scan a QR code |
| Credentials | phone number id + access token + WABA id + 2FA PIN | one channel token |
| Free-form replies | only inside a 24-hour service window | always |
| Templates | submitted to Meta, reviewed, approved/rejected | local, usable immediately |
| Webhook auth | HMAC-SHA256 over the body | shared secret in the callback URL |
| Number | a dedicated business number | any number, including one already on a phone |

The trade-off is real and worth stating plainly: a Whapi channel is an
ordinary WhatsApp account, so it is bound by ordinary WhatsApp
anti-spam enforcement. You do not get Meta's business-messaging
guarantees, and blasting unsolicited messages is what gets a number
banned. Meta's approval friction buys deliverability assurances; this
setup trades those for being able to start in five minutes.

## Setup

### 1. Create a channel

Sign up at [panel.whapi.cloud](https://panel.whapi.cloud) and create a
channel. Open it and scan the QR code from your phone
(**WhatsApp → Linked devices → Link a device**). The channel's status
becomes `AUTH` once pairing succeeds.

### 2. Give the app a public HTTPS URL

**Whapi refuses to deliver webhooks to anything but HTTPS**, and it has
to be able to reach your deployment from the internet. Set
`NEXT_PUBLIC_SITE_URL` to that address:

```bash
NEXT_PUBLIC_SITE_URL=https://crm.example.com
```

If the machine isn't directly reachable, put a tunnel in front of it:

```bash
cloudflared tunnel --protocol http2 --url http://localhost:3000
ngrok http 3000
```

`--protocol http2` is worth defaulting to. cloudflared prefers QUIC over
UDP/7844, which many consumer and mobile networks drop; the symptom is a
tunnel that registers one connection, flaps with *"control stream
encountered a failure"*, and then stops resolving in DNS entirely once
Cloudflare deregisters the hostname. HTTP/2 rides ordinary TCP/443.
`cloudflared`'s startup precheck reports which transport it recommends.

`NEXT_PUBLIC_*` variables are inlined at build time, so **change this
before `npm run build`** — editing it afterwards has no effect until you
rebuild.

> A quick Cloudflare tunnel gets a new hostname every restart. When it
> changes, update `NEXT_PUBLIC_SITE_URL`, rebuild, and press **Save &
> connect** again in Settings to re-register the callback. A named
> tunnel (or your own domain) avoids this.

### 3. Paste the token

In the app: **Settings → WhatsApp**. Paste the channel token and click
**Save & connect**. That single action:

1. verifies the token against `GET /health`,
2. mints a webhook secret (64 random hex chars) and encrypts it,
3. registers `https://<your-host>/api/whatsapp/webhook?secret=…` on the
   channel via `PATCH /settings`, with auto-download enabled,
4. stores the encrypted channel token.

### 4. Confirm inbound delivery

Message the connected number **from a different phone** — Whapi does not
fire webhooks for a message you send to yourself. It should appear in
the Inbox within a few seconds.

## How to read the two status banners

Settings shows two independent banners, because these fail
independently and the combination is the confusing case:

- **Channel connected** — the token is valid and the channel is paired
  (`GET /health` reports `AUTH`). Governs *outbound*.
- **Receiving inbound events** — our callback URL is registered on the
  channel. Governs *inbound*.

A healthy channel whose callback points at a dead tunnel URL sends
perfectly and receives nothing. That is what the second banner is for.

## Webhook authentication

Meta signed every webhook POST with `X-Hub-Signature-256`. Whapi signs
nothing and offers no way to attach a custom header, so the only part of
the request we control is the URL. The shared secret therefore travels
in the query string:

```
https://crm.example.com/api/whatsapp/webhook?secret=<64 hex chars>
```

The secret is generated per channel, stored AES-256-GCM encrypted in
`whatsapp_config.verify_token`, and compared in constant time.

What this buys: only a caller holding the secret can inject events —
without it, anyone who guessed the URL could forge inbound messages,
fire automations, and drive AI replies on your account.

What it does not buy: unlike an HMAC, a URL secret cannot prove the body
was not altered in transit. TLS covers that on the wire. Because URLs
land in logs more readily than headers do, treat the secret as a
rotatable credential — **Rotate secret** in Settings mints a new one and
re-registers the channel, invalidating the old URL immediately.

The secret also carries tenancy: the inbound route resolves the account
from the secret, never from the payload's `channel_id`, because the body
is attacker-controlled and the secret is not. A `channel_id` that
disagrees with the secret's channel is dropped rather than mis-filed.

## Templates

Whapi has no template registry, so `message_templates` rows are purely
local: reusable message definitions that the app renders and sends as
ordinary messages.

- Saving a template makes it usable immediately — status goes straight
  to `APPROVED`, there is nothing to review.
- Body placeholders (`{{1}}`, `{{2}}`, …) still substitute per recipient.
- A media header is sent as a captioned attachment, by plain URL.
- Quick-reply buttons are sent through `/messages/interactive` (max 3,
  a WhatsApp limit, not a gateway one).
- URL and phone-number call-to-action buttons have no free-form
  equivalent and are dropped. Put the link in the body instead —
  WhatsApp makes it tappable.

Rows migrated from a Meta deployment that were `PENDING`, `REJECTED`, or
`PAUSED` are set to `APPROVED` by migration 040: they were judged by a
reviewer that no longer exists.

## Media

`registerWebhook` enables Whapi's **auto-download**, without which an
inbound attachment arrives as an id whose bytes were never pulled off
the phone. With it on, each attachment carries a `link`.

That link expires in roughly 30 days, so **Settings → WhatsApp → Media
retention** (on by default) copies every inbound attachment into the
account's `chat-media` Supabase Storage bucket as it arrives. The mirror
is best-effort: if it fails, the message still lands and falls back to
the gateway link.

## Environment variables

There is **no global Whapi credential** — each account pastes its own
channel token in Settings, encrypted with `ENCRYPTION_KEY`.

| Variable | Required | Purpose |
|---|---|---|
| `ENCRYPTION_KEY` | yes | AES-256-GCM key (64 hex chars) for the channel token and webhook secret |
| `NEXT_PUBLIC_SITE_URL` | in practice | HTTPS origin written into the registered callback URL |
| `WHAPI_BASE_URL` | no | Override for a self-hosted Whapi (default `https://gate.whapi.cloud`) |
| `WHAPI_TIMEOUT_MS` | no | Per-request timeout, default `30000` |

Rotating `ENCRYPTION_KEY` orphans both the token and the webhook secret;
re-save the channel in Settings to recover.

## Troubleshooting

**"Whapi did not recognise that channel token."**
The gateway answers an unknown token with `404 Service not found`, not
`401` — the token is what selects the channel, so a typo'd one addresses
a channel that doesn't exist. Re-copy it from the channel page.

**Outbound works, nothing arrives.**
The second banner will say so. Usual cause: `NEXT_PUBLIC_SITE_URL` is
`http://`, is stale after a tunnel restart, or was changed without a
rebuild. Fix it and press **Save & connect** again.

**"Waiting for QR scan."**
The channel lost its pairing. Re-scan at panel.whapi.cloud.

**Group messages don't appear.**
Deliberate. Every table below the inbox is keyed to a single contact,
and a group thread has no such identity — group chats and broadcast
lists are dropped by the normaliser. Supporting them is a schema change,
not a mapping change.

**Messages sent from the operator's own phone don't appear.**
Also deliberate. Whapi reports everything the number sends from
anywhere; persisting those would double-insert every message the CRM
itself sent and bump unread counts for your own replies.

## Code map

| File | Role |
|---|---|
| `src/lib/whatsapp/whapi-api.ts` | Gateway client: sends, media, health, settings |
| `src/lib/whatsapp/whapi-webhook.ts` | Whapi payload → provider-neutral CRM shape |
| `src/lib/whatsapp/whapi-webhook-auth.ts` | Secret generation, comparison, callback URL |
| `src/app/api/whatsapp/webhook/route.ts` | Inbound: auth, normalise, dispatch |
| `src/app/api/whatsapp/config/route.ts` | Connect / verify / reset a channel |
| `supabase/migrations/040_whapi_provider.sql` | Column remapping, documented on the table |
