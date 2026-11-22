> Moved verbatim from `CLAUDE.md` (2026-11-22). Read this file before changing this area.

### Video meetings (`lib/meetings/*`, migrations 106, 176)

Staff-only video meetings on Cloudflare Realtime SFU, at `/meetings`.
`docs/meetings.md` is the contract.

- **Staff only.** `canUseMeetings` (viewer and up, never `bank_guest`) gates
  every route through `requireMeetingsUser`; the policies go through
  `current_account_id()`, which is NULL for a guest.
- **Who creates (111).** Team leader and up (`canCreateMeetings`, the
  meetings INSERT policy); agents and viewers only attend.
- **Who sees / manages.** `meeting_can_view`: owner/admin, the host, an invitee,
  or `open_to_workspace` — the last two not while a `meeting_removed_users` row
  names the caller (112: a removal hides the room, its chat and reminders). `meeting_can_manage`: owner/admin or the host. Both
  wrap the shared row checks `meeting_row_visible` / `meeting_row_manageable`,
  which the table policies call with their own columns (a STABLE function
  would not see the row an INSERT … RETURNING is writing).
- **Participants are service-role writes.** `meeting_participants` has no client
  write grant; the routes check `meeting_can_view` through the caller's RLS
  client first, then write on `supabaseAdmin()`.
- **The SFU secret is server-only.** `CLOUDFLARE_CALLS_APP_ID` / `_SECRET` are
  read at request time in `sfu.ts`; unset means meeting CRUD works and join and
  the `sfu/*` routes answer 503 `meetings_not_configured`. The browser only
  talks to `/api/meetings/[id]/sfu/*`.
- **One Cloudflare app serves every workspace**, so `sfu-rules.ts` confines a
  caller: local track names start `<participantId>:` + audio|video|screen, a
  pull must name the session of a *present* participant of the same meeting,
  `autoDiscover` is refused.
- **Presence is derived.** "Live" is not stored: heartbeat every 20 s
  (`HEARTBEAT_INTERVAL_MS`), present if not left and seen within 60 s
  (`PRESENCE_WINDOW_MS`); change both ends together.
- **Terminal statuses live in `meetings_guard`** (every writer): `ended` and
  `cancelled` never reopen, `ended_at` is trigger-owned, and entering either
  closes every open participant row. `account_id` and `host_user_id` are
  frozen.
- **Bell.** An invite inserts a `meeting_invite` notification
  (`meeting_invitees_notify`, not for yourself); 106 rewrites
  `notifications_type_check`, so a later type edits that list from 106.
- **Network.** STUN only (`MEETING_ICE_SERVERS`); `Permissions-Policy` and the
  CSP `connect-src` (`rtc.live.cloudflare.com`) carry the camera, microphone,
  display-capture and Cloudflare origins. `verify-meetings.sql`.
- **The session owns the call (meetings v3).** The room is a page, but the
  engine lives in the dashboard shell (`MeetingSessionProvider`,
  `components/meetings/session/*`, pure `lib/meetings/session/*`). No route
  or page may detach or tear down a live call; moving between pages must
  not leave it. One meeting per tab. Only one tile-size reporter feeds the
  engine at a time (the room, the float or the pop-out, never two).
- **Speaker levels come from `getStats`** (`inbound-rtp.audioLevel`).
  Cloudflare's SFU negotiates no ssrc-audio-level header, so
  `getSynchronizationSources()` carries no level. Don't go back to it.
- **Fullscreen is on `document.documentElement`**: element fullscreen hides
  every portal. The room root goes `fixed inset-0` while fullscreen. The
  room is dark in both themes (`data-mode="dark"` on the root and on
  portalled content).
- **Background effects fail closed** (`lib/meetings/effects`, MediaPipe,
  loaded only on pick). If the effect cannot run the camera turns off; the
  raw camera is never sent. Keep `sendable()` (may this track go out) apart
  from `outgoing()` (what goes out), both in `hooks/use-meeting-call.ts`. Wasm is copied by
  `scripts/copy-meeting-effects.mjs` (`prebuild`/`predev`); MediaPipe's
  logging is blocked (`block-logging.ts`).
- **Recording flag first.** A host records locally; nothing is uploaded.
  The recording flag is set on the server before recording starts, and a
  failure there means nothing is recorded. A reconnect leaves with
  `reconnecting: true` and keeps the flag; a real leave by the recorder
  clears it.
- **The lobby has no realtime channel.** It opens on joining, so the lobby
  re-reads the row every 5 s (`refreshLobby`). Quietly: notices wait for the
  room, so a lobby row that queued them would play them all on joining.
- **Pre-176 tolerance.** Without migration 176 the room still works; lock,
  recording and notes answer as unavailable and the UI says so. Keep that
  fallback when touching those routes. `verify-meeting-host-tools.sql`.
- **Instant meetings lapse** after 10 minutes empty
  (`lib/meetings/lapse.ts`, the automations cron).
- **Invite pop-up.** `InviteRinger` (`lib/meetings/invite-ring.ts`, pure)
  turns a realtime `meeting_invite` row into the shell's ringing card
  (`meeting-invite-card.tsx`): instant meetings (106's "Starting now"
  body, pinned by a test) and meetings someone is in, nothing else. The
  tone is laid on the audio clock up front and is finite, so a frozen tab
  can't ring on. Not now marks the row read, which is what closes the
  card on other tabs. A row of another workspace is never checked against
  `/api/meetings/[id]`: it would answer 404. Two Web Locks: tabs queue for
  an exclusive ring lock, never `ifAvailable` (a release is async, so a
  restart would lose to its own lock), and a meeting lives in one tab, so
  every tab in a call holds a shared busy lock a ring must get past. Only
  the ring lock is ever stolen, to cut off a ring already going: tabs
  stealing the busy lock from each other left a live call unprotected.
