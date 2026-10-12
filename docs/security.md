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

- **5 failures** for one email from one client IP, or **20 failures**
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
5 bad keys in a row, or 20 in 10 minutes, lock the IP for 15 minutes.
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

## Housekeeping

`edge_purge()` deletes expired claims, counters, failures and locks.
`GET /api/automations/cron` runs it at most every 15 minutes per
process; an install that does not ping that cron can schedule
`SELECT public.edge_purge()` with pg_cron every 15 minutes instead.
Correctness does not depend on it: an unpurged row is dead weight,
never a wrong answer.
