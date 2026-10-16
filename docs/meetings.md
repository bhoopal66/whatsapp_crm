# Video meetings

Staff-only video meetings at `/meetings`: schedule one for later, or
press **Start now** for an instant one. Inside the call there is a
participant grid, microphone, camera and screen share, and the host (or
an admin) can **End for everyone**. Media runs through Cloudflare's
Realtime SFU (formerly "Cloudflare Calls"); the database only holds who
may join and who is in the room. Migration `106_meetings.sql`; the rules
below are enforced in Postgres (RLS and triggers) and asserted by
`supabase/ci/verify-meetings.sql`.

## Setup

1. In the Cloudflare dashboard open **Realtime → SFU** and create an
   app. Note its **App ID** and **App Secret**.
2. Set them in the server environment (never `NEXT_PUBLIC_*`: the
   secret must not reach the browser):

   ```
   CLOUDFLARE_CALLS_APP_ID=...
   CLOUDFLARE_CALLS_APP_SECRET=...
   ```

3. Restart the app. Both are read at request time, so no rebuild is
   needed.
4. Apply `supabase/migrations/106_meetings.sql` (superuser or
   BYPASSRLS role, as 087).

5. Optional, recommended: a **TURN** relay, so people behind strict
   corporate networks or UDP-blocking firewalls still connect (relayed
   over TCP/TLS, port 443). It is free with the SFU. In the Cloudflare
   dashboard open **Realtime → TURN**, create a key, and note its
   **key id** and **API token**:

   ```
   CLOUDFLARE_TURN_KEY_ID=...
   CLOUDFLARE_TURN_KEY_API_TOKEN=...
   ```

   Server only, read at request time. Each join mints 6-hour
   credentials (`POST /v1/turn/keys/{id}/credentials/generate-ice-servers`,
   5 s timeout, `src/lib/meetings/turn.ts`) and drops every URL on port
   53, which browsers block. Unset, refused or slow: the seat gets STUN
   only and the join still succeeds. Only Cloudflare's status is logged,
   never a token or credential.

Without the two SFU variables meetings can still be scheduled, edited and
cancelled, but joining and every media route answer **503
`meetings_not_configured`**, and the room shows a "Video meetings
aren't set up yet" notice.

## Cost

Cloudflare bills the SFU by egress: the first 1,000 GB per month are
free, then $0.05 per GB. Ingress is free. As a rough estimate (not a
measured figure), a 6-person video meeting sends about 15-20 GB of
egress per hour, so the free tier covers on the order of 50-65 such
meeting-hours a month. Audio-only meetings cost a small fraction.

## Who sees and joins a meeting

Every rule applies inside the caller's active workspace.

- **Sees and joins:** owners and admins (all meetings), the host, an
  invitee, and everyone in the workspace when **Anyone in the workspace
  can join** (`open_to_workspace`) is on.
- **Edits:** the host (organiser) only — owners and admins included. The
  database enforces it too (`meetings_host_only` trigger, migration 110):
  a title, description, time or "anyone can join" change by anyone but
  the host is refused, and only the host adds or removes invitees.
- **Cancels, ends:** the host, or an owner/admin.
- **Creates:** a team leader, admin or owner, who becomes the host
  (migration 111; the API answers 403 "Only team leaders and admins can
  create meetings" below that). Agents and viewers only attend: the
  meetings they are invited to and the ones open to the workspace. The
  *New meeting* buttons on /meetings and the calendar are hidden for them.
- **Bank guests:** never. They see and write nothing here, and the API
  answers 403 "Video meetings are for staff only".

An invitee must be a live, non-guest member of the meeting's workspace.
Inviting someone other than yourself rings their bell
(`meeting_invite`, `meta.meeting_id`). A meeting has at most 100
invitees.

## Statuses and "live"

`status` is `scheduled`, `ended` or `cancelled`. `ended` and
`cancelled` are final: the guard trigger refuses reopening, stamps
`ended_at` on ending, and closes every participant row still open.
**Live is not stored.** A meeting is live while someone is present.

Presence: each client sends a heartbeat every **20 s**; a participant
is present while they have not left and their last heartbeat is within
**60 s**. Closing the tab simply lets the seat lapse. A heartbeat on an
ended or cancelled meeting closes the seat and answers 409, the cue for
the client to leave. A seat that is missing or already closed answers
404; a failed database read, or a failed `meeting_can_view` /
`meeting_can_manage` check, answers **503 `temporarily_unavailable`**
(on every meeting route), so a blip never reads as "you left", "not
found" or "not allowed". Joining again (another tab, a reload) closes the
person's previous seat. A person holds at most one open seat per
meeting (a partial unique index); two tabs joining at the same moment
both succeed, and the later one's seat is the open one.

## How the call works

The browser never sees the App Secret and never calls Cloudflare's API.
Each SDP exchange goes through `/api/meetings/[id]/sfu/*`; media then
flows browser to SFU directly. The routes confine a participant to
their own meeting (`src/lib/meetings/sfu-rules.ts`), because one
Cloudflare app serves every meeting of every workspace:

- A track a participant publishes must be named
  `<participantId>:audio|video|screen[:...]`; any other name is a 403.
- A track a participant pulls must come from the Cloudflare session of
  a participant **present in the same meeting**.
- `autoDiscover` is refused.
- Closing tracks is limited to the caller's own.

Who is in the room, and what they publish, comes from
`meeting_participants` over realtime. The participant rows are written
only by the API routes, on the service role, after an RLS check of
`meeting_can_view`.

### Cutting media when a seat closes

Closing a seat in the database does not stop Cloudflare: the session
keeps relaying every track it published or pulled. So whenever the
server closes a seat it also force-closes that session's tracks
(`src/lib/meetings/cut.ts`: `GET sessions/{id}`, then
`PUT sessions/{id}/tracks/close` with every mid not already `inactive`
and `force: true`, which stops their media without an SDP exchange).
This happens on:

- **Leave** — the caller's seat (also when it was already closed).
- **Moderate → remove** — the removed seat (host/admin; see below).
- **End** and **cancel** — every seat open just before the status
  change (they are read first, because entering `ended`/`cancelled`
  closes them).
- **PATCH** that leaves the meeting closed to the workspace while
  removing invitees, or switching **Anyone in the workspace can join**
  off — every open seat of someone who is not the host, not an invitee
  and not a live owner/admin of the workspace is closed (service role)
  and cut. Owners and admins keep their seats.

The cut is best-effort and awaited: a Cloudflare failure is logged and
the route still answers as usual; unconfigured installs skip it.

Known limits:

- **Deactivated members** are not cut. Their next heartbeat is refused
  by RLS, so an honest client leaves; a client that ignores that keeps
  receiving until its seat is closed by one of the routes above (end,
  for example).
- A seat opened between end's read and its status update is closed by
  the trigger but not cut; its heartbeat answers 409.
- Joining again closes the person's previous seat without cutting it
  (same person, so nothing is exposed; the old tab's session lapses).

## Network and browser requirements

- **STUN** (`stun.cloudflare.com:3478`), plus Cloudflare **TURN** when
  `CLOUDFLARE_TURN_KEY_ID` / `CLOUDFLARE_TURN_KEY_API_TOKEN` are set
  (see Setup). Without TURN, very strict corporate networks, or any
  that block UDP, may fail to connect.
- The app's `Permissions-Policy` allows `camera`, `microphone` and
  `display-capture` for `self`, and the CSP `connect-src` includes
  `https://rtc.live.cloudflare.com`. A reverse proxy that overrides
  either header breaks the room.
- A dropped connection (ICE failed, or disconnected for 15 s) rejoins
  from scratch, up to 3 tries.

## API

All routes are staff only (`requireMeetingsUser`). Errors are
`{ error: string }`.

| Route                                          | Purpose                                                                |
| ---------------------------------------------- | ---------------------------------------------------------------------- |
| `GET /api/meetings?scope=live\|upcoming\|past` | List what the caller can see                                           |
| `POST /api/meetings`                           | Schedule (or start now) a meeting, with invitees                       |
| `GET /api/meetings/[id]`                       | One meeting                                                            |
| `PATCH /api/meetings/[id]`                     | Edit; replaces the invitee list (host only, scheduled only)            |
| `DELETE /api/meetings/[id]`                    | Cancel (host/admin)                                                    |
| `POST /api/meetings/[id]/join`                 | Open a seat: `{ participantId, sessionId, iceServers }` (503 if unset) |
| `POST /api/meetings/[id]/heartbeat`            | `{ participantId, audioMuted, videoOff }`; keeps the seat present      |
| `POST /api/meetings/[id]/leave`                | Close the seat (idempotent)                                            |
| `POST /api/meetings/[id]/end`                  | End for everyone (host/admin)                                          |
| `POST /api/meetings/[id]/sfu/tracks`           | Publish or pull tracks (503 if unset)                                  |
| `PUT /api/meetings/[id]/sfu/renegotiate`       | SDP renegotiation (503 if unset)                                       |
| `PUT /api/meetings/[id]/sfu/tracks/close`      | Close tracks (503 if unset)                                            |
| `PUT /api/meetings/[id]/sfu/tracks/update`     | Switch a pulled track's simulcast layer (503 if unset)                 |
| `GET /api/meetings/[id]/messages`              | Chat or reaction history                                               |
| `POST /api/meetings/[id]/messages`             | Send a chat line or a reaction                                         |
| `POST /api/meetings/[id]/state`                | Raise/lower the caller's hand; publish mic/camera at once              |
| `POST /api/meetings/[id]/moderate`             | Mute, lower a hand or remove someone (host/admin)                      |

A Cloudflare failure is answered 502 (refused) or 504 (no answer);
Cloudflare's own status is never passed through.

### Chat, hands and moderation (migration 107)

- **Messages.** `POST /api/meetings/[id]/messages` `{ kind: 'chat' |
'reaction', body }` → **201** `{ message: { id, user_id, kind, body,
created_at } }`. A chat line is trimmed, 1–2000 characters; a reaction
  is one of 👍 👏 😂 ❤️ 🎉 😮. It is written by `meeting_post_message`
  under the caller's own client (no service role): **404** when the
  caller can't see the meeting, **409** once it has ended or was
  cancelled, **400** for a bad body, **429** `{ error: 'rate_limited' }`
  past 20 messages per person per meeting per 10 s.
  `GET …/messages?kind=chat|reaction&before=<ISO with offset>&limit=1..200`
  (defaults `chat`, now, 200) → `{ messages: [...] }`: the latest
  `limit` before `before`, oldest first. Nobody edits or deletes one.
- **State.** `POST /api/meetings/[id]/state` `{ participantId,
handRaised?, audioMuted?, videoOff? }` (at least one) on the caller's
  own open seat → `{ ok: true, hand_raised_at }`. Raising stamps
  `hand_raised_at` once (raising again keeps the place in the queue);
  lowering clears it. 404 for a seat that isn't the caller's open one,
  409 for a closed meeting.
- **Moderate.** `POST /api/meetings/[id]/moderate` `{ target:
participantId, action: 'mute' | 'lower_hand' | 'remove' }` → `{ ok:
true }`, host/owner/admin only (403), on an open seat of this meeting
  (404). `mute` stamps `mute_requested_at` (the client mutes itself; the
  server cannot touch a browser's microphone); `lower_hand` clears the
  hand; `remove` closes the seat (`left_at` = `removed_at`, `removed_by`
  the caller) and cuts its Cloudflare media, so a client that ignores it
  stops sending and receiving. Removing yourself is a 400 (use Leave).
  A removal sticks for the rest of the meeting (migration 110): it is
  recorded in `meeting_removed_users` before the seat is closed, and
  while that row exists `join` answers 403 `removed_from_meeting`
  (before any Cloudflare session is made) and chat and reactions answer
  403 `removed_from_meeting` (`meeting_post_message` raises P0001
  `removed`). `{ target: userId, action: 'readmit' }` (the person's
  user id, not a seat) lets them back in: host/owner/admin only (403),
  404 if they were not removed. `GET /api/meetings/[id]` lists
  `removed: [{ user_id, removed_at }]` for a manager only; the room's
  People panel shows them under **Removed** with **Let back in**.
- **Simulcast.** A pull in `sfu/tracks` may carry `simulcast: {
preferredRid: 'f'|'h'|'q', priorityOrdering?, ridNotAvailable? }`
  (`none` or `asciibetical`). `PUT …/sfu/tracks/update` `{ participantId,
request: { tracks: [{ location: 'remote', sessionId, trackName, mid,
simulcast }], sessionDescription? } }` switches the layer on the
  caller's own session; each track must come from someone present in
  this meeting (403). Cloudflare's answer is returned as is.
- **Lists.** `GET /api/meetings` gives each meeting `participants`: the
  present seats as `{ user_id, hand_raised_at }`. `GET /api/meetings/[id]`
  returns the present seats with `hand_raised_at` and a `chat_count`
  (chat lines, not reactions).
