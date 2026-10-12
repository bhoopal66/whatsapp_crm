# Phone system (Yeastar P-Series)

Operator notes for connecting a Yeastar P-Series PBX (Cloud, Software or
Appliance edition) to Taamul Connect. Calls land on the customer's
timeline next to their WhatsApp chat. The database side is migration
`089_pbx.sql`.

Everything below is set in **Settings → Phone system** by an owner or
admin of the workspace that owns the PBX.

## 1. What to enable on the PBX

| On the PBX                                                                    | What for                                                                                                       | Needs                                                                                                                          |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **Integrations › API** — an application with **Client ID / Client Secret**    | Everything the server does: listing extensions, click-to-call, call control, call records, recording downloads | —                                                                                                                              |
| **Linkus SDK** — **AccessID / AccessKey**                                     | The browser softphone (agents answer and place calls in the CRM)                                               | **Ultimate** plan, firmware **84.12.0.32** or later                                                                            |
| **Webhook push** to the URL shown in Settings, with a **32-character secret** | Live call events, registration and presence                                                                    | Firmware **84.20.0.21** or later. On older firmware run the **WebSocket gateway script** instead, which relays the same events |
| **Extension Status Monitor**                                                  | Presence, registration and per-extension call state                                                            | —                                                                                                                              |

Paste the Client ID and Secret (and the SDK pair, if you use the
softphone) into Settings and press **Test connection**. Secrets are
stored encrypted and never shown again; leave a field empty to keep the
stored value. On the Cloud edition the address must be `https://`.

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

- **Numbers.** Under **Numbers**, list each dialled number (DID) and the
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

## 3. Recording rules

- **Announcement.** Configure the English/Arabic recording notice on
  the PBX to play before **every** recorded call. A fetched recording is
  marked as announced on that basis, and the basis is kept on the call
  (`meta.announcement_basis`: `pbx_prompt` while the workspace requires
  the notice, the default; `not_required` while it is switched off).
- **Bank numbers.** List the bank staff numbers (with the bank's code)
  under **Bank numbers**. While **Exclude bank numbers** is on (the
  default), calls with those numbers are kept unrecorded. Leave it on
  until each bank's DSA terms allow its calls to be recorded.
- **Retention.** Empty keeps recordings; otherwise 1 to 3650 days. How
  long to keep them is an open legal decision for each workspace.
- Recordings sit in a private bucket. Every play is logged, and the
  owner can erase a customer's call records on request, unless a
  recording is under legal hold.

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
| `GET/PUT /api/pbx/bank-numbers`                                | `{ bankNumbers: [{ number, bankCode }] }`, replaces the list            |

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
- **Customer.** The caller is matched only among that workspace's
  contacts. Several matches link none; the candidates are kept on the
  call for the person to pick.
- **Missed calls** (an inbound call that ends unanswered, busy,
  abandoned or in voicemail) open one _Call back_ task, due after the
  workspace's missed-call delay, for the contact's owner, else the first
  person it rang, and ring that person's bell. A ring-group call a
  colleague answered is not missed.
- **Recordings** are marked for fetching, or kept unrecorded (_held_)
  for a bank number while **Exclude bank numbers** is on.
- Every event is stored once (re-sends are ignored); one that cannot be
  processed keeps its error on the stored event.

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

## 8. Recordings

A call the PBX recorded is marked _pending_ when it ends, and the
phone-system cron (below) copies the audio **once** into the private
`call-recordings` bucket (`account-<id>/calls/<call id>.<ext>`, with
its SHA-256 and size), one download at a time. The PBX's own download
link (valid 30 minutes) is never stored. A busy answer from the PBX
ends the run and the next run continues; any other failure is retried,
up to five times, before the call is marked _failed_.

Calls _held_ for a bank number and _erased_ calls are never fetched.
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

## 10. The phone-system cron

`GET /api/pbx/cron` (header `x-cron-secret` = `AUTOMATION_CRON_SECRET`)
fetches pending recordings, dials due call-backs, retries events that
failed to process (three times each), and purges old rows. Each run
stops starting work after 45 seconds. The automations cron also runs it,
at most once a minute, so an install that already pings
`/api/automations/cron` needs nothing more. A PBX connection that is
backing off after a refused login is skipped until the backoff ends.
