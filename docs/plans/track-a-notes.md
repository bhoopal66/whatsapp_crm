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

## Gate results

<!-- TRACK_A_GATES -->
