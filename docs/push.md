# Web push notifications

The CRM can send notifications to a person's phone or desktop through
the browser's web push service, so a new WhatsApp message, a team-chat
message or a bell notification reaches them with the tab closed.
Migration `109_push.sql` stores the devices, preferences and the outbox;
the server delivers from the outbox.

## Setup

1. Apply `supabase/migrations/109_push.sql` (as a superuser or BYPASSRLS
   role).
2. Generate a VAPID key pair once per install:

   ```bash
   npx web-push generate-vapid-keys
   ```

3. Set three environment variables on the server:

   | variable            | value                                                                                                                         |
   | ------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
   | `VAPID_PUBLIC_KEY`  | the public key printed above                                                                                                  |
   | `VAPID_PRIVATE_KEY` | the private key printed above. **Server only**: never give it a `NEXT_PUBLIC_` name, or it is inlined into the browser bundle |
   | `VAPID_SUBJECT`     | a contact for the push services, e.g. `https://your-domain` or `mailto:ops@your-domain`                                       |

   They are read at request time, so a restart is enough (no rebuild).
   With any of the three unset push is off: the `/api/push/*` routes
   answer 503 `push_not_configured` and nothing is sent.

   Keep the pair: generating a new one invalidates every device already
   subscribed, and each person has to switch notifications on again.

4. Each person switches notifications on for their own device in the
   app. The site must be served over https. Only endpoints of the
   browsers' own push services (Google, Mozilla, Microsoft, Apple) are
   accepted; anything else is refused when subscribing and never sent to.

**iPhone and iPad** support web push only for a site added to the Home
Screen (iOS / iPadOS 16.4 or later): open the CRM in Safari, Share →
**Add to Home Screen**, open it from that icon, then switch
notifications on there. A Safari tab never receives pushes.

## Who gets what

- **WhatsApp messages.** Each inbound customer message goes to the
  chat's assignee, if they can see the chat; with no such assignee, to
  the people allocated to the number it arrived on who can see the
  chat; with none of those, to the workspace's owners and admins. A
  replayed webhook delivery never pushes twice. Two kinds of message
  ring nobody: one on a personal number (the person's own phone
  already alerts them), and one more than 5 minutes old when it
  arrives (a backlog a gateway delivers on reconnecting).
- **Buzzing.** A chat's notification is replaced by its next message
  and buzzes again at most once a minute; in between it updates
  silently (`public/sw.js`). Reminder alarms always buzz.
- **Team chat.** Every message in a channel you belong to, except your
  own. A channel you muted pushes only when you are @mentioned. Deal
  room Team notes are never pushed to bank guests (they cannot read
  them).
- **Bell notifications.** Every notification in the bell, except the
  team-chat ones (`chat_*`), which the team-chat push above already
  covers.

Each person can switch push off entirely or per kind, across all their
workspaces.

## Reminder pushes

- `task_due`, `meeting_reminder` and `event_reminder` pushes stay on
  screen until dismissed (`requireInteraction`) and vibrate in an alarm
  pattern (`public/sw.js`).
- `task_due` is high urgency, but quiet hours still hold it (unlike
  meeting and event reminders), because the phone system's missed-call
  tasks ring it too and must not wake people at night.
- Every `task_due` push of one task is tagged `task:<task id>`
  (`push_on_notification`, migration 197). The due-now push replaces the
  15-minute heads-up on the device, and a snoozed ring replaces the last
  one. Other bells keep `bell:<row id>`.
- The page shows its own alarm card for the same bells; see
  `docs/calendar.md`.

## Quiet hours

A person may set quiet hours (a window in their time zone, which may
cross midnight). Inside the window only meeting and event reminders are
delivered, because they are worthless late. Everything else is held,
not dropped, and delivered when the window ends if it is then less than
12 hours old; anything older is skipped.

## Delivery

- In a production server (`NODE_ENV=production`) with VAPID keys set,
  `src/instrumentation.ts` starts a delivery loop once per process: a
  pass every 3 s while there is work, every 10 s when idle. A failing
  pass is logged and the loop carries on.
- The automations cron (`GET /api/automations/cron`) also runs one
  delivery pass at most once a minute, then `push_purge()` to trim old
  outbox rows. That is the fallback for a dev server or an install whose
  loop is not running. The outbox claim is a lease, so the two never
  send the same row twice.
- A device the push service reports gone (HTTP 404 or 410) is removed
  at once. A device the service refuses for another reason of its own
  (a 4xx other than 401, 403 and 429) is removed after 10 passes in a
  row. No connection, our own keys, rate limiting and 5xx never count:
  an outage costs nobody their device.
- `task_due`, `meeting_reminder` and `event_reminder` are kept by the
  push service for 30 minutes, team chat and WhatsApp for a day, the
  rest for three days.

## Whose device it is

A subscription belongs to the browser, not to the login. The browser
keeps the id of the person who turned push on there (localStorage
`taamul.push-enabled-by`, nothing else; removed on switching off and on
sign-out). Once per page load and person the dashboard settles it
(`lib/push/repair.ts`): that person's device is registered again, which
restores a device the server lost (or subscribes again one released when
their session ended); anyone else's is unsubscribed in the browser. A
device turned on before this existed is recognised by its own row. An
error changes nothing. A session that ends or changes person in an open
tab also releases the browser (`releasePushOnSessionChange`).

## Deleted and edited team-chat messages (migration 112)

A queued `chat_message` row records its message (`push_outbox.message_id`).
At claim time a row whose message has since been deleted, erased or edited
is skipped (`skipped: access revoked`), so the old words never reach a lock
screen. Rows queued before 112 carry no message id and are judged as before.
