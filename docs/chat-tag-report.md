# Chat tag report

`/reports/tags` (Reports → Chat tags) counts the workspace's chats by
chat tag: how many sit on each main tag and sub-tag now, split by agent,
by number and by lead source, and how many arrived at each tag in a
period. SQL: migration 255 (`chat_tag_report`, `chat_tag_history`,
`report_access`). The Reports landing at `/reports` lists the reports a
person may open.

## Who opens it

- **The owner, always.** Admins have no standing access: the report is
  granted per person.
- **People the owner ticks.** At the bottom of the report the owner sees
  "Who can see this report": every live staff member of the workspace
  (not owners, not bank guests) with a checkbox. Saving makes the grant
  list exactly the ticked set (`report_access_set`; at most 500 people).
- **A grantee sees workspace-wide counts**, including chats they could
  not open in the inbox. The owner decided access by person, not by role,
  so the report does not narrow to the grantee's own chats. They never
  see a chat's contents, a customer's name or a customer's number.
- **A grant counts only while the person is live staff** of the
  workspace. Deactivating them, removing them from the workspace or
  their becoming a bank guest ends their access at once. Since migration
  330 deactivating someone keeps their grant (it opens nothing while
  they are deactivated, and the owner's list leaves it alone), so
  reactivating them restores exactly the access they had. Removing
  someone from the workspace deletes their grant rows there (256), so
  re-adding them never brings access back: the owner grants it again.
- Grants belong to one workspace. The check uses the caller's active
  workspace, like every other screen.
- The page, its API and the SQL all refuse anyone else
  (`NOT_ALLOWED`, HTTP 403). The API is
  `GET /api/reports/tags` and `GET /api/reports/tags/export`; the
  access list, `GET` and `PUT /api/reports/access?report=chat_tags`,
  is the owner's alone.

## What it counts

- **Counts only.** Tag names and colours, agent names and the workspace's
  own number labels; never message text, customer names or customer
  phone numbers. A number with no label is shown as "Unnamed number
  ending NN" (its last two digits), never its phone number (256).
- **Company chats only.** Personal-number chats (migration 191) are left
  out.
- **Now** is every company chat that carries a main tag at the moment the
  report runs. A main tag's total is the sum over its sub-tags, chats with
  no sub-tag included.
- **Movement in the period** counts the chats that arrived at each main
  tag inside the period: a change of main tag, once per chat however
  often it moved away and back (261). Each arrival is shown under the
  sub-tag the chat held at its last change at that tag, so the sub-tag
  rows add up to the tag's arrivals. Moving only the sub-tag
  (Interested · ADCB to Interested · HSBC) is not an arrival. The daily
  chart counts main-tag arrivals per day.
- **Nothing before the tag log began** (the day 255 was applied; the
  screen says the date). Before 255 the app kept only each chat's current
  tag, never when it was set, so earlier periods are empty and there is
  no backfill: any date for them would be invented.
- **Days are in the account's time zone** (the one saved in Team activity
  settings, else the viewer's, else UTC), so "Today" and the daily chart
  agree with the rest of the app. Periods: today, yesterday, the last 7,
  30 or 90 days.

## The tag log

Movement comes from `chat_tag_history`, which starts empty when migration
255 is applied. The page says "Movement is counted from <date>": nothing
before that day can be reconstructed.

- A trigger on `conversations` writes one row whenever a chat's main tag
  or sub-tag ends up different (a person in the inbox, an automation, a
  flow, auto-tagging alike). It holds ids and a time only.
- The trigger **never fails the tag write**: any error becomes a database
  WARNING and the tag change goes through unlogged.
- The log is **append-only**: no client can read or write it, and updates
  and deletes are refused. Its rows are deleted only with their chat
  (deleting a conversation deletes its log).

## CSV

**Download CSV** exports the same period: one row per figure, with the
columns Section, Main tag, Sub-tag, Breakdown, Day and Chats. Every cell
is quoted, and a value a spreadsheet would read as a formula gets a
leading apostrophe (`src/lib/csv/build.ts`). The file is never cached.

## Privacy

`chat_tag_history` and its meta row hold no personal data (ids and
times); `report_access` is staff data. All three are listed as not
personal in the PDPL data map (`src/lib/privacy/data-map.ts`).
