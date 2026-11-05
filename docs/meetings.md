# Video meetings

Staff-only video meetings at `/meetings`: schedule one for later, or
press **Start now** for an instant one. The room is a page with a
participant grid, microphone, camera, screen share, chat, shared notes
and host tools, and the host (or an admin) can **End for everyone**. The
call lives in the dashboard shell, so it carries on while you move to
other pages. Media runs through Cloudflare's Realtime SFU (formerly
"Cloudflare Calls"); the database only holds who may join and who is in
the room. Migrations `106_meetings.sql` and `176_meeting_host_tools.sql`;
the rules below are enforced in Postgres (RLS and triggers) and asserted
by `supabase/ci/verify-meetings.sql` and
`supabase/ci/verify-meeting-host-tools.sql`.

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

   Also apply `supabase/migrations/176_meeting_host_tools.sql` (same
   kind of role). Without it the room works, but locking, recording and
   shared notes are unavailable and say so.

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
- **Admins** are judged by `profiles.account_role`, never the legacy
  `role` column, which anyone may write on their own row.
- **Creates:** a team leader, admin or owner, who becomes the host
  (migration 111; the API answers 403 "Only team leaders and admins can
  create meetings" below that). Agents and viewers only attend: the
  meetings they are invited to and the ones open to the workspace. The
  _New meeting_ buttons on /meetings and the calendar are hidden for them.
- **Bank guests:** never. They see and write nothing here, and the API
  answers 403 "Video meetings are for staff only".

An invitee must be a live, non-guest member of the meeting's workspace.
Inviting someone other than yourself rings their bell
(`meeting_invite`, `meta.meeting_id`). A meeting has at most 100
invitees.

## The meetings page

- **Start now** opens an instant meeting in one click. It is not open to
  the workspace: invite people from inside the room.
- The page lists **Happening now**, **Coming up** (with a **Next up**
  countdown) and a **Past** tab. You can also join by pasting a link.
- Instant meetings close themselves after 10 minutes with nobody in them
  (`src/lib/meetings/lapse.ts`, run by the automations cron every 5
  minutes).

## The room and the floating window

The room is a page. The call itself belongs to the dashboard shell
(`MeetingSessionProvider`, `src/components/meetings/session/*`, with pure
logic in `src/lib/meetings/session/*`), so moving between dashboard pages
does not drop it. A full reload or closing the tab does leave the call:
the browser asks first, and a **Rejoin** card offers the way back for two
hours. A tab holds one meeting at a time.

**Room.** It is dark in both themes and responds to its own width. The
top bar shows status chips (REC, Locked). A dock holds the controls, and
a side panel has People, Chat and Notes tabs.

- Layouts: Gallery, Speaker and Focus. A two-person call shows the other
  person large with yourself in a corner. **Hide self view** is available.
- Shortcuts: `M` mic, `V` camera, `S` share, `H` hand, `C` chat, `P`
  people, `N` notes, `F` fullscreen, `?` help. Hold `Space` to talk.
- Fullscreen uses the whole page (`document.documentElement`), because
  fullscreening one element hides every menu and dialog.
- Whoever is speaking gets a highlight. Levels come from the browser's
  `inbound-rtp.audioLevel` statistics: Cloudflare's SFU does not
  negotiate the audio-level header, so the per-source level the browser
  would otherwise offer is empty.

**On any other page** a floating window shows the call
(`meeting-float.tsx`, `float-stage.tsx`, `float-controls.tsx`). Drag it,
resize from the corners and edges, minimise it to a pill, and
double-click to go back to the room. On a phone it is a bar. It shows
whoever is speaking large with a green ring; when you speak it stays on
the last other speaker. Its position and size are kept in the browser.

**Pop out** (Chrome and Edge, Document Picture-in-Picture) shows the same
view in an always-on-top window that follows you to other tabs and apps.
Other browsers keep the plain video picture-in-picture. Chrome may open
the pop-out by itself when you switch tabs; that is not guaranteed.

## Host tools

In the **People** panel:

- **Mute everyone.** People can unmute themselves.
- **Lower all hands.** Raised hands are a numbered queue.
- **Lock meeting.** Nobody new joins, except managers and people who
  dropped out within the last 5 minutes. A refused join answers 423
  `meeting_locked`.
- **Invite people.** The organiser only, which is the database's
  host-only rule for invitees.

## Background effects

Blur, colour backdrops or your own image, chosen in the lobby, in the
room's More menu or in Settings. They use MediaPipe selfie segmentation,
which loads only when someone picks an effect. The wasm files are copied
to `public/meeting-effects/wasm` by `scripts/copy-meeting-effects.mjs`
(run by `prebuild` and `predev`); the model file is committed.

- **Fails closed.** If the effect cannot run, the camera turns off and
  the person is told. The unprocessed camera is never sent.
- A slow machine first drops to 15 frames per second, then reuses the
  mask for three frames, and gives up only after 10 seconds over budget.
- MediaPipe's usage logging to `odml.pa.googleapis.com` is blocked
  (`src/lib/meetings/effects/block-logging.ts`).
- An uploaded image stays in that browser.

## Recording

A host records to their own computer. Nothing is uploaded to the
server or to Cloudflare.

- **Flag first.** The meeting is marked as recording before recording
  starts. If the server cannot set the mark, nothing is recorded.
- **Consent.** Everyone in the meeting gets a toast and a tone, on every
  page, and a REC chip shows in the room. The lobby warns before
  joining a meeting that is being recorded.
- **Reconnects.** A reconnect keeps the mark (the leave carries
  `reconnecting: true`). A real leave by the recorder clears it.
- **Stops** when the recorder leaves, is removed, the meeting ends, or
  the mark is cleared.
- Viewers stop seeing a stale mark 90 seconds after the recorder
  disappears.
- **A crashed recorder.** Nothing can clear the mark of a browser that died,
  so the room stops showing it once the recorder has been gone for 90 seconds
  and Record comes back. Starting then replaces the old mark. If the first
  recorder was only cut off, it stops by itself when it sees the new one.
- **Limit.** The file is WebM, and it is only complete once recording stops.
  A browser crash, or closing the tab while recording, can lose it: stop
  recording first. The browser asks before the tab closes.

## Notes

Each meeting has one set of shared minutes (`meeting_notes`, written by
`meeting_save_notes`, migration 176). A save is compare-and-set on a
version, so two people editing never lose each other's text: a stale save
is refused and the editor merges. Hosts can finish the notes after the
meeting ends. Read and write through `GET`/`PUT /api/meetings/[id]/notes`.

## After the meeting

The meeting page shows the duration, an attendance report with CSV
export, the notes, the chat, and who was invited but did not join.
Attendance merges a person's rejoined seats into one line. It is read
from `GET /api/meetings/[id]/attendance`.

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
| `POST /api/meetings/[id]/moderate`             | Mute, lower a hand or remove someone; `mute_all`, `lower_all_hands`    |
| `POST /api/meetings/[id]/lock`                 | Lock or unlock the meeting (manager)                                   |
| `POST /api/meetings/[id]/recording`            | Set or clear the recording mark                                        |
| `POST /api/meetings/[id]/invite`               | Add invitees from the room (organiser only)                            |
| `GET /api/meetings/[id]/attendance`            | Attendance report, rejoined seats merged                               |
| `GET`/`PUT /api/meetings/[id]/notes`           | Read or save the shared notes (compare-and-set)                        |

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
  (before any Cloudflare session is made). Since migration 112 the
  removal also hides the meeting from them, open or invited
  (`meeting_row_visible`): they no longer read the meeting, its seats or
  its chat (realtime included), it leaves their calendar, no meeting
  reminder rings for them, and their chat and reactions are refused as
  for anyone who cannot see the meeting. `{ target: userId, action: 'readmit' }` (the person's
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
