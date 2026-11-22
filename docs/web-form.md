# Lead source and the public web form

Migration 249. This page is the operator contract.

## Lead source

Every contact has a `lead_source`: where it came from.

| value       | set by                                                    |
| ----------- | --------------------------------------------------------- |
| `ad`        | a Meta Click-to-WhatsApp ad (first inbound message)       |
| `web_form`  | the public web form                                       |
| `manual`    | Contacts → Add contact                                    |
| `import`    | Contacts → Import (CSV / Excel)                           |
| `broadcast` | reserved: contacts created by a campaign's CSV audience   |
| `compass`   | reserved: the Compass integration                         |
| `other`     | a referral that is not an ad (a Facebook/Instagram post)  |
| empty       | unknown, including every contact created before 249       |

`lead_source_detail` is a small object saying which ad or page:

- ad: `{ via: "whatsapp_referral", source_type, source_id, headline,
  source_url, ctwa_clid }` (only the fields Meta sent; strings trimmed and
  capped).
- web form: `{ form: "web", page_url, submitted_at }` (the page's address
  without its query string).

**First source wins.** People may set or correct the source. Automatic
writers (the ad capture, the web form) only fill an empty source, through
`contact_set_lead_source_if_empty` (service role). A contact who came from
an ad and later fills in the form stays `ad`.

**Ads.** Meta puts a `referral` object on the first message of a chat
opened from an ad or post. The Meta webhook records it on the contact's
first inbound message in its company chat (never a personal number's
chat), after the replay check, so a redelivered webhook records nothing
twice. It costs one database call and never delays or fails the message.
Whapi and OpenWA never carry a referral.

The public API's contacts carry a read-only `lead_source`.

## The web form

Settings → Integrations → Web form (owners and admins).

- **Off by default.** While off, the link answers "not found" and posts
  are refused with 404, exactly like a link that never existed.
- **Link**: `<site>/f/<token>`, a hosted page with name, phone (required),
  email and message. It needs no JavaScript and works on a phone.
- **Embed**: a plain HTML `<form>` snippet that posts to
  `<site>/api/public/web-form/<token>`. After sending, the visitor lands
  on the hosted thank-you page. There is no iframe snippet: every page
  keeps `X-Frame-Options: DENY` / `frame-ancestors 'none'`, and the form
  page is no exception.
- **Allowed websites**: the https origins (`https://www.example.com`, no
  path) that may post the form from their own pages. Empty means the
  hosted link only. With a list, a post must carry one of those origins
  (browsers always send it); a post with no `Origin` header is accepted
  only while the list is empty.
- **New link** issues a new token. The old link and every pasted snippet
  stop working at once.

### What a submission does

1. The phone is checked like every typed number (with its country code;
   a local number such as `050…` is refused with "does not look right").
2. The contact is found by number, or created and owned by the workspace
   owner, with the submitted name and email. An existing contact keeps its
   name, email and owner, even an empty one (migration 256: a public form
   never renames a customer); the submitted name and email go in the
   task below instead (its note, and `submitted_name` / `submitted_email`
   in its details).
3. `lead_source` becomes `web_form` if it was empty.
4. A **New web lead** follow-up task is opened, unassigned and linked to
   the contact, with the visitor's message as its note. Admins see it, and
   so does anyone who can see the contact. The same number submitting
   again within 10 minutes opens no second task.

It never sends a WhatsApp message and never changes a contact's opt-out or
consent.

### The endpoint

`POST /api/public/web-form/<token>`, JSON or
`application/x-www-form-urlencoded`, at most 8 KB. Fields: `name` (≤ 120),
`phone` (required), `email` (≤ 254), `message` (≤ 2000), `page_url`
(optional; else the `Referer`). `website` is a hidden trap field: a
submission that fills it is answered as a success and stored nowhere.

| answer | when |
| ------ | ---- |
| 200 `{ ok: true }` / 303 to `/f/<token>?sent=1` | stored (JSON / HTML form) |
| 404 `not_found` | unknown or switched-off form (the same answer) |
| 403 `origin_not_allowed` | the posting site is not allowed |
| 413 / 415 / 400 | body too large / not JSON or a form / unreadable |
| 422 `{ error, field }` / 303 `?error=<code>` | `phone_required`, `bad_phone`, `bad_email`, `too_long` |
| 429 `rate_limited` + `Retry-After` | over the limits below |

`OPTIONS` answers the CORS preflight for an allowed website only;
`Access-Control-Allow-Origin` is only ever that website.

**Rate limits** (`lib/edge`, scopes `webform.ip`, `webform.ip_token` and
`webform.token`): 10 requests a minute per client IP (the `OPTIONS`
preflight counts too, and is limited before the form is looked up), 5 an
hour per client IP per form, and 200 an hour per form, so a handful of
addresses cannot use up a form's hourly allowance (skipped when no client
IP is known). All three
**fail closed**: if the rate store is down, the form refuses. The client
IP comes from `EDGE_CLIENT_IP_HEADER` (see `docs/security.md`); unset, all
visitors share one bucket of 10 a minute, so set it in production.

Nothing here is logged with the visitor's data.
