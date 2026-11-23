# Edge security

What the app does at its edge before a request reaches the CRM: the
WhatsApp webhooks are screened, sign-in has a lockout, and the public
API locks out an IP that presents bad keys (module 017a). Every claim,
counter and lock lives in Postgres (migration 084), so every app
instance shares one window and one clock. The tables and functions are
service-role only.

## WhatsApp webhooks

Both inbound webhooks (Whapi and Meta) screen every authenticated
delivery. `docs/whapi.md` and `docs/meta-cloud-api.md` have the details
per provider.

- **Replay keys per number.** Each message and status transition is
  claimed once; a redelivery within 24 hours is skipped as a duplicate.
- **4 messages per second per sender.** A message over the limit is
  kept — saved to the inbox, unread count bumped — but nothing answers
  it: no Flow, automation, AI reply, campaign follow-up or outbound
  webhook.
- **IP sanity limit**, 600 requests per second per client IP; over it,
  the request is answered 200 and nothing in it is processed.
- **Never 429.** A provider would only retry sooner. The one non-200 is
  503, for an event another delivery is still processing, so the
  provider redelivers it. If the stores cannot be reached, screening
  fails open: a duplicate is cheaper than a lost message.

## Sign-in lockout

The login page posts to `POST /api/auth/login`, which checks the
lockout before the password goes to Supabase Auth (GoTrue):

- **5 failures** for one email from one client IP, or **60 failures**
  from one IP for any emails, **within 10 minutes** lock that pair (or
  the whole IP) for **15 minutes**. Emails are compared case-blind.
- A locked caller gets **423** with `retryAfterSeconds` ("Try again in
  N minutes") and GoTrue never sees the attempt. A success clears only
  that email's failures; they still count toward the IP's 20.
- Admin rate limits come first too: 10 attempts per second per IP and
  30 per second per email answer **429**.
- Every credential failure is the same **401**, so the answer never
  says whether an email exists. A deactivated member still gets "Your
  access has been deactivated" (403), and the attempt counts as a
  failure.
- The lockout **fails closed**: if its store cannot be read, or a
  failure cannot be recorded, sign-in answers **503** "Sign-in is
  temporarily unavailable". GoTrue being down or throttling is not
  counted against anyone.

Without a client IP (see below) the "IP" is the email itself
(`unknown:<email>`), so one attacker cannot lock everybody out of a
shared bucket; the 20-per-IP limit then only applies per email. Set
the client-IP header.

Sign-in now reaches GoTrue from the app server. If your GoTrue
rate-limits by IP (`GOTRUE_RATE_LIMIT_HEADER`), it sees one address
for everyone; the app's own limits above replace that one.

## API-key lockout

On the public API (`/api/v1`), an unknown, revoked or expired key
counts as a failure for the caller's IP; a good key clears the run.
5 bad keys in a row, or 60 in 10 minutes, lock the IP for 15 minutes.
A locked IP is refused before its key is looked up, with the ordinary
`429 rate_limited` answer and headers, so a lockout looks exactly like
rate limiting.

It **fails open**: keys are 256-bit random secrets, so the lockout is
defence in depth, and an unreachable store must not take every
integration down. Without a client IP it is off — one shared bucket
would let one bad caller lock out every integration.

## Client IP

Every IP limit and lockout keys on the one header your own proxy sets,
named by `EDGE_CLIENT_IP_HEADER` — never guessed:

- Behind a Cloudflare tunnel or proxy:
  `EDGE_CLIENT_IP_HEADER=cf-connecting-ip`.
- Behind a proxy that sets it: `x-real-ip`.
- `x-forwarded-for`, with `EDGE_TRUSTED_PROXY_HOPS` set to the number
  of proxies you run in front of the app (default 1). The client is the
  entry that many places from the right; the left-most entry was
  written by the client and is never trusted.

Unset (or the header missing), the webhooks share one `unknown`
bucket, sign-in keys on the email, and the API-key lockout is off.
IPv6 addresses are bucketed by their /64.

## Stored file types

Storage is served on the app's own origin and returns each object with
the type it was stored with, so a file stored as HTML or SVG would run
as the app when its link is opened. The private buckets `chat-files`,
`deal-files` and `call-recordings` therefore store only the types in
`src/lib/storage/safe-mime.ts` (`safeStoredMime`: lower-cased,
parameters dropped; a comma, a control character or anything off the
list is stored as `application/octet-stream`, which browsers download).

Migration 164 enforces the same list in the database, for a client
that bypasses the app:

- Each bucket's `allowed_mime_types` is set to it (with `audio/*` and
  `video/*`). Storage checks that on upload only, and only up to the
  first `/`, so `audio/x, text/html` passes as `audio/*` and a browser
  then renders it as HTML (it takes the last of comma-separated types).
- The `storage_objects_safe_mime` trigger closes both gaps. Every
  Storage route writes the `storage.objects` row, whose metadata holds
  the stored type, and an object with no row is never served. For the
  three buckets the trigger refuses a row whose `metadata.mimetype` (the
  type the S3 backend serves) or `metadata.contentType` (the type the
  file backend's copy writes) has a comma or a control character, or
  whose type before any `;` is not on the list, `audio/<x>` or
  `video/<x>`. On the copy route (`POST /storage/v1/object/copy`),
  which never checks `allowed_mime_types` and merges the caller's
  `metadata` into the copy, that refuses a copy that sets a bad type.
  An update that keeps the bucket, version and type (Storage touching
  the owner or `last_accessed_at`) is not re-checked, so old objects
  stay readable.

What the database cannot see: on Storage's **file backend** (the
self-hosted default) the type a file is served with is kept on disk
with the file (the `user.supabase.content-type` extended attribute),
not taken from the row. A copy keeps the source file's attribute unless
the caller sets `contentType`, so a copy that sets only
`metadata.mimetype` to a safe type passes the trigger and is still
served with the source's type: an old HTML or SVG object, or a file
uploaded to a public bucket (`avatars`, `chat-media`, `flow-media`,
which 164 leaves alone) with a type list such as
`image/png/,application/xhtml+xml`, which Storage accepts as
`image/png`. **The nginx headers below are therefore required**, not
optional; they are what make every stored file safe, including those
stored before 164.

### Required nginx headers on storage

Give Storage its own location ahead of `location /supabase/`, with the
same proxy settings, and sandbox every response that is not one plain
media type or a PDF. A sandboxed document gets an opaque origin and no
script, so an HTML, SVG or XML file cannot act as the app; `<img>`,
`<audio>` and `<video>` embeds are unaffected. The whole Content-Type
must match, because a comma would let the browser pick a later type.

```nginx
# http level, next to the other map blocks
map $upstream_http_content_type $storage_csp {
    "~*^(image/(png|jpeg|gif|webp|heic|heif|bmp|tiff)|audio/[a-z0-9.+-]+|video/[a-z0-9.+-]+|application/pdf)\s*(;[^,]*)?$" "";
    default "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'";
}

# server block, before location /supabase/
location /supabase/storage/ {
    proxy_pass http://127.0.0.1:8000/storage/;
    proxy_http_version 1.1;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Cookie            "";
    proxy_read_timeout  3600s;
    proxy_send_timeout  3600s;
    proxy_buffering off;
    proxy_buffer_size       32k;
    proxy_buffers        8  32k;
    proxy_busy_buffers_size 64k;
    add_header Content-Security-Policy $storage_csp always;
    add_header X-Content-Type-Options  nosniff always;
}
```

An empty map value adds no header. `add_header` in a location drops
any inherited from the server block, so repeat those here if your
server block sets any. `verify-storage-safe-mime.sql` asserts the bucket
lists and the trigger's refusals; nothing in CI checks the nginx
headers.

## Chats and messages from a login (migration 284)

What a signed-in person's own database access may write, whatever the
client:

| Table | Allowed | Never |
| --- | --- | --- |
| `conversations` | open a company chat for a contact they can see; open a personal chat on their own personal number; update a chat they can see | change its contact or workspace; delete it (delete the contact: open work and the legal hold are checked there); take it off its number unless an admin |
| `messages` | add their own sent message to a chat they may write to | edit or delete any message; add one for the customer, the bot or a colleague, with another status, time or AI mark |

Webhooks, delivery statuses, automations, merges and erasure use the
service role or definer functions and are not affected. Refusals are
`42501`.

## WhatsApp media in Storage (migration 283)

`chat-media` and `flow-media` are public buckets, because the WhatsApp
gateways fetch a file by its link: whoever holds an object's full link can
open it. Everything else about an object goes through RLS on
`storage.objects`:

- A signed-in person lists, reads, replaces, moves and removes only the
  objects they uploaded (`owner_id`, or `owner` on a row an older Storage
  wrote), and only in their active workspace's folder. This holds for
  owners and admins too: what a person may see of a customer's files is
  decided by the messages they may see, not by the bucket.
- A person uploads into `chat-media` at `account-<id>/<file>`,
  `account-<id>/staged/<file>` and `account-<id>/groups/<file>` only.
  `inbound/`, `avatars/`, `voice-library/` and any other folder are
  written by the server (service role). A new folder the browser uploads
  to needs a migration restating 283's list
  (`src/lib/storage/chat-media-owner-policy.test.ts`).
- Anything a screen must do with another person's object goes through a
  route with its own permission check and the service role, as the voice
  library does.

`verify-chat-media-owner.sql`.

## Housekeeping

`edge_purge()` deletes expired claims, counters, failures and locks.
`GET /api/automations/cron` runs it at most every 15 minutes per
process; an install that does not ping that cron can schedule
`SELECT public.edge_purge()` with pg_cron every 15 minutes instead.
Correctness does not depend on it: an unpurged row is dead weight,
never a wrong answer.

## Read rules (migration 285)

- `automation_logs`, `automation_steps`, `flow_nodes`: owners and admins.
- `whatsapp_config`: every member reads the rows, nobody signed in reads
  `access_token`, `verify_token` or `app_secret`. These columns are not
  granted to `authenticated`, so a session never selects `*` from this
  table; server code adds them with `withChannelSecrets()`
  (`src/lib/whatsapp/channel-secrets.ts`). A new column needs its own
  `GRANT SELECT`; `verify-read-rules.sql` fails until it has one.
- `contact_notes`: a note is inserted and changed by its writer only, on a
  customer the writer can see.
## Invitations and API keys (migration 287)

Both are made only in the name of the signed-in owner or admin who makes
them. An invitation is for an assignable role, lasts at most 365 days and
cannot be edited, only deleted. It opens with its token, which the database
hashes; the stored hash is not a link. The older calls that take the hash
(`redeem_invitation`, `peek_invitation`) stay callable only until the build
that uses the token is out; then revoke them from `anon` and
`authenticated`. An API key can be revoked but not otherwise changed by a
session, and it keeps working after its maker leaves until someone revokes it
in Settings → API keys.
## A row belongs to its parent's account (migration 286)

- A table that carries its own `account_id` beside a parent id ties the
  two with a composite foreign key or a restrictive policy:
  `team_members`, `whatsapp_channel_members`, `whatsapp_channel_teams`,
  `whatsapp_routes`, `broadcast_recipients`, `broadcasts`,
  `contact_tags`, `contact_custom_values`, `ai_knowledge_chunks`.
- A function that reads `team_members` through a team joins on
  `account_id` too; `verify-team-and-row-rules.sql` reads every body.
- `team_members` has ONE foreign key to `teams`, the composite one: a
  second would make PostgREST's `teams(team_members(...))` ambiguous.
- A session writes only its own reaction, edits only its own customer
  note (an admin may delete one), and links a deal only to rows it can
  read (`deals_link_guard`).
