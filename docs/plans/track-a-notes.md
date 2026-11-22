# Track A notes: the inbox and the message box

Branch `claude/track-a-chats`, from `772a1d5`. This file holds what the
coordinator needs to merge: the CHANGELOG entry, the CLAUDE.md
paragraphs, the defaults chosen, the merge needs and the gate results.

## CHANGELOG entry

<!-- TRACK_A_CHANGELOG -->
- **Inbox list rows.** The message preview has its own full-width line.
  Chat tags moved to the holder line: a compact main tag, and a short
  bank sub-tag with the full "main · sub" name in a tooltip. An
  unassigned chat reads "Unassigned" (muted) instead of the owner's name
  in amber, with a small Assign menu for people allowed to assign. The
  contact panel is hidden while no chat is open.
- **Browser tab and alerts.** The tab title shows the unread chat count
  and the page name ("(3) Inbox — Taamul Connect") and stands aside while
  a reminder flashes. Settings → Notifications has an optional sound for
  new customer messages (off by default, saved per person in this
  browser). The "Turn on notifications" banner appears only when push is
  set up on the server, never for bank guests or browsers already
  subscribed, and "Not now" is remembered per person.
- **Share with bank.** The coordinator share button is labelled "Share
  with bank", opens with the bank already selected when the chat's
  sub-tag names one of the account's banks, and closes with a toast once
  shared.
- **WhatsApp-like composer.** The text box takes most of the width on a
  phone. Attach and AI sit inside the box; the mic records a voice note
  and turns into Send once you type. Templates, quick replies,
  interactive messages and Translate to Arabic are in one labelled
  **More** menu.
- **Meta 24-hour window.** On chats that reply from the Meta (Cloud API)
  number, a closed service window shows a banner ("Customer last wrote
  26 h ago. WhatsApp only allows a template now.") with **Send
  template**, and free text and attachments are disabled (templates
  still work). In the last 2 hours the chat header counts down the time
  left. Whapi, OpenWA and personal chats are unchanged.
- **"/" quick replies.** Type `/` at the start of a message to pick a
  quick reply: filter by name or text, ↑/↓ and Enter or Tab to insert,
  Esc to close. The quick-reply picker has a search box.

- **In-chat notes and @mentions.** In a chat, agents and up can switch
  the composer from Reply to Note and leave a note only the team sees
  ("Note · only your team sees this"). Notes appear in the thread by time
  with their author; authors can edit or delete their own. Typing "@"
  mentions a teammate who can see the chat and rings them a bell that
  opens the chat. Notes are never sent to the customer and never reach
  the AI, unread counts, webhooks or the public API.
- **Voice-note library.** Composer → More → "Voice notes": ready voice
  notes per subject (Welcome / introduction, Documents required, Missing
  documents reminder, Status updates, plus subjects staff add) and
  language (English, Hindi, Arabic, Urdu). Record one in the browser or
  have AI speak a script (OpenAI text-to-speech on the workspace's OpenAI
  key), fixed or personalised with {name} and {company} (spoken fresh for
  each send). New entries reach the whole workspace at once; the author
  or an admin deletes. Sends go through the normal send path as a voice
  message.
- **Notes and voice library hardening (same migrations, re-apply).**
  Editing a note updates the text quoted in its mention bells and unsent
  pushes; deleting a note removes them. A note mentions at most 20
  people. Library audio can no longer be overwritten or deleted through
  Storage by members (viewers included), and library entries can no
  longer be inserted directly through the database API: the server
  writes both after its own checks. Deleting a library entry keeps its
  audio while any sent message still uses it. Operator guides:
  `docs/chat-notes.md`, `docs/voice-library.md`.
- **Meta window, every path.** With the window closed, Enter, the "/"
  list and a restored attachment or voice note are refused too, not only
  the Send button.
- **Migration required:** apply `supabase/migrations/241_conversation_notes.sql`
  (after 229) and `supabase/migrations/242_voice_note_library.sql`, in
  order, before the build.

## CLAUDE.md paragraphs

<!-- TRACK_A_CLAUDEMD -->
**Inbox rows (`lib/inbox/row-layout.ts`).** The preview owns its line;
tags and the holder share the third line (`RowChatTags`, compact sub-tag
via `compactSubTagLabel`, full name in the tooltip). A row's Assign is a
sibling of the row `<button>` (like Handled), offered by
`rowOffersAssign` from the header's `assignableMembers`, and confirmed
before `assignConversation`. The contact sidebar renders only with a
chat open.

**Tab title and alerts (`lib/tab-alerts/*`).** `useUnreadChats` is
mounted once, in `UnreadChatsProvider` (dashboard shell); read it with
`useSharedUnreadChats()`, because a second call opens a second channel on
the same topic. `TabTitle` writes "(N) <page> — Taamul Connect" through
`tabTitle` (`title-owner.ts`), never `document.title` directly. The
reminder alarm's flash goes through the same object
(`beginFlash`/`flashWrite`/`endFlash`), and the unread title stands down
while it runs. An observer on `<head>` puts the title back after Next's
metadata resets it. The new-message sound comes from `onUnreadRise` (a
rise in `unread_count` happens only on an incoming customer message). It
is off by default and stored in localStorage per person
(`messageSoundKey`), with no server preference. The push banner's "Not
now" is per person too (`pushPromptDismissKey`).

**Composer menu and "/" quick replies.** The inbox composer row is More
(+) | text box with attach and AI inside | mic/Send. Every other composer
action is an entry in `moreMenuItems` in `message-composer.tsx`
(`ComposerMenuItem`, rendered by `composer-more-menu.tsx`): add an entry,
never another icon in the row. "/" at the start of the box opens the
quick-reply list; token detection and the matcher are pure, in
`lib/inbox/slash-quick-replies.ts`, and the picker's search uses the same
matcher. Quick replies have no shortcut column, so the shortcut is the
dashed title.

**Inbox service window (Meta only).** `lib/inbox/service-window.ts`
judges Meta's 24-hour window for the inbox with Compass's
`serviceWindowOpen` / `SERVICE_WINDOW_MS` (change one, change both).
`MessageThread` applies it only when `predictSendingNumber` predicts a
Meta number on a company chat. The last customer message comes from the
loaded page, else one latest-customer-message read. Unknown blocks
nothing. Closed shows `ServiceWindowBanner` and passes `freeTextBlocked`
to the composer, which disables the text box, attach, AI, quick replies,
interactive and translate but keeps the More menu open for Templates.
Under 2 h left, the header shows a countdown. Whapi, OpenWA and personal
chats never see it.

(Coordinators section) The share button (`coordinator-share-button.tsx`)
preselects the bank the chat's sub-tag names (`bankFromSubTag`: code or
name, trimmed, case-insensitive, unique match only, among banks someone
coordinates).

### In-chat notes (`lib/inbox/notes.ts`, migration 241)

Team notes inside a customer chat, in their own table
`conversation_notes` (061's reason: `messages` feed AI context, unread
counts, aggregates, webhooks and the public API; `notes-isolation.test.ts`
reads those paths' source to pin that none reads notes). Clients read and
write the table directly: SELECT is 061's `conversation_events_select`
shape (visible exactly when the chat is), INSERT needs agent and up who
see the chat, and a BEFORE trigger stamps `author_id`/`account_id`; only
the author updates (body only, column grant; a trigger freezes the rest
and stamps `edited_at`) or deletes. `mention_ids` is filtered on insert by
`conversation_note_user_can_see` (190's `can_view_conversation_for_user`
+ 191's personal rule; no coordinator shares) and rung once as
`chat_note_mention` (title + first 140 chars, like 087's bells), never on
edit; `conversation_note_mention_candidates` lists who may be mentioned.
The Reply/Note switch and `NoteComposer` render above the composer in
`message-thread.tsx`; the reply composer stays mounted (its draft
survives). The bell type lives in `notifications_type_check` (extended
from the live constraint), `hrefFor`, `PUSH_KINDS`, `kindGroup` and the
bell's icon map; `push_bell_url` does not list it yet. Realtime: INSERT
and UPDATE only (DELETE is not RLS-filtered). PDPL export/erase through
`privacy_extensions`. `verify-conversation-notes.sql`.

### Voice-note library (`lib/voice-library/*`, migration 242)

Staff voice notes per subject and language, sent from the composer's
More menu ("Voice notes", `components/inbox/voice-library-picker.tsx`)
through `onSendMedia`, i.e. the ordinary `/api/whatsapp/send` path, so
team-activity limits, opt-out and the Meta window apply. Built-in
subjects and the four languages (`en`, `hi`, `ar`, `ur`) are CHECKs in
242 and `constants.ts` (`constants.test.ts` reads the migration); staff
subjects are `voice_note_subjects` rows. RLS: members read (guests
nothing), agents and up insert as themselves, the author or an admin
deletes (`canDeleteAnyVoiceNote`), no UPDATE grant. Fixed audio lives at
`chat-media/account-<id>/voice-library/<entry id>.ogg` (CHECK-pinned;
outside 155's staged sweep) and is sent with an empty upload path so a
failed send never deletes it. A personalised entry stores only its
script; `POST /api/voice-library/entries/[id]/render` fills
{name}/{company} from the contact visible to the caller (`fillScript`),
speaks it and stores it under `staged/`. AI speech is OpenAI
`gpt-4o-mini-tts` with `opus` output (Ogg/Opus, no transcode) on the
assistant's OpenAI key, else its embeddings key (`resolveTtsKey`); every
call passes `assertAiTransfer` (purpose `voice_note_tts`). No
`ai_usage_log` row (TTS is not token-billed).
`verify-voice-note-library.sql`.

**Hardening (review fixes, same files).** 241: mentions capped at 20
(CHECK, BEFORE trigger, `NOTE_MAX_MENTIONS`, pinned by `notes.test.ts`);
`conversation_notes_sync_bells` rewrites the bells and their unsent
pushes (tag `bell:<id>`) on an edit and deletes them on a delete (087's
pattern). 242: `voice_note_entries` is written by the service role only
(`authenticated` has SELECT/DELETE; the POST inserts after `requireRole`
and the active account); a CHECK pins `storage_path` to
`account-<acct>/voice-library/<id>.ogg` and `media_url` to that path;
RESTRICTIVE storage policies take `chat-media/*/voice-library/` away from
every client write 023 allows; a delete removes the audio (service role)
only when `voice_library_audio_in_use` finds no message of the account
pointing at it (URL path compared as 155 does). With the Meta window
closed the composer's `handleSend` and `sendDraft` refuse too (Enter,
restored attachments), not only the Send button. Note mode waits while
the reply composer has a recording or staged attachment
(`onBusyChange`), since the hidden composer would keep the mic live.

## Defaults chosen

<!-- TRACK_A_DEFAULTS -->
- Inbox rows: sub-tag labels are at most 8 characters (3+ words →
  initials, "Abu Dhabi Commercial Bank" → "ADCB"; 2 words → first word if
  it fits; else cut with "…"). Rows offer Assign only on unassigned
  company chats, never on personal chats, HR rows or share-only views;
  no reassign/unassign from the row.
- Tab title counts the **Inbox** unread number (not Team inbox), capped
  at "99+", omitted at 0.
- Message sound: off; per person in localStorage (no migration); at most
  once per 3 s across tabs (Web Lock); silent while a meeting or call is
  live, for bot-answered campaign chats, for others' personal chats, and
  when the tab is focused on that same chat; two notes 880 Hz → 1175 Hz,
  ~0.25 s, gain 0.2.
- Push prompt: reused the existing `PushPrompt`; shows only with a server
  VAPID key, permission "default", not subscribed, not a bank guest, not
  dismissed by this person (the older browser-wide dismissal still
  counts).
- Share with bank: code match beats name match; an ambiguous name picks
  nothing; never overrides a bank the agent already picked. Label shows
  from the `@md/thread` width, icon + tooltip below.
- Meta window: length is Compass's `SERVICE_WINDOW_MS` (23 h 50 m, 10
  minutes stricter than Meta, matching the send path). Unknown or a
  failed read blocks nothing. A customer who never wrote counts as
  closed (templates still work). "N h ago" up to 48 h, then days.
  Countdown under 2 h, minutes rounded up.
- "/" quick replies: at most 8 matches; shortcut = title lower-cased and
  dashed; re-reads `/api/quick-replies` each time it opens; ranking:
  shortcut prefix, title word, title anywhere, body.

- Notes: every chat opens on Reply; Note mode is per chat; only agent
  and up see the switch; max 4000 characters; text only; mention list
  shows 6 matches (start of name or of any word); Enter saves,
  Shift+Enter new line; `chat_note_mention` is a push preference under
  "Messages", on by default (it is a bell for a person, not an automatic
  behaviour).
- Voice library: AI speech uses the workspace's OpenAI assistant key,
  else its OpenAI embeddings key, and needs the assistant's master switch
  on; otherwise the AI option is disabled with the reason shown. Voice
  `coral`; 20 speech calls/min per person, 60 per account; subject 60
  characters, title 80, script 1,500, audio 16 MB, recording 5 minutes. A
  fixed script may not contain {name}/{company}; a personalised one must
  use one. Missing name is left out ("Hello {name}, …" → "Hello, …"),
  missing company becomes "your company" in the note's language. The
  menu item is disabled while the Meta window is closed. Personalised
  audio is stored under `staged/` (swept if never sent).

## Merge needs

<!-- TRACK_A_MERGE_NEEDS -->
- `dashboard-shell.tsx` now wraps the shell in `<UnreadChatsProvider>`
  (inside `<NotificationsProvider>`) and mounts `<TabTitle />` next to
  `<PresenceHeartbeat />`. Any other track that calls `useUnreadChats`
  should switch to `useSharedUnreadChats()` from
  `@/components/layout/unread-chats-provider` (a second call opens a
  second realtime channel on the same topic).
- `message-composer.tsx` was restructured (More menu). Another track
  adding an icon to the composer row should add a `moreMenuItems` entry
  instead.
- `messages/*.json`: new top-level namespaces `InboxRows` (top of file,
  before `LoginPage`), `ComposerMenu` (before `ContactSearch`),
  `ServiceWindow` (before `Sidebar`), `TabAlerts` (before
  `TeamActivity`); `Coordinators.share.action` text changed to "Share
  with bank" and gained `buttonTitle`, `fromSubTag`.

- **`push_bell_url`** (owned by 109/133/173) needs `chat_note_mention`
  added to the WHEN list that returns the chat URL (`/inbox?c=…`). Until
  then a *push* for this bell opens `/notifications`; the in-app bell
  already opens the chat through `hrefFor`.
- `src/lib/push/rules.test.ts` asserted no `chat_*` type is a push
  preference; `chat_note_mention` is exempted (a customer-chat bell, not
  a team-chat type).
- `messages/*.json` also gained `ChatNotes` (before `InboxRows`),
  `VoiceLibrary` (before `Workspaces`) and
  `PushNotifications.kinds.chat_note_mention`.
- `.github/workflows/migrations.yml`: two steps at the end (241's then
  242's verify). Other tracks appending there will conflict trivially.

- Voice library: when the in-use check cannot run, the audio is kept
  (a leftover file is only space). A send in flight at the moment of a
  delete can miss the check (small, accepted window).

## Gate results

<!-- TRACK_A_GATES -->
Final state `ba2365c` + this notes commit (all eight items plus review
fixes), run 2026-11-22 ~09:30 UTC:

- `npm run lint`: 0 errors, 31 warnings (pre-existing count was ~32).
- `npm run typecheck`: clean.
- `npm test`: 1096 files, 15,636 tests passed.
- `npm run build` with the CI dummy env (`NEXT_PUBLIC_SUPABASE_URL`,
  `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `ENCRYPTION_KEY` from `ci.yml`):
  success.
- Migration replay as `migrations.yml` does it: clean
  `supabase/postgres:17.6.1.054` (storage schema migrated by
  `storage-api`, as the CLI does), `classic-grants.sql`, every migration
  001–242 in order through `psql -v ON_ERROR_STOP=1`, then all 127 verify
  files in workflow order: 0 failures. 241 and 242 re-applied a second
  time cleanly (also over their earlier drafts) and their verify files
  passed again.
- Two independent reviews (SQL/routes, merged UI) ran after the first
  push; every confirmed finding was fixed except the `push_bell_url`
  merge need above.

Not done / known limits:
- Nothing was tried in a real browser or at 375px on a device; layouts
  were checked in code and unit tests only. No real OpenAI speech call was
  made.
- Notes: another person's delete disappears for others only on the next
  open of the chat; a coordinator who sees a chat only through a share can
  read and write notes but is not offered in, or rung by, @mentions.
- Voice library: no `ai_usage_log` row for speech (its `mode` CHECK, the
  TS type and the usage route would have to change together); spend is
  visible in `ai_transfer_log` under purpose `voice_note_tts`.
- Inbox rows: the `ChatTagPill` `sm` size and the "Similar"/pin/Handled
  chips still use 10–11px text (pre-existing, out of scope).
