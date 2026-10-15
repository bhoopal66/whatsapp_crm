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

Without the two variables meetings can still be scheduled, edited and
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
- **Edits, cancels, ends:** the host, or an owner/admin.
- **Creates:** any staff member (viewer and up), who becomes the host.
- **Bank guests:** never. They see and write nothing here, and the API
  answers 403.

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
404; a failed database read answers **503 `temporarily_unavailable`**
(on every meeting route), so a blip never reads as "you left". Joining again (another tab, a reload) closes the
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

## Network and browser requirements

- **STUN only** (`stun.cloudflare.com:3478`). Very strict corporate
  networks, or any that block UDP, may fail to connect until a TURN
  server is added.
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
| `PATCH /api/meetings/[id]`                     | Edit; replaces the invitee list (host/admin, scheduled only)           |
| `DELETE /api/meetings/[id]`                    | Cancel (host/admin)                                                    |
| `POST /api/meetings/[id]/join`                 | Open a seat: `{ participantId, sessionId, iceServers }` (503 if unset) |
| `POST /api/meetings/[id]/heartbeat`            | `{ participantId, audioMuted, videoOff }`; keeps the seat present      |
| `POST /api/meetings/[id]/leave`                | Close the seat (idempotent)                                            |
| `POST /api/meetings/[id]/end`                  | End for everyone (host/admin)                                          |
| `POST /api/meetings/[id]/sfu/tracks`           | Publish or pull tracks (503 if unset)                                  |
| `PUT /api/meetings/[id]/sfu/renegotiate`       | SDP renegotiation (503 if unset)                                       |
| `PUT /api/meetings/[id]/sfu/tracks/close`      | Close tracks (503 if unset)                                            |

A Cloudflare failure is answered 502 (refused) or 504 (no answer);
Cloudflare's own status is never passed through.
