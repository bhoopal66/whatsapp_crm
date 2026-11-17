# WhatsApp groups

The **Groups** screen (`/groups`) lets staff create and work WhatsApp
groups from a connected number. It is the operator and user contract for
migration 114 (`lib/groups/*`).

## Whapi numbers only

Groups run on a Whapi channel. A Meta Cloud API number cannot host them
(its own deal-room groups are a separate feature, see
`meta-cloud-api.md`). The number has to be connected and, for most
actions, an admin of the group.

## Who can do what

- **See:** owners and admins see every group; other people see the
  groups they created or manage; team leaders also see their team's.
- **Manage** (members, invites, settings, join requests): owners, admins,
  the group's creator and the group's managers.
- **Managers:** the Managers tab lists them. Only an owner, an admin or
  the creator can change the set; the creator always stays a manager.
- **Create:** agents and up, from a number they are allowed to use.

## What the screen does

Create a group (name, description, picture, first members, co-managers),
chat in it, add and remove people, promote and demote admins, change the
group's settings, share the invite link, and approve or reject join
requests. **Refresh** re-reads the group from WhatsApp.

- **Picture:** JPEG or PNG, up to 2 MB.
- **Chat:** at most 20 sends a minute per group, failures included.
- **Join requests:** appear on the Requests tab when the group needs
  admin approval. Each new request rings a bell for the group's managers
  and admins; the bell opens the tab.

### Adding people who opted out

Creating a group or adding members skips anyone who opted out or is
marked do-not-contact, and lists them as left out. An owner or admin
sees **Add anyway** under that list (after creating a group, or in the
Add members dialog) and can add those people regardless. Anyone else
cannot: the server answers 403 `not_allowed`. The create step itself
still skips them. Each override is logged on the server with a count
only, no names or numbers.

### Deleting a group

An owner or admin can delete any group on the Groups page, permanently:
**Delete group** at the bottom of the group's info panel or in its ⋮
menu, or **Delete all left groups** above the list while the Left filter
is on.

- **Still in the group:** your number leaves it on WhatsApp first, and
  members see that. If the leave fails (a disconnected number, WhatsApp
  not answering), nothing is deleted and the reason is shown. If WhatsApp
  says the group is already gone, the delete carries on only once the
  number answers a health check as connected, because a wrong token gets
  the same answer. One call handles at most 10 such groups.
- **Already left:** nothing happens on WhatsApp.
- Either way the group, its members list, managers, invite link and saved
  messages are removed from the CRM. This cannot be undone: a record of
  the deleted group is kept per number, so neither Sync nor a webhook
  brings it back, even if someone adds the number to it again.
- A **submission group** cannot be deleted here. The option is hidden and
  the server refuses it.

**Sync skips submission groups.** It lists every group on the number, so
it used to copy them onto this page. A copy made before this change
stays, is not marked left by Sync and has no leave or delete option. The
server refuses both, so a bookmark or an old bell can't take the number
out of a live submission group.

## Submission groups on this page

Active submission groups are listed here with the other groups, marked
**Case**, in the same order and with their unread count.

- **Who sees them:** only the people who can already read that group on
  the Submission groups page (its access list, its bank's coordinators,
  the agent's team leader, owners and admins), agents and up. Nothing
  here widens that.
- **Which ones:** only an active group that exists on WhatsApp. A case
  with no WhatsApp group is never listed, and an **ended** group stays
  on the Submission groups page, where reading it is audited.
- **They open here,** beside the list, with the same chat and details
  as on the Submission groups page.
- **They cannot be deleted.** No delete is offered, and **Delete all
  left groups** does not include them.
- A copy an older Sync made of a submission group no longer shows in
  the list, whether that group is active or ended.

The sidebar counts stay separate: **Groups** counts these rows out, and
**Submission groups** keeps its own count.

## Unread groups

The sidebar's **Groups** item shows how many groups have something new
for you (migration 146). Each person has their own read marker per
group; opening a group moves yours to now, and so does a message that
arrives while you have it open. Someone else reading a group does not
clear it for you.

The count is the groups you can see in the active workspace, minus
groups the number has left, that hold an **inbound** message that
arrived after your marker. Our own sends never count. A group you have
never opened counts only for an inbound message that arrived in the
**last 7 days**, so older history does not light up the day this ships
or the day you join. The count refreshes every minute, and at once when
you open a group.

"Arrived" is when the CRM received the message
(`whatsapp_group_messages.received_at`), not the time WhatsApp says it
was sent (`created_at`, which the chat shows). A message sent before you
opened the group but delivered after it (the phone was offline, the
gateway was catching up) still counts, and a sender whose clock runs
ahead does not re-light a group you just opened. Messages stored before
migration 146 count as arriving when they were sent.

## Anti-ban pacing

WhatsApp restricts numbers that add people in bulk. Adds are therefore
paced: **5 people per call, a 3 second pause between calls, at most 50
people per operation**. Anyone WhatsApp refuses to add directly (privacy
settings) gets the group's **invite link** sent to them 1:1 instead,
paced the same way. A failure that would repeat for everyone (number
disconnected, billing, not a group admin) stops the run on the first one.

## Consent

A contact who opted out is never added and never sent an invite link;
they are reported in the result instead. A group member who leaves does
not change their opt-out.

## What stays out of the CRM's other engines

A group's messages live in the group's own log. They never reach the
inbox, flows, automations, journeys, the AI or outbound webhooks, and
they do not count as customer conversations.

## Telling senders apart

Every sender in a group chat has a colour of their own, on the name and on
a stripe down the bubble's outer edge: each staff member who sends from the
CRM, and each phone number. In a WhatsApp group that includes the group's
own number, when someone sends from the phone. A hidden number (`@lid`)
counts as a number of its own. Automatic messages, and a message nothing
identifies, stay grey.

There are ten colours, and no two senders on screen share one until a chat
has more than ten. A person's colour comes from their id, so they usually
have the same one in every chat. It moves only to settle a clash with
someone else in that chat, and the same people always settle it the same
way, whoever wrote first. Only the messages on screen count: someone coming
into them or dropping out of them, for example when older messages are
loaded, can change the colour of a sender they clash with and, rarely, of
someone that sender then displaces. The colours are worked out in the
browser (`lib/groups/sender-colors.ts`): nothing is stored.

## Limits

Only the group's number sends; staff cannot send as themselves. Text
only for now. A number that left or was removed shows the group as
read-only.
