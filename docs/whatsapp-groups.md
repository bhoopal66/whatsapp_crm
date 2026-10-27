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

### Deleting a group you left

Once your number has left a group (Leave, or a Sync that no longer
finds it), an owner or admin can delete it from the CRM: **Delete from
CRM** at the bottom of the group's info panel or in its ⋮ menu, or
**Delete all left groups** above the list while the Left filter is on.
Only groups the number has left can be deleted. Deleting removes the
group, its members list, managers, invite link and saved messages from
the CRM for good; nothing happens on WhatsApp (the number is already
out), and a later Sync does not bring the group back.

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

## Limits

Only the group's number sends; staff cannot send as themselves. Text
only for now. A number that left or was removed shows the group as
read-only.
