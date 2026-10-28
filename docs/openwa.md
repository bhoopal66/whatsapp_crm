# OpenWA numbers

OpenWA is a third way to connect a WhatsApp number, next to Whapi and the
Meta Cloud API. It is [OpenWA](https://github.com/rmyndharis/OpenWA), an
open-source, self-hosted gateway that you run on your own server.

Like Whapi it is a **linked device**: the number stays in the WhatsApp app
on a phone, and the gateway is one of its linked devices. So it behaves
like a Whapi number in the app (no 24-hour window, templates are rendered
and sent as ordinary messages) and it carries the same risk: WhatsApp can
restrict a number it believes is automated. Use a number you can afford to
lose, warm it up, and don't cold-message strangers in bulk.

## What works, and what doesn't (yet)

|                                                                           | OpenWA number                                                                                                                |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Inbox replies, automations, flows, AI replies, broadcasts, the public API | yes                                                                                                                          |
| Text, images, video, documents, audio and voice notes, reactions          | yes                                                                                                                          |
| Templates                                                                 | rendered locally and sent as an ordinary message                                                                             |
| Buttons and lists                                                         | sent as **numbered text**: the engine cannot send interactive messages, so a reply arrives as text ("1", "2", or the option) |
| Delivery and read receipts                                                | yes                                                                                                                          |
| Customer profile pictures                                                 | yes                                                                                                                          |
| Connection alerts (`channel_disconnected` / `channel_reconnected`)        | yes, from the health sweep                                                                                                   |
| Safety Meter                                                              | no (Whapi only)                                                                                                              |
| WhatsApp groups (`/groups`) and submission groups                         | no (Whapi only)                                                                                                              |
| Team activity limits and the composer warning                             | not yet: they count Whapi numbers only                                                                                       |

## Running OpenWA

Run it as its own service beside the app, never inside it, so a WhatsApp
breakage or an OpenWA restart cannot take the CRM down. The reference
setup (Docker):

- Image `ghcr.io/rmyndharis/openwa:<release>`, engine `whatsapp-web.js`
  (it drives a real browser, the lower-risk engine; about 300–500 MB of
  RAM per number).
- Bind it to `127.0.0.1` only. Nothing on the internet needs to reach it:
  the app calls it locally, and it calls the app locally.
- Disable upstream's Docker-socket proxy unless you use OpenWA's built-in
  datastore orchestration; it makes the container root-equivalent on the
  host.
- Set `RESOLVE_LID_TO_PHONE=true`. WhatsApp increasingly identifies
  senders by a privacy id (`…@lid`); with this the gateway adds the
  sender's phone number, which is what the CRM files a contact under. A
  message whose sender cannot be resolved to a phone is dropped, never
  guessed.
- Allow the app's host for webhooks: `SSRF_ALLOWED_HOSTS=host.docker.internal`
  with `extra_hosts: host.docker.internal:host-gateway` on the container.
- Optional but recommended: `SEND_PACING_ENABLED=true`, a per-number daily
  allowance that grows with the number's age in OpenWA, plus a cap on
  first messages to new chats. A refused send shows in the CRM as
  "OpenWA's daily send allowance for this number is used up". The
  allowance counts from when the number was linked to OpenWA, not from the
  number's real age, so an established number may want a more generous
  `SEND_PACING_WARMUP_SCHEDULE`.

### Updates

Follow OpenWA's **published releases**, not its main branch. A WhatsApp
update can break the gateway until upstream ships a fix (one in September
2026 stopped media sends for about six days), so keep a Whapi or Meta
number to route bot surfaces to while an OpenWA number is down.

## Connecting the app

Server environment (read at request time):

| Variable                  | Default                            |                                                                                                                                  |
| ------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `OPENWA_URL`              | `http://127.0.0.1:2785`            | where the app reaches OpenWA                                                                                                     |
| `OPENWA_API_KEY`          | —                                  | an OpenWA **admin** key; used only to add and remove numbers. Unset: Settings says OpenWA is not set up and nothing else changes |
| `OPENWA_WEBHOOK_BASE_URL` | `http://host.docker.internal:3000` | the app's address as OpenWA sees it                                                                                              |

Then in **Settings → WhatsApp**, an admin picks _Connect with OpenWA_,
names the number and scans the QR code with the phone (WhatsApp → Linked
devices → Link a device).

Adding a number:

1. creates an OpenWA session;
2. mints an **operator** key limited to that session, which is the only
   key the app sends with (the admin key never leaves the server's
   environment);
3. registers a webhook to `/api/whatsapp/openwa/webhook` with a fresh
   secret;
4. starts the session and shows its QR code until the phone is linked.

Disconnecting logs the session out, deletes it and revokes its key.

## How it is stored

One `whatsapp_config` row per number (migration 144 added the provider):

| column            | `provider='openwa'`                         |
| ----------------- | ------------------------------------------- |
| `phone_number_id` | OpenWA session id                           |
| `access_token`    | the session-scoped operator key (encrypted) |
| `verify_token`    | the webhook HMAC secret (encrypted)         |
| `waba_id`         | connected phone number (display)            |
| `app_secret`      | unused                                      |

## Inbound webhook

`POST /api/whatsapp/openwa/webhook` authenticates like the Meta webhook:
the body's `sessionId` selects the row (an indexed lookup), and the
`X-OpenWA-Signature: sha256=<hex>` HMAC over the **raw body**, keyed on
that row's secret, proves it. Verification fails closed. An unknown
session is answered 200 and logged (so OpenWA stops retrying a number
that was removed); a failed lookup is answered 503 so OpenWA redelivers.
After that it is the same edge screen, replay claim and inbound pipeline
as the other two providers.

Only one-to-one chats are processed. Group, status, channel and
broadcast traffic, and the number's own sends, are dropped.
