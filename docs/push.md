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
   app. The site must be served over https.

**iPhone and iPad** support web push only for a site added to the Home
Screen (iOS / iPadOS 16.4 or later): open the CRM in Safari, Share →
**Add to Home Screen**, open it from that icon, then switch
notifications on there. A Safari tab never receives pushes.

## Who gets what

- **WhatsApp messages.** Each inbound customer message goes to the
  chat's assignee, if they can see the chat; with no such assignee, to
  the people allocated to the number it arrived on who can see the
  chat; with none of those, to the workspace's owners and admins. A
  replayed webhook delivery never pushes twice.
- **Team chat.** Every message in a channel you belong to, except your
  own. A channel you muted pushes only when you are @mentioned. Deal
  room Team notes are never pushed to bank guests (they cannot read
  them).
- **Bell notifications.** Every notification in the bell, except the
  team-chat ones (`chat_*`), which the team-chat push above already
  covers.

Each person can switch push off entirely or per kind, across all their
workspaces.

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
  at once; a device that fails 10 times in a row is removed too.

## Deleted and edited team-chat messages (migration 112)

A queued `chat_message` row records its message (`push_outbox.message_id`).
At claim time a row whose message has since been deleted, erased or edited
is skipped (`skipped: access revoked`), so the old words never reach a lock
screen. Rows queued before 112 carry no message id and are judged as before.
