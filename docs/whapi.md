# WhatsApp via Whapi.Cloud

Taamul Connect talks to WhatsApp through a [Whapi.Cloud](https://whapi.cloud)
channel. A channel is a WhatsApp account paired to the gateway the same
way WhatsApp Web pairs to your phone — you scan a QR code once, and the
gateway exposes that number over a REST API.

## Why this instead of the Meta Cloud API

Earlier versions of Taamul Connect used Meta's official Cloud API. Both work; they
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

> **You can have both.** Taamul Connect supports connecting a Meta Cloud API
> number *alongside* a Whapi channel, and choosing per task which one
> sends — typically campaigns and automations on the Cloud API number,
> conversations on Whapi. It has to be a second phone number, because
> registering a number on the Cloud API removes it from the WhatsApp
> app. See [meta-cloud-api.md](meta-cloud-api.md).

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

## Several numbers

An account can connect more than one Whapi channel, and each channel is
its own WhatsApp number (migration 060). Admins manage them in
**Settings → Numbers & access**:

- **Add Whapi number.** Paste the token of a channel created at
  panel.whapi.cloud. Each channel gets its own callback secret and
  webhook, registered exactly as in step 3. A channel can only be
  connected once, whether on this account or on any other.
- **Name.** Shown in the inbox, the routing selector and here.
- **Default.** The fallback for any task with no explicit route.
- **Manage access** allocates members to the number:
  - *Nobody allocated*: the number is shared, which is the pre-060
    behaviour. Agents see only the chats they own or are assigned.
  - *People allocated*: they may send from that number, and a new chat
    they start goes out on it. Allocation grants no visibility
    (migration 072): they still see only the chats they own or are
    assigned (team leaders also their team's), on any number. Before
    072 an allocated person saw every chat on the number.
  - *Teams allocated* (Settings → Teams, or the Teams section of Manage
    access, migration 071): everyone in the team and its leader get the
    number exactly as if ticked one by one. Joining the team grants it,
    and leaving removes it. Someone also ticked by name keeps the number
    after leaving the team or after the team is unticked; the two kinds
    of allocation add together. A team with nobody in it allocates
    nobody, so a number allocated only to an empty team is still shared.
  - Admins and owners see every chat on every number regardless.

The two settings screens split the work so nothing is done twice:

| Settings → **Numbers & access** | Settings → **WhatsApp** |
|---|---|
| add a number, name it, make it the default, disconnect it | one number's connection: re-enter its token, webhook health, re-register / rotate the callback secret, media retention |
| who works each number | which number each *task* sends from (routing) |
| live status of every number, with a link to fix a broken one | a switcher for which Whapi number you are looking at |

A token that no longer decrypts (a rotated `ENCRYPTION_KEY`) is fixed by
pasting it again and saving on the WhatsApp screen. That keeps the
number's name, its people and its chat history. Disconnecting and
reconnecting would lose all three.

Which number a chat is "on" is `conversations.channel_id`: the number
the customer last wrote to, or for a chat an agent started, the number
it was started from. A customer who writes to a different number moves
the chat to that number's people. Conversations stay one per contact.

Which number sends:

| Send | Number |
|---|---|
| Agent reply, public API reply | the number the customer last wrote to |
| Agent's first message to a new contact | the number the agent is allocated to (else the `inbox` route/default) |
| Flow, automation, AI reply in a chat | the chat's number, unless the task is routed to the **other provider** (e.g. automations → Meta) |
| Broadcast, scheduled automation | the routed number / default |

### Switching a chat's sending number

The thread header has a number picker on every chat (migration 061):

- **Automatic** is the default for every chat, existing ones included.
  Replies go out on the number the customer last wrote to.
- **A number**: everything in this chat goes out from it (agent
  replies, API replies, and bots answering in the chat) until someone
  switches again. The picker offers only the numbers you may use: all
  of them for admins, otherwise your allocated numbers plus shared
  ones. The database refuses anything else.
- Every switch leaves a note in the thread saying who switched it and
  when. The note is never sent to the customer.
- While a chat is pinned, a customer answering on the new number does
  not move the chat to that number's team. The pinned number's people
  can see the chat too.
- Pinning to the **Meta** number follows Meta's rules: free-form
  replies only work within 24 hours of the customer's last message *to
  that number*. Outside that window, send a template.
- A reply quoting a message that another number carried is sent
  without the WhatsApp quote, because message ids belong to the gateway
  that carried them. The CRM thread still shows the quote.
- The Contact screen's *Send message* (always Whapi) and Compass
  notifications (Whapi only) ignore a pin to a Meta number, unless no
  Whapi number is connected at all.
- A reaction always goes out through the number that carried the
  message being reacted to.
- **AI auto-reply** answers only when the number it would reply from
  is the number the customer wrote to. If you route *AI auto-reply* to
  one Whapi number, the bot answers there only, and your other Whapi
  numbers stay human-only. With no route, the bot answers on whichever
  number the customer wrote to. Turning on *Reply on every WhatsApp
  number* in Settings → AI lifts the restriction: the bot answers on the
  number the customer wrote to, except in a chat a person pinned to
  another number.

Only admins can move a chat to another number. The database refuses
the change for everyone else (`conversations_channel_guard`), because
moving a chat shares it with that number's people. Disconnecting a
number keeps its chat history: `channel_id` becomes NULL, and those
chats fall back to owner/assignee visibility.

## How to read the two status banners

Settings shows two independent banners, because these fail
independently and the combination is the confusing case:

- **Channel connected** — the token is valid and the channel is paired
  (`GET /health` reports `AUTH`). Governs *outbound*.
- **Receiving inbound events** — our callback URL is registered on the
  channel. Governs *inbound*.

A healthy channel whose callback points at a dead tunnel URL sends
perfectly and receives nothing. That is what the second banner is for.

## Channel health monitor

A Whapi channel is a linked device, and the phone behind it can drop
the link — a logout, a reinstall, *Log out from all devices*, a phone
left offline too long — while the channel token stays valid. From then
on no messages arrive and every reply fails, and the banners above only
say so while someone has Settings open.

`GET /api/whatsapp/health/cron` (migration 065) closes that gap. Each
tick it probes every Whapi number's `GET /health` (with `wakeup=false`,
so a channel you stopped on purpose stays stopped, and a 5-second
timeout) and updates `whatsapp_config.status`:

| Probe says | Status |
|---|---|
| `AUTH` | `connected` |
| `QR` (logged out), `ERROR` | `disconnected` |
| `401`/`403`/`404` (token revoked, channel deleted), `402` (subscription lapsed) | `disconnected` |
| `LAUNCH`, `INIT`, `NOT_INIT`, anything else, a `5xx` or a timeout | unchanged |

The unchanged row matters: a channel passes through `LAUNCH`/`INIT`
while it starts or syncs after a re-pair, and a Whapi-side blip is not
the number's fault, so neither pages anyone. **Save & connect** writes
the status by the same table, so saving a token while the channel is
still starting keeps the status the number already had rather than
marking it down (and earning a false *connected again* alert later).

On each change of status, every owner and admin of the account gets a
notification (**Notifications**) naming the number, what has to be done,
and who does it. A flapping session produces one *down* and one *back*
alert per flap, never one per tick. Meta numbers are not probed: a Cloud
API number has no session to lose.

The same probe also reports which phone is paired. When a channel is
re-paired to a different handset, the tick (and opening Settings →
WhatsApp) stores the new number. The inbox number picker, the
conversation list and the alerts read that stored number, so they
follow the new phone within one tick and never keep showing the old
one. A name you typed for the number stays. A default
`WhatsApp <number>` label is renamed along with the number.

A *disconnected* change is only kept once its alert is saved. If the
alert cannot be stored — a database error, or a build running before
migration 065 is applied — the status is put back and the number is
counted as failed, so the next tick sees the same change and alerts
again; the server log says so (`[channel-health] … the alert was not
saved`) on every tick until it succeeds. A *connected again* change is
kept even when its notice cannot be saved, so a number that works is
never held at disconnected.

Schedule it like the other crons — every 5 minutes is plenty:

```bash
*/5 * * * * curl -sS -o /dev/null -H 'x-cron-secret: <AUTOMATION_CRON_SECRET>' http://localhost:3000/api/whatsapp/health/cron
```

Until that line exists, `/api/automations/cron` runs the same sweep
itself, at most once every 5 minutes per server process, so an install
that already pings the automation cron is covered.

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

When a Meta Cloud API number is connected alongside the Whapi channel,
**Send template** on a contact goes out on the Meta number and **Send
message** on the Whapi one — see
[meta-cloud-api.md](meta-cloud-api.md#4-choose-what-each-number-sends).
On a Whapi-only install both use the Whapi channel.

## Media

`registerWebhook` enables Whapi's **auto-download**, without which an
inbound attachment arrives as an id whose bytes were never pulled off
the phone. With it on, each attachment carries a `link`.

That link expires in roughly 30 days, so **Settings → WhatsApp → Media
retention** (on by default) copies every inbound attachment into the
account's `chat-media` Supabase Storage bucket as it arrives. The mirror
is best-effort: if it fails, the message still lands and falls back to
the gateway link.

**Forwarding** an attachment from the inbox needs a URL the sending
gateway can fetch without our credentials. A mirrored attachment already
is one; a gateway link (mirroring off, or the mirror failed) is copied
into `chat-media` at forward time. If the gateway no longer holds the
bytes, the forward fails with *"The attachment could not be retrieved"*.
Forwarding is a re-send, so the recipient sees no "Forwarded" label.

The channel token is only ever presented to Whapi's media endpoint —
a `/media/…` path on the `WHAPI_BASE_URL` origin. Any other
media link (auto-download's public object-storage links, or a
`media_url` someone sent through the API) is fetched without
credentials, only if it resolves to a public address, with every
redirect re-checked. Outgoing `media_url` values must be `https://`
(or an object in your own public storage bucket).

## Profile pictures

The inbox shows each contact's WhatsApp profile picture in the chat
list, the thread header and the contact panel. It comes from the Whapi
number's contact profile (`GET /contacts/{phone}/profile`); the Meta
Cloud API has no such endpoint, so a contact who has only written to
the Meta number keeps the initial.

The picture's link is a WhatsApp CDN URL that expires, so the bytes are
copied into the `chat-media` bucket (`account-<id>/avatars/<contact>.jpg`)
and the contact's `avatar_url` points at that copy. The browser never
loads WhatsApp's CDN.

When the inbox loads a page of chats it asks
`POST /api/whatsapp/contacts/avatars` about those contacts. Each contact
is looked up at most once a week (`contacts.avatar_checked_at`,
migration 070), through the chat's own Whapi number when it is
connected, else the default Whapi number. A contact who hides their
picture (or has none) shows the initial, and a picture they remove is
cleared on the next weekly check. A failed lookup changes nothing and is
retried on a later load. Only connected numbers are asked: a wrong token
answers this endpoint with the same 404 as a hidden picture, so each
request first probes the number's `/health` (without waking it) and
skips its contacts unless it reports paired. A chat on the Meta number,
or on a Whapi number that is down, is never looked up through another
number. Only JPEG, PNG and WebP are stored. The weekly check updates
`contacts.updated_at` (visible on the v1 API).

## Keeping the number safe

WhatsApp restricts a Whapi number on what recipients do with its
messages, above all chats that are started and never answered. Team
activity (`docs/team-activity.md`, migration 068) shows each person's
and each number's record against daily new-chat limits, and it warns
employees in the composer. It sends bell alerts when someone goes over
a limit, and it can refuse a person's new chat past the limit (off by
default; replies always go out). Each number's card also shows Whapi's
own Safety Meter rating.

## Environment variables

There is **no global Whapi credential** — each account pastes its own
channel token in Settings, encrypted with `ENCRYPTION_KEY`.

| Variable | Required | Purpose |
|---|---|---|
| `ENCRYPTION_KEY` | yes | AES-256-GCM key (64 hex chars) for the channel token and webhook secret |
| `NEXT_PUBLIC_SITE_URL` | in practice | HTTPS origin written into the registered callback URL |
| `WHAPI_BASE_URL` | no | Override for a self-hosted Whapi (default `https://gate.whapi.cloud`) |
| `WHAPI_TIMEOUT_MS` | no | Per-request timeout, default `30000` |
| `WHAPI_TOOLS_URL` | no | Host of Whapi's Safety Meter, read by Team activity (default `https://tools.whapi.cloud`) |

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

**"Waiting for QR scan", "is logged out of WhatsApp", or a *logged
out* notification.**
The phone behind the channel dropped its linked-device session. The
token is fine, so **do not re-save the token or disconnect and re-add
the number in Settings** — that fixes nothing, and re-adding loses the
number's name, people and chat history. Instead:

1. Someone with access to panel.whapi.cloud opens **this same channel**
   and shows its QR code. Do not create a new channel: its callbacks
   would be dropped as a channel mismatch until its token is saved.
2. Whoever holds the phone scans it from **WhatsApp → Linked devices →
   Link a device**.
3. The channel reports `AUTH` again within a minute or two, and the
   monitor sends a *connected again* notification.
4. Messages customers sent while it was down are not guaranteed to be
   replayed, so compare the phone's WhatsApp chats with the inbox, and
   re-send any replies that failed — failed replies are not saved.

If it keeps happening, check the channel's event log at
panel.whapi.cloud, and on the phone: keep it online and charged, exempt
WhatsApp from battery optimisation, and look for unknown entries under
Linked devices.

**A send fails with "Whapi refused to send from this number".**
Whapi answered 401/403. The send path then probes the channel and
words the error for what it finds: *logged out* (re-scan as above),
*starting up* (retry shortly), *reports connected* (a transient refusal —
retry), or *no longer accepts the token* (the channel was deleted or its
token changed — paste the current one on the WhatsApp screen). The
server log line for each failure also carries Whapi's own status, code,
message and details.

**Settings lists a webhook that isn't this CRM's.**
**Save & connect** only replaces this CRM's own entry and leaves every
other webhook on the channel alone, on purpose. But each of those
receives every message on the number, so remove any you don't
recognise (a request bin left over from testing, say) at
panel.whapi.cloud → the channel → Settings → Webhooks.

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
| `src/lib/whatsapp/contact-avatars.ts` | Profile pictures: look up, copy into `chat-media`, weekly refresh |
| `src/lib/whatsapp/channel-health.ts` | Health monitor: probe → status → owner/admin alerts |
| `src/app/api/whatsapp/health/cron/route.ts` | The monitor's cron endpoint |
| `supabase/migrations/040_whapi_provider.sql` | Column remapping, documented on the table |
