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

- **Announcement.** Playback of a recording is held until the PBX
  confirms the English/Arabic recording notice was played on that call.
  The workspace can switch this requirement off; it is on by default.
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
